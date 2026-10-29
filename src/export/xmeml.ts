import { fileUrl, xml, type ExportInput, type Prepared } from './common';

/** Final Cut Pro 7 XML (xmeml v4): the format Premiere Pro imports natively. */
export function toXmeml(input: ExportInput, p: Prepared): string {
  const { timebase, ntsc } = p.rate;
  const rate = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const name = xml(input.name);
  const channels = Math.min(2, Math.max(1, p.channels));
  const fileDef = `<file id="file-1">
              <name>${name}</name>
              <pathurl>${xml(fileUrl(input.path, input.name, 'localhost'))}</pathurl>
              ${rate}
              <duration>${p.totalFrames}</duration>
              <media>
                ${
                  p.hasVideo
                    ? `<video><samplecharacteristics>${rate}<width>${p.width}</width><height>${p.height}</height></samplecharacteristics></video>`
                    : ''
                }
                <audio><samplecharacteristics><depth>16</depth><samplerate>${p.sampleRate}</samplerate></samplecharacteristics><channelcount>${p.channels}</channelcount></audio>
              </media>
            </file>`;
  let fileUsed = false;
  const fileRef = () => {
    if (fileUsed) return '<file id="file-1"/>';
    fileUsed = true;
    return fileDef;
  };

  const ids = (i: number) => ({ v: `clipitem-v${i + 1}`, a: [1, 2].slice(0, channels).map((ch) => `clipitem-a${ch}-${i + 1}`) });
  const links = (i: number) => {
    const id = ids(i);
    const all = [...(p.hasVideo ? [{ ref: id.v, type: 'video', track: 1 }] : []), ...id.a.map((ref, k) => ({ ref, type: 'audio', track: k + 1 }))];
    return all
      .map((l) => `<link><linkclipref>${l.ref}</linkclipref><mediatype>${l.type}</mediatype><trackindex>${l.track}</trackindex><clipindex>${i + 1}</clipindex></link>`)
      .join('');
  };
  const item = (id: string, i: number, extra = '') => {
    const c = p.clips[i];
    return `<clipitem id="${id}">
            <name>${name}</name>
            <enabled>TRUE</enabled>
            <duration>${p.totalFrames}</duration>
            ${rate}
            <start>${c.recIn}</start>
            <end>${c.recIn + c.srcOut - c.srcIn}</end>
            <in>${c.srcIn}</in>
            <out>${c.srcOut}</out>
            ${fileRef()}
            ${extra}
            ${links(i)}
          </clipitem>`;
  };

  const videoTrack = p.hasVideo ? `<track>${p.clips.map((_, i) => item(ids(i).v, i)).join('\n')}</track>` : '';
  const audioTracks = Array.from({ length: channels }, (_, ch) =>
    `<track>${p.clips
      .map((_, i) => item(ids(i).a[ch], i, `<sourcetrack><mediatype>audio</mediatype><trackindex>${ch + 1}</trackindex></sourcetrack>`))
      .join('\n')}</track>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${xml(p.baseName)} (Recut)</name>
    <duration>${p.timelineFrames}</duration>
    ${rate}
    <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>${p.width}</width><height>${p.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>
        ${videoTrack}
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format><samplecharacteristics><depth>16</depth><samplerate>${p.sampleRate}</samplerate></samplecharacteristics></format>
        ${audioTracks}
      </audio>
    </media>
  </sequence>
</xmeml>
`;
}
