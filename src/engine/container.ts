// Minimal ISO BMFF (MP4/MOV) and WAV parsing. We only read the box headers and
// the moov box, so finding the audio samples never touches the video payload.

export interface AudioTrack extends SampleTable {
  kind: 'compressed';
  codec: string; // WebCodecs codec string, e.g. "mp4a.40.2"
  description?: Uint8Array; // AudioSpecificConfig / dOps
  sampleRate: number;
  channels: number;
  timescale: number;
  /** Seconds to subtract from media time to get presentation time (edit list). */
  startOffset: number;
}

export interface PcmTrack {
  kind: 'pcm';
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  float: boolean;
  dataOffset: number;
  dataSize: number;
}

export interface SampleTable {
  offsets: Float64Array;
  sizes: Uint32Array;
  /** Decode timestamps in timescale units. */
  times: Float64Array;
  durations: Uint32Array;
}

export interface VideoInfo extends SampleTable {
  codec: string; // sample entry fourcc, e.g. "avc1"
  /** WebCodecs codec string, e.g. "avc1.640028" (empty if unknown) */
  codecString: string;
  description?: Uint8Array; // avcC / hvcC payload
  width: number;
  height: number;
  fps: number;
  duration: number;
  timescale: number;
  startOffset: number;
  /** Composition offsets (pts - dts) in timescale units */
  cts: Int32Array;
  /** Sync sample flags; all true when the track has no stss box */
  keyframes: Uint8Array;
}

export interface MediaInfo {
  duration: number;
  audio: AudioTrack | PcmTrack;
  video?: VideoInfo;
}

const read = async (file: Blob, start: number, end: number) =>
  new DataView(await file.slice(start, end).arrayBuffer());

const fourcc = (v: DataView, o: number) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

export async function probe(file: File): Promise<MediaInfo> {
  const head = await read(file, 0, 12);
  const tag = fourcc(head, 0);
  if (tag === 'RIFF' || tag === 'RF64') return probeWav(file);
  if (fourcc(head, 4) === 'ftyp' || ['moov', 'mdat', 'wide', 'free'].includes(fourcc(head, 4))) return probeMp4(file);
  throw new Error('Unsupported file. Use MP4, MOV, M4A or WAV.');
}

// ---------- MP4 / MOV ----------

