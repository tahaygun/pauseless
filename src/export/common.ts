import type { MediaInfo } from '../engine/container';
import type { Range } from '../engine/silence';

export interface Rate {
  /** frame duration = num/den seconds */
  num: number;
  den: number;
  fps: number;
  /** Integer timebase used by FCP7 XML / EDL (30 for 29.97). */
  timebase: number;
  ntsc: boolean;
}

export function rateFor(fps: number): Rate {
  const ntsc = [23.976, 29.97, 47.952, 59.94, 119.88].find((r) => Math.abs(fps - r) < 0.01);
  if (ntsc) {
    const tb = Math.round(ntsc * 1.001);
    return { num: 1001, den: tb * 1000, fps: (tb * 1000) / 1001, timebase: tb, ntsc: true };
  }
  const r = Math.round(fps) || 30;
  return { num: 1, den: r, fps: r, timebase: r, ntsc: false };
}

export interface Clip {
  /** source range in frames */
  srcIn: number;
  srcOut: number;
  /** timeline position in frames */
  recIn: number;
}

export interface ExportInput {
  name: string; // file name, e.g. "episode.mp4"
  /** Absolute path of the source file on the user's computer, if known. */
  path?: string;
  media: MediaInfo;
  keeps: Range[];
}

export interface Prepared {
  rate: Rate;
  clips: Clip[];
  totalFrames: number; // source length
  timelineFrames: number;
  width: number;
  height: number;
  hasVideo: boolean;
  sampleRate: number;
  channels: number;
  baseName: string;
}

/** Snaps kept ranges to whole frames and lays them end to end. */
export function prepare(input: ExportInput): Prepared {
  const v = input.media.video;
  const rate = rateFor(v?.fps ?? 30);
  const toFrame = (t: number) => Math.round((t * rate.den) / rate.num);
  const totalFrames = toFrame(input.media.duration);
  const clips: Clip[] = [];
  let rec = 0;
  for (const [s, e] of input.keeps) {
    const a = Math.max(0, toFrame(s));
    const b = Math.min(totalFrames, toFrame(e));
    if (b <= a) continue;
    const last = clips[clips.length - 1];
    if (last && last.srcOut >= a) {
      // Rounding made two clips touch: merge them.
      rec += b - last.srcOut;
      last.srcOut = b;
      continue;
    }
    clips.push({ srcIn: a, srcOut: b, recIn: rec });
    rec += b - a;
  }
  return {
    rate,
    clips,
    totalFrames,
    timelineFrames: rec,
    width: v?.width ?? 1920,
    height: v?.height ?? 1080,
    hasVideo: !!v,
    sampleRate: input.media.audio.sampleRate,
    channels: input.media.audio.channels,
    baseName: input.name.replace(/\.[^.]+$/, ''),
  };
}

export const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Joins a folder typed by the user with the file name, keeping the OS style. */
export function joinPath(folder: string, name: string): string | undefined {
  const f = folder.trim().replace(/^["']|["']$/g, '');
  if (!f) return undefined;
  const win = /^[a-zA-Z]:[\\/]/.test(f) || f.startsWith('\\\\');
  const sep = win ? '\\' : '/';
  return f.replace(/[\\/]+$/, '') + sep + name;
}

/** file:// URL for an absolute path (or just the encoded name when unknown). */
export function fileUrl(path: string | undefined, name: string, host = ''): string {
  if (!path) return encodeURIComponent(name);
  const p = path.replace(/\\/g, '/');
  const enc = p
    .split('/')
    .map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file://${host}${enc.startsWith('/') ? '' : '/'}${enc}`;
}

export function download(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
