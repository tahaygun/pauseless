// Decodes one slice of the audio track and accumulates per-window energy.
// Several of these run in parallel, each on its own range of samples.

import type { AudioTrack, PcmTrack } from './container';
import { MEL_BANDS, MelStream } from './mel';

export interface EnvelopeJob {
  file: File;
  track: AudioTrack | PcmTrack;
  /** Sample range for compressed tracks, frame range for PCM. */
  from: number;
  to: number;
  rate: number; // envelope windows per second
}

export interface EnvelopePart {
  w0: number;
  sumSq: Float64Array;
  count: Uint32Array;
  peak: Float32Array;
  /** Log-mel frames (MEL_BANDS per frame) starting at frame index mel0 */
  mel0: number;
  mel: Float32Array;
}

const PREROLL = 3; // AAC frames decoded before the range so the first output is clean
const MAX_GAP = 1024 * 1024; // merge reads across gaps smaller than this
const MAX_RUN = 8 * 1024 * 1024;
const PREFETCH = 4;

class Acc {
  sumSq: Float64Array;
  count: Uint32Array;
  peak: Float32Array;
  melStream?: MelStream;
  private mono = new Float32Array(4096);
  constructor(public w0: number, w1: number) {
    const n = Math.max(0, w1 - w0);
    this.sumSq = new Float64Array(n);
    this.count = new Uint32Array(n);
    this.peak = new Float32Array(n);
  }

  /** Feeds channel-planar samples starting at presentation time t0 (s). */
  pushMel(planes: Float32Array[], n: number, sr: number, t0: number) {
    this.melStream ??= new MelStream(sr);
    if (this.mono.length < n) this.mono = new Float32Array(n);
    const ch = planes.length;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < ch; c++) m += planes[c][i];
      this.mono[i] = m / ch;
    }
    this.melStream.push(this.mono, n, Math.round(t0 * sr));
  }

  packMel(): { mel0: number; mel: Float32Array } {
    const ms = this.melStream;
    if (!ms || ms.firstFrame < 0) return { mel0: 0, mel: new Float32Array(0) };
    const out = new Float32Array(ms.frames.length * MEL_BANDS);
    ms.frames.forEach((f, i) => f && out.set(f, i * MEL_BANDS));
    return { mel0: ms.firstFrame, mel: out };
  }
}

self.onmessage = async (e: MessageEvent<EnvelopeJob>) => {
  try {
    const part = e.data.track.kind === 'pcm' ? await runPcm(e.data, e.data.track) : await runCompressed(e.data, e.data.track);
    const { mel0, mel } = part.packMel();
    const msg: EnvelopePart = { w0: part.w0, sumSq: part.sumSq, count: part.count, peak: part.peak, mel0, mel };
    (self as unknown as Worker).postMessage({ ok: true, part: msg }, [
      msg.sumSq.buffer,
      msg.count.buffer,
      msg.peak.buffer,
      msg.mel.buffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};

async function runCompressed(job: EnvelopeJob, t: AudioTrack): Promise<Acc> {
  const { file, from, to, rate } = job;
  const ts = t.timescale;
  const tStart = t.times[from] / ts - t.startOffset;
  const tEnd = (t.times[to - 1] + t.durations[to - 1]) / ts - t.startOffset;
  const acc = new Acc(Math.max(0, Math.floor(tStart * rate)), Math.ceil(tEnd * rate) + 1);
  const keepFromUs = Math.round((t.times[from] / ts) * 1e6) - 1;

  let planes: Float32Array[] = [];
  let failure: unknown;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        if (data.timestamp >= keepFromUs) accumulate(data, acc, rate, t.startOffset, planes);
      } finally {
        data.close();
      }
    },
    error: (err) => (failure = err),
  });
  const accumulate = (data: AudioData, a: Acc, r: number, off: number, buf: Float32Array[]) => {
    const n = data.numberOfFrames;
    const ch = data.numberOfChannels;
    if (buf.length !== ch || buf[0].length < n) {
      buf = Array.from({ length: ch }, () => new Float32Array(Math.max(n, 4096)));
      planes = buf;
    }
    for (let c = 0; c < ch; c++) data.copyTo(buf[c], { planeIndex: c, format: 'f32-planar', frameCount: n });
    const sr = data.sampleRate;
    const t0 = data.timestamp / 1e6 - off;
    a.pushMel(buf, n, sr, t0);
    let w = Math.floor(t0 * r) - a.w0;
    let i = 0;
    while (i < n) {
      const wEnd = Math.min(n, Math.ceil(((w + a.w0 + 1) / r - t0) * sr));
      const stop = wEnd <= i ? i + 1 : wEnd;
      if (w >= 0 && w < a.sumSq.length) {
        let s = 0;
        let pk = a.peak[w];
        for (let k = i; k < stop; k++) {
          let m = 0;
          for (let c = 0; c < ch; c++) {
            const x = buf[c][k];
            m += x * x;
            const ax = x < 0 ? -x : x;
            if (ax > pk) pk = ax;
          }
          s += m / ch;
        }
        a.sumSq[w] += s;
        a.count[w] += stop - i;
        a.peak[w] = pk;
      }
      i = stop;
      w++;
    }
  };

  decoder.configure({
    codec: t.codec,
    sampleRate: t.sampleRate,
    numberOfChannels: t.channels,
    description: t.description,
  });

  const first = Math.max(0, from - PREROLL);
  // Group consecutive samples into large contiguous reads.
  const runs: { start: number; end: number; s0: number; s1: number }[] = [];
  for (let s = first; s < to; ) {
    const start = t.offsets[s];
    let end = start + t.sizes[s];
    let s1 = s + 1;
    while (s1 < to) {
      const o = t.offsets[s1];
      if (o < end || o - end > MAX_GAP || o + t.sizes[s1] - start > MAX_RUN) break;
      end = o + t.sizes[s1];
      s1++;
    }
    runs.push({ start, end, s0: s, s1 });
    s = s1;
  }

  const pending: Promise<ArrayBuffer>[] = [];
  let next = 0;
  const fill = () => {
    while (pending.length < PREFETCH && next < runs.length) {
      const r = runs[next++];
      pending.push(file.slice(r.start, r.end).arrayBuffer());
    }
  };
  fill();
  for (let ri = 0; ri < runs.length; ri++) {
    const buf = new Uint8Array(await pending.shift()!);
    fill();
    const r = runs[ri];
    for (let s = r.s0; s < r.s1; s++) {
      const o = t.offsets[s] - r.start;
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((t.times[s] / ts) * 1e6),
          duration: Math.round((t.durations[s] / ts) * 1e6),
          data: buf.subarray(o, o + t.sizes[s]),
        }),
      );
    }
    if (failure) throw failure;
    if (decoder.decodeQueueSize > 200) {
      await new Promise<void>((res) => {
        const h = () => {
          if (decoder.decodeQueueSize <= 50) {
            decoder.removeEventListener('dequeue', h);
            res();
          }
        };
        decoder.addEventListener('dequeue', h);
      });
    }
  }
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  return acc;
}

