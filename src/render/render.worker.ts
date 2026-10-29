// Renders the kept ranges into a new MP4: video is decoded and re-encoded
// (hardware accelerated where available), audio packets are copied as-is.

import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer';
import type { AudioTrack, MediaInfo } from '../engine/container';
import type { Range } from '../engine/silence';

export interface RenderJob {
  file: File;
  media: MediaInfo;
  keeps: Range[];
  bitrate: number;
  handle?: FileSystemFileHandle;
}

export type RenderMessage =
  | { type: 'progress'; done: number; fps: number }
  | { type: 'done'; buffer?: ArrayBuffer; elapsed: number; frames: number }
  | { type: 'error'; error: string };

const post = (m: RenderMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<RenderJob>) => {
  try {
    await render(e.data);
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.message ?? err) });
  }
};

/** Reads many small samples through large sequential block reads. */
class BlockReader {
  private start = 0;
  private buf = new Uint8Array(0);
  constructor(private file: File, private block = 32 * 1024 * 1024) {}
  async get(offset: number, size: number): Promise<Uint8Array> {
    if (offset < this.start || offset + size > this.start + this.buf.length) {
      this.start = offset;
      const end = Math.min(this.file.size, offset + Math.max(this.block, size));
      this.buf = new Uint8Array(await this.file.slice(offset, end).arrayBuffer());
    }
    return this.buf.subarray(offset - this.start, offset - this.start + size);
  }
}

function avcCodec(width: number, height: number, fps: number) {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  // H.264 levels by macroblocks per second
  const levels: [number, number][] = [
    [245760, 0x28], // 4.0
    [522240, 0x2a], // 4.2
    [589824, 0x32], // 5.0
    [983040, 0x33], // 5.1
    [2073600, 0x34], // 5.2
  ];
  const level = levels.find(([max]) => mbps <= max)?.[1] ?? 0x34;
  return `avc1.6400${level.toString(16)}`;
}

