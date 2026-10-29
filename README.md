# Pauseless

Remove silences from videos in the browser and export the result to your editor.
Everything runs on your computer; nothing is uploaded. Free and open source (MIT).

- **Analyze**: 1 hour MP4 in about 5 s (audio only is read and decoded, in parallel workers).
- **Tweak**: threshold (with auto), minimum silence, padding, minimum clip. Re-detection takes a few ms.
- **Export timeline**: Final Cut Pro and DaVinci Resolve (FCPXML 1.9), Premiere Pro (FCP7 XML),
  CapCut (project folder, unzip into CapCut's drafts folder), EDL.
- **Export video**: re-encodes the kept parts with WebCodecs (hardware encoder when available) and
  copies the audio untouched. Writes straight to disk via the File System Access API.

Supported input: MP4, MOV, M4A (AAC or Opus audio; H.264/HEVC video for rendering) and PCM WAV.
Requires Chrome or Edge (WebCodecs) on Windows or macOS.

## Develop

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ (deploy anywhere, installable as an app)
npx vite build --mode single   # one self-contained HTML file in dist-single/
```

`bench.html` (dev only) runs the analysis on a chosen file and prints timings.

## Filler sounds

Pauseless also finds filler sounds ("um", "uh", "hmm") with a small neural network (22k parameters)
that runs in the browser on 40-band log-mel features. `src/engine/mel.ts` must stay identical to the
training feature code.

The model was trained on the [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/)
(CC BY 4.0, © University of Edinburgh and the AMI consortium). On held-out podcast speech it finds
about 70% of fillers with about 70% precision at the default sensitivity.