async function probeMp4(file: File): Promise<MediaInfo> {
  let pos = 0;
  let moov: DataView | undefined;
  let fragmented = false;
  while (pos + 8 <= file.size) {
    const h = await read(file, pos, Math.min(pos + 16, file.size));
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(h.getBigUint64(8));
      hdr = 16;
    } else if (size === 0) size = file.size - pos;
    if (size < hdr) break;
    if (type === 'moov') moov = await read(file, pos + hdr, pos + size);
    if (type === 'moof') fragmented = true;
    pos += size;
  }
  if (!moov) throw new Error('This MP4 has no moov box (file may be incomplete).');

  const tracks = children(moov, 0, moov.byteLength).filter((b) => b.type === 'trak');
  const movieDuration = parseMvhd(moov);
  let audio: AudioTrack | undefined;
  let video: VideoInfo | undefined;
  for (const t of tracks) {
    const trak = parseTrak(moov, t.start, t.end);
    if (!trak) continue;
    if (trak.handler === 'soun' && !audio) audio = trak.audio;
    if (trak.handler === 'vide' && !video) video = trak.video;
  }
  if (!audio) {
    throw new Error(fragmented ? 'Fragmented MP4 files are not supported yet.' : 'No supported audio track found.');
  }
  if (audio.offsets.length === 0 && fragmented) throw new Error('Fragmented MP4 files are not supported yet.');
  const audioDur = audio.offsets.length
    ? (audio.times[audio.times.length - 1] + audio.durations[audio.durations.length - 1]) / audio.timescale
    : 0;
  return { duration: video?.duration || movieDuration || audioDur, audio, video };
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function children(v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    const type = fourcc(v, p + 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

function find(v: DataView, start: number, end: number, path: string[]): Box | undefined {
  let box: Box | undefined = { type: '', start, end };
  for (const name of path) {
    box = children(v, box.start, box.end).find((b) => b.type === name);
    if (!box) return undefined;
  }
  return box;
}

function parseMvhd(moov: DataView): number {
  const b = find(moov, 0, moov.byteLength, ['mvhd']);
  if (!b) return 0;
  const ver = moov.getUint8(b.start);
  const ts = moov.getUint32(b.start + (ver ? 20 : 12));
  const dur = ver ? Number(moov.getBigUint64(b.start + 24)) : moov.getUint32(b.start + 16);
  return ts ? dur / ts : 0;
}

function parseTrak(v: DataView, start: number, end: number) {
  const mdia = find(v, start, end, ['mdia']);
  if (!mdia) return;
  const hdlr = find(v, mdia.start, mdia.end, ['hdlr']);
  const mdhd = find(v, mdia.start, mdia.end, ['mdhd']);
  const stbl = find(v, mdia.start, mdia.end, ['minf', 'stbl']);
  if (!hdlr || !mdhd || !stbl) return;
  const handler = fourcc(v, hdlr.start + 8);
  const mver = v.getUint8(mdhd.start);
  const timescale = v.getUint32(mdhd.start + (mver ? 20 : 12));
  const mdur = mver ? Number(v.getBigUint64(mdhd.start + 24)) : v.getUint32(mdhd.start + 16);

  const stbx = children(v, stbl.start, stbl.end);
  const get = (t: string) => stbx.find((b) => b.type === t);
  const stsd = get('stsd');
  if (!stsd) return;
  const entry = children(v, stsd.start + 8, stsd.end)[0];
  if (!entry) return;

  // Edit list: first non-empty edit's media_time shifts presentation start.
  let startOffset = 0;
  const elst = find(v, start, end, ['edts', 'elst']);
  if (elst) {
    const ever = v.getUint8(elst.start);
    const n = v.getUint32(elst.start + 4);
    let p = elst.start + 8;
    for (let i = 0; i < n; i++) {
      const mt = ever ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4);
      p += ever ? 20 : 12;
      if (mt >= 0) {
        startOffset = mt / timescale;
        break;
      }
    }
  }

  if (handler === 'vide') {
    const table = readSamples(v, get);
    const n = table.sizes.length;
    const cts = new Int32Array(n);
    const ctts = get('ctts');
    if (ctts) {
      const cnt = v.getUint32(ctts.start + 4);
      let k = 0;
      for (let i = 0; i < cnt && k < n; i++) {
        const c = v.getUint32(ctts.start + 8 + i * 8);
        const off = v.getInt32(ctts.start + 12 + i * 8);
        for (let j = 0; j < c && k < n; j++) cts[k++] = off;
      }
    }
    const keyframes = new Uint8Array(n);
    const stss = get('stss');
    if (stss) {
      const cnt = v.getUint32(stss.start + 4);
      for (let i = 0; i < cnt; i++) {
        const idx = v.getUint32(stss.start + 8 + i * 4) - 1;
        if (idx < n) keyframes[idx] = 1;
      }
    } else keyframes.fill(1);
    const e = entry.start;
    const config = children(v, e + 78, entry.end).find((b) => b.type === 'avcC' || b.type === 'hvcC');
    const description = config ? new Uint8Array(v.buffer, v.byteOffset + config.start, config.end - config.start).slice() : undefined;
    let codecString = '';
    if (config?.type === 'avcC' && description) {
      const hex = (x: number) => x.toString(16).padStart(2, '0');
      codecString = `${entry.type === 'avc3' ? 'avc3' : 'avc1'}.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
    } else if (config?.type === 'hvcC' && description) {
      codecString = hevcCodecString(entry.type, description);
    }
    const duration = mdur / timescale;
    return {
      handler,
      video: {
        ...table,
        codec: entry.type,
        codecString,
        description,
        width: v.getUint16(e + 24),
        height: v.getUint16(e + 26),
        fps: duration ? n / duration : 30,
        duration,
        timescale,
        startOffset,
        cts,
        keyframes,
      } as VideoInfo,
    };
  }
  if (handler !== 'soun') return;

  // Audio sample entry
  const e = entry.start;
  const qtVersion = v.getUint16(e + 8);
  let channels = v.getUint16(e + 16);
  let sampleRate = v.getUint32(e + 24) >>> 16;
  if (qtVersion === 2) {
    sampleRate = v.getFloat64(e + 32);
    channels = v.getUint32(e + 40);
  }
  let codec: string;
  let description: Uint8Array | undefined;
  if (entry.type === 'mp4a') {
    const asc = findEsds(v, e, entry.end);
    if (!asc) throw new Error('AAC track is missing its decoder config.');
    description = asc;
    let aot = asc[0] >> 3;
    if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
    codec = `mp4a.40.${aot}`;
    // Prefer the real rate from AudioSpecificConfig (sample entries can lie for HE-AAC).
    const idx = ((asc[0] & 7) << 1) | (asc[1] >> 7);
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (idx < rates.length && aot !== 5 && aot !== 29) sampleRate = rates[idx];
    const ch = (asc[1] >> 3) & 15;
    if (ch > 0 && ch < 8) channels = ch === 7 ? 8 : ch;
  } else if (entry.type === 'Opus') {
    codec = 'opus';
    const dops = children(v, e + 28, entry.end).find((b) => b.type === 'dOps');
    if (dops) description = opusHead(v, dops);
  } else {
    throw new Error(`Audio codec "${entry.type}" is not supported yet.`);
  }

  const { offsets, sizes, times, durations } = readSamples(v, get);

  return {
    handler,
    audio: {
      kind: 'compressed',
      codec,
      description,
      sampleRate,
      channels,
      timescale,
      startOffset,
      offsets,
      sizes,
      times,
      durations,
    } as AudioTrack,
  };
}

function readSamples(v: DataView, get: (t: string) => Box | undefined): SampleTable {
  const sttsB = get('stts');
  const stscB = get('stsc');
  const stszB = get('stsz');
  const stcoB = get('stco') ?? get('co64');
  if (!sttsB || !stscB || !stszB || !stcoB) throw new Error('Sample table is incomplete.');

  const uniform = v.getUint32(stszB.start + 4);
  const count = v.getUint32(stszB.start + 8);
  const sizes = new Uint32Array(count);
  if (uniform) sizes.fill(uniform);
  else for (let i = 0; i < count; i++) sizes[i] = v.getUint32(stszB.start + 12 + i * 4);

  const times = new Float64Array(count);
  const durations = new Uint32Array(count);
  {
    const n = v.getUint32(sttsB.start + 4);
    let s = 0;
    let t = 0;
    for (let i = 0; i < n && s < count; i++) {
      const c = v.getUint32(sttsB.start + 8 + i * 8);
      const d = v.getUint32(sttsB.start + 12 + i * 8);
      for (let k = 0; k < c && s < count; k++, s++) {
        times[s] = t;
        durations[s] = d;
        t += d;
      }
    }
  }

  const co64 = stcoB.type === 'co64';
  const nChunks = v.getUint32(stcoB.start + 4);
  const chunkOff = new Float64Array(nChunks);
  for (let i = 0; i < nChunks; i++) {
    chunkOff[i] = co64 ? Number(v.getBigUint64(stcoB.start + 8 + i * 8)) : v.getUint32(stcoB.start + 8 + i * 4);
  }
  const offsets = new Float64Array(count);
  {
    const n = v.getUint32(stscB.start + 4);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const first = v.getUint32(stscB.start + 8 + i * 12) - 1;
      const per = v.getUint32(stscB.start + 12 + i * 12);
      const next = i + 1 < n ? v.getUint32(stscB.start + 8 + (i + 1) * 12) - 1 : nChunks;
      for (let c = first; c < next && s < count; c++) {
        let off = chunkOff[c];
        for (let k = 0; k < per && s < count; k++, s++) {
          offsets[s] = off;
          off += sizes[s];
        }
      }
    }
  }
  return { offsets, sizes, times, durations };
}

function hevcCodecString(type: string, c: Uint8Array): string {
  const space = ['', 'A', 'B', 'C'][c[1] >> 6];
  const tier = c[1] & 0x20 ? 'H' : 'L';
  const profile = c[1] & 0x1f;
  let compat = (c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5];
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const constraints: string[] = [];
  const bytes = Array.from(c.slice(6, 12));
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  for (const b of bytes) constraints.push(b.toString(16));
  return [type === 'hev1' ? 'hev1' : 'hvc1', `${space}${profile}`, (rev >>> 0).toString(16), `${tier}${c[12]}`, ...constraints].join('.');
}

function findEsds(v: DataView, start: number, end: number): Uint8Array | undefined {
  // esds may be nested (e.g. inside a QuickTime 'wave' box), so scan for it.
  for (let p = start; p + 8 < end; p++) {
    if (v.getUint32(p + 4) === 0x65736473 /* esds */) {
      const boxEnd = p + v.getUint32(p);
      let q = p + 12;
      const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const len = () => {
        let n = 0;
        for (let i = 0; i < 4; i++) {
          const b = u8[q++];
          n = (n << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        return n;
      };
      while (q < boxEnd) {
        const tag = u8[q++];
        const l = len();
        if (tag === 0x03) {
          const flags = u8[q + 2];
          q += 3;
          if (flags & 0x80) q += 2;
          if (flags & 0x40) q += 1 + u8[q];
          if (flags & 0x20) q += 2;
        } else if (tag === 0x04) {
          q += 13;
        } else if (tag === 0x05) {
          return u8.slice(q, q + l);
        } else {
          q += l;
        }
      }
      return undefined;
    }
  }
  return undefined;
}

function opusHead(v: DataView, b: Box): Uint8Array {
  // Convert MP4 dOps (big endian) to an OpusHead (little endian) for WebCodecs.
  const ch = v.getUint8(b.start + 1);
  const len = b.end - b.start;
  const out = new Uint8Array(19 + (len > 11 ? len - 11 : 0));
  const o = new DataView(out.buffer);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);
  o.setUint8(8, 1);
  o.setUint8(9, ch);
  o.setUint16(10, v.getUint16(b.start + 2), true);
  o.setUint32(12, v.getUint32(b.start + 4), true);
  o.setInt16(16, v.getInt16(b.start + 8), true);
  o.setUint8(18, v.getUint8(b.start + 10));
  for (let i = 11; i < len; i++) out[19 + i - 11] = v.getUint8(b.start + i);
  return out;
}

// ---------- WAV ----------

async function probeWav(file: File): Promise<MediaInfo> {
  let pos = 12;
  let fmt: DataView | undefined;
  let dataOffset = 0;
  let dataSize = 0;
  let ds64Size = 0;
  while (pos + 8 <= file.size) {
    const h = await read(file, pos, pos + 8);
    const id = fourcc(h, 0);
    let size = h.getUint32(4, true);
    if (id === 'ds64') {
      const d = await read(file, pos + 8, pos + 8 + 28);
      ds64Size = Number(d.getBigUint64(8, true));
    }
    if (id === 'fmt ') fmt = await read(file, pos + 8, pos + 8 + size);
    if (id === 'data') {
      dataOffset = pos + 8;
      if (size === 0xffffffff && ds64Size) size = ds64Size;
      dataSize = Math.min(size, file.size - dataOffset);
      break;
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !dataOffset) throw new Error('Invalid WAV file.');
  let format = fmt.getUint16(0, true);
  const channels = fmt.getUint16(2, true);
  const sampleRate = fmt.getUint32(4, true);
  const bitsPerSample = fmt.getUint16(14, true);
  if (format === 0xfffe && fmt.byteLength >= 26) format = fmt.getUint16(24, true);
  if (format !== 1 && format !== 3) throw new Error('Only PCM WAV files are supported.');
  const frames = dataSize / (channels * (bitsPerSample / 8));
  return {
    duration: frames / sampleRate,
    audio: { kind: 'pcm', sampleRate, channels, bitsPerSample, float: format === 3, dataOffset, dataSize },
  };
}