async function render(job: RenderJob) {
  const t0 = performance.now();
  const { file, media, keeps } = job;
  const video = media.video;
  if (!video?.codecString) throw new Error('This file has no video track that can be decoded.');
  const audio = media.audio.kind === 'compressed' ? media.audio : undefined;

  const width = video.width & ~1;
  const height = video.height & ~1;
  const fps = Math.round(video.fps * 1000) / 1000;

  const encConfig: VideoEncoderConfig = {
    codec: avcCodec(width, height, fps),
    width,
    height,
    bitrate: job.bitrate,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' },
  };
  if (!(await VideoEncoder.isConfigSupported(encConfig)).supported) {
    encConfig.hardwareAcceleration = 'no-preference';
    if (!(await VideoEncoder.isConfigSupported(encConfig)).supported) {
      throw new Error(`This browser cannot encode ${width}×${height} H.264 video.`);
    }
  }
  const decConfig: VideoDecoderConfig = {
    codec: video.codecString,
    description: video.description,
    codedWidth: video.width,
    codedHeight: video.height,
    hardwareAcceleration: 'prefer-hardware',
  };
  if (!(await VideoDecoder.isConfigSupported(decConfig)).supported) {
    decConfig.hardwareAcceleration = 'no-preference';
    if (!(await VideoDecoder.isConfigSupported(decConfig)).supported) {
      throw new Error(`This browser cannot decode this video (${video.codecString}).`);
    }
  }

  const writable = job.handle ? await job.handle.createWritable() : undefined;
  const target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget();
  const audioCodec = audio?.codec.startsWith('mp4a') ? 'aac' : audio?.codec === 'opus' ? 'opus' : undefined;
  const muxer = new Muxer({
    target,
    fastStart: false,
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: audioCodec ? { codec: audioCodec, numberOfChannels: audio!.channels, sampleRate: audio!.sampleRate } : undefined,
  });

  // Output start time of each kept range
  const outStart: number[] = [];
  let acc = 0;
  for (const [a, b] of keeps) {
    outStart.push(acc);
    acc += b - a;
  }
  const total = acc;

  if (audio && audioCodec) await copyAudio(file, audio, keeps, outStart, muxer);

  // ---- Video ----
  let failure: unknown;
  let frames = 0;
  let nextKey = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(encConfig);

  let keepIdx = 0;
  let lastProgress = 0;
  const frameDur = 1e6 / fps;
  let lastOutTs = -Infinity;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const t = frame.timestamp / 1e6;
        while (keepIdx < keeps.length && t >= keeps[keepIdx][1] - 1e-6) keepIdx++;
        if (keepIdx >= keeps.length || t < keeps[keepIdx][0] - 1e-6) return;
        const outTs = Math.round((t - keeps[keepIdx][0] + outStart[keepIdx]) * 1e6);
        if (outTs <= lastOutTs) return;
        lastOutTs = outTs;
        const out = new VideoFrame(frame, { timestamp: outTs, duration: frameDur });
        const key = outTs >= nextKey;
        if (key) nextKey = outTs + 2e6;
        encoder.encode(out, { keyFrame: key });
        out.close();
        frames++;
        const now = performance.now();
        if (now - lastProgress > 250) {
          lastProgress = now;
          post({ type: 'progress', done: Math.min(1, outTs / 1e6 / total), fps: frames / ((now - t0) / 1000) });
        }
      } finally {
        frame.close();
      }
    },
    error: (e) => (failure = e),
  });
  decoder.configure(decConfig);

  const ts = video.timescale;
  const n = video.sizes.length;
  const pts = new Float64Array(n);
  for (let i = 0; i < n; i++) pts[i] = (video.times[i] + video.cts[i]) / ts - video.startOffset;

  // For each kept range, decode from the keyframe before it to the keyframe after it.
  const keyIdx: number[] = [];
  for (let i = 0; i < n; i++) if (video.keyframes[i]) keyIdx.push(i);
  const gopFor = (t: number) => {
    // index into keyIdx of the last keyframe with pts <= t
    let lo = 0;
    let hi = keyIdx.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (pts[keyIdx[m]] <= t + 1e-6) {
        ans = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return ans;
  };

  const reader = new BlockReader(file);
  let pos = 0;
  for (const [a, b] of keeps) {
    const g0 = gopFor(a);
    const g1 = gopFor(b - 1e-6);
    const from = keyIdx[g0];
    const to = g1 + 1 < keyIdx.length ? keyIdx[g1 + 1] : n;
    let i = Math.max(pos, from);
    if (i >= to) continue;
    for (; i < to; i++) {
      const data = await reader.get(video.offsets[i], video.sizes[i]);
      decoder.decode(
        new EncodedVideoChunk({
          type: video.keyframes[i] ? 'key' : 'delta',
          timestamp: Math.round(pts[i] * 1e6),
          duration: Math.round((video.durations[i] / ts) * 1e6),
          data,
        }),
      );
      if (failure) throw failure;
      if (decoder.decodeQueueSize > 16 || encoder.encodeQueueSize > 16) {
        await waitFor(() => decoder.decodeQueueSize <= 8 && encoder.encodeQueueSize <= 8, decoder, encoder);
      }
    }
    pos = to;
  }
  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  if (writable) await writable.close();
  const elapsed = performance.now() - t0;
  if (target instanceof ArrayBufferTarget) post({ type: 'done', buffer: target.buffer, elapsed, frames }, [target.buffer]);
  else post({ type: 'done', elapsed, frames });
}

function waitFor(cond: () => boolean, ...codecs: (VideoDecoder | VideoEncoder)[]) {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (cond()) {
        for (const c of codecs) c.removeEventListener('dequeue', check);
        resolve();
      }
    };
    for (const c of codecs) c.addEventListener('dequeue', check);
    check();
  });
}

async function copyAudio(file: File, a: AudioTrack, keeps: Range[], outStart: number[], muxer: Muxer<ArrayBufferTarget | FileSystemWritableFileStreamTarget>) {
  const ts = a.timescale;
  const meta: EncodedAudioChunkMetadata = {
    decoderConfig: { codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description },
  };
  const reader = new BlockReader(file, 8 * 1024 * 1024);
  let k = 0;
  let prevEnd = 0;
  let first = true;
  const picked: { i: number; out: number }[] = [];
  for (let i = 0; i < a.sizes.length; i++) {
    const t = a.times[i] / ts - a.startOffset;
    const d = a.durations[i] / ts;
    const mid = t + d / 2;
    while (k < keeps.length && mid >= keeps[k][1]) k++;
    if (k >= keeps.length) break;
    if (mid < keeps[k][0]) continue;
    picked.push({ i, out: t - keeps[k][0] + outStart[k] });
  }
  for (const { i, out } of picked) {
    const d = (a.durations[i] / ts) * 1e6;
    let us = Math.round(out * 1e6);
    if (first) {
      us = 0;
      first = false;
    }
    if (us < prevEnd) us = prevEnd;
    const data = await reader.get(a.offsets[i], a.sizes[i]);
    muxer.addAudioChunkRaw(data.slice(), 'key', us, d, meta);
    prevEnd = us + Math.round(d);
  }
}