async function runPcm(job: EnvelopeJob, t: PcmTrack): Promise<Acc> {
  const { file, from, to, rate } = job;
  const bps = t.bitsPerSample / 8;
  const frameBytes = bps * t.channels;
  const acc = new Acc(Math.floor((from / t.sampleRate) * rate), Math.ceil((to / t.sampleRate) * rate) + 1);
  const CHUNK = Math.floor((16 * 1024 * 1024) / frameBytes) * frameBytes;
  const startByte = t.dataOffset + from * frameBytes;
  const endByte = t.dataOffset + to * frameBytes;
  const reads: Promise<ArrayBuffer>[] = [];
  let pos = startByte;
  const fill = () => {
    while (reads.length < 3 && pos < endByte) {
      const e = Math.min(endByte, pos + CHUNK);
      reads.push(file.slice(pos, e).arrayBuffer());
      pos = e;
    }
  };
  fill();
  let frame = from;
  const spw = t.sampleRate / rate;
  while (reads.length) {
    const buf = await reads.shift()!;
    fill();
    const v = new DataView(buf);
    const n = Math.floor(buf.byteLength / frameBytes);
    const mono = new Float32Array(n);
    const chunkStart = frame;
    for (let i = 0; i < n; i++, frame++) {
      const w = Math.floor(frame / spw) - acc.w0;
      let m = 0;
      let pk = 0;
      for (let c = 0; c < t.channels; c++) {
        const o = i * frameBytes + c * bps;
        let x: number;
        if (t.float) x = bps === 8 ? v.getFloat64(o, true) : v.getFloat32(o, true);
        else if (bps === 2) x = v.getInt16(o, true) / 32768;
        else if (bps === 3) x = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608);
        else if (bps === 4) x = v.getInt32(o, true) / 2147483648;
        else x = (v.getUint8(o) - 128) / 128;
        m += x * x;
        mono[i] += x / t.channels;
        const ax = Math.abs(x);
        if (ax > pk) pk = ax;
      }
      if (w >= 0 && w < acc.sumSq.length) {
        acc.sumSq[w] += m / t.channels;
        acc.count[w]++;
        if (pk > acc.peak[w]) acc.peak[w] = pk;
      }
    }
    acc.pushMel([mono], n, t.sampleRate, chunkStart / t.sampleRate);
  }
  return acc;
}
