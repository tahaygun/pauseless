import { fileUrl, xml, type ExportInput, type Prepared } from './common';

/** FCPXML 1.9: opens in Final Cut Pro 10.4.1+ and DaVinci Resolve 17+. */
export function toFcpxml(input: ExportInput, p: Prepared): string {
  const { num, den } = p.rate;
  const t = (frames: number) => (frames === 0 ? '0s' : `${frames * num}/${den}s`);
  const name = xml(p.baseName);
  const fileName = xml(input.name);
  const audio =
    `hasAudio="1" audioSources="1" audioChannels="${p.channels}" audioRate="${p.sampleRate}"`;
  const clips = p.clips
    .map(
      (c) =>
        `          <asset-clip ref="r2" offset="${t(c.recIn)}" name="${fileName}" start="${t(c.srcIn)}" duration="${t(
          c.srcOut - c.srcIn,
        )}" format="r1" tcFormat="NDF"/>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="${num}/${den}s" width="${p.width}" height="${p.height}" colorSpace="1-1-1 (Rec. 709)"/>
    <asset id="r2" name="${fileName}" start="0s" duration="${t(p.totalFrames)}" hasVideo="${p.hasVideo ? 1 : 0}" format="r1" ${audio}>
      <media-rep kind="original-media" src="${xml(fileUrl(input.path, input.name))}"/>
    </asset>
  </resources>
  <library>
    <event name="Pauseless">
      <project name="${name} (Pauseless)">
        <sequence format="r1" duration="${t(p.timelineFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="${
          p.channels === 1 ? 'mono' : 'stereo'
        }" audioRate="${p.sampleRate >= 48000 ? '48k' : '44.1k'}">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
