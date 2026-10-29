const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 01:02:03.45 */
export function formatTime(t: number) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/** 1:02:03 or 02:03 */
export function formatDuration(t: number) {
  const s = Math.round(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
