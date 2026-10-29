import type { ExportInput, Prepared } from './common';

/** CMX 3600 EDL, a lowest-common-denominator cut list most editors read. */
export function toEdl(input: ExportInput, p: Prepared): string {
  const tb = p.rate.timebase;
  const tc = (f: number) => {
    const ff = f % tb;
    const s = Math.floor(f / tb);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(ff)}`;
  };
  const lines = [`TITLE: ${p.baseName} (Recut)`, 'FCM: NON-DROP FRAME', ''];
  p.clips.forEach((c, i) => {
    const len = c.srcOut - c.srcIn;
    lines.push(
      `${String(i + 1).padStart(3, '0')}  AX       ${p.hasVideo ? 'AA/V' : 'AA  '}  C        ${tc(c.srcIn)} ${tc(c.srcOut)} ${tc(
        c.recIn,
      )} ${tc(c.recIn + len)}`,
      `* FROM CLIP NAME: ${input.name}`,
      '',
    );
  });
  return lines.join('\r\n');
}
