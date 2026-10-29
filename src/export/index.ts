import { toCapcut } from './capcut';
import { download, prepare, type ExportInput } from './common';
import { toEdl } from './edl';
import { toFcpxml } from './fcpxml';
import { toXmeml } from './xmeml';

export type ExportKind = 'fcp' | 'resolve' | 'premiere' | 'capcut' | 'edl';

export const HOWTO: Record<ExportKind, string> = {
  fcp: 'In Final Cut Pro: <b>File → Import → XML…</b> and pick the .fcpxml file.',
  resolve: 'In DaVinci Resolve: <b>File → Import → Timeline…</b> and pick the .fcpxml file.',
  premiere: 'In Premiere Pro: <b>File → Import…</b> and pick the .xml file. A new sequence appears in the project.',
  capcut:
    'Unzip into CapCut\'s drafts folder (CapCut → <b>Settings → Projects / Drafts location</b>), then restart CapCut. ' +
    'The project shows up in your project list.',
  edl: 'Import the .edl as a timeline in your editor and point it to the original video when asked.',
};

export function exportTimeline(kind: ExportKind, input: ExportInput) {
  const p = prepare(input);
  const base = `${p.baseName} (Recut)`;
  switch (kind) {
    case 'fcp':
    case 'resolve':
      return download(toFcpxml(input, p), `${base}.fcpxml`, 'application/xml');
    case 'premiere':
      return download(toXmeml(input, p), `${base}.xml`, 'application/xml');
    case 'edl':
      return download(toEdl(input, p), `${base}.edl`, 'text/plain');
    case 'capcut': {
      const { filename, data } = toCapcut(input, p);
      return download(data, filename, 'application/zip');
    }
  }
}
