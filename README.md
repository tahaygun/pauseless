<p align="center"><img src="public/icon.svg" width="96" height="96" alt="Pauseless logo"></p>

<h1 align="center">Pauseless</h1>

<p align="center">Cut silences and filler sounds out of your videos, right in the browser.<br>
Export the cut video, or a timeline for Final Cut Pro, DaVinci Resolve, Premiere Pro or CapCut.</p>

<p align="center"><a href="https://tahaygun.github.io/pauseless/"><b>Open Pauseless →</b></a></p>

<p align="center">Free · Open source (MIT) · Nothing is uploaded</p>

---

## What it does

- **Finds silences** in a 1 hour recording in about 6 seconds. Only the audio track is read and
  decoded, in parallel workers, with WebCodecs.
- **Finds filler sounds** ("um", "uh", "hmm", and Turkish "ııı", "eee") with a small neural network
  that runs on your device. Click a marked filler to keep it, or drag on the timeline to mark one
  it missed.
- **Live controls**: threshold (with auto), minimum silence, padding, minimum clip and filler
  sensitivity. Re-detection takes a few milliseconds, so the timeline updates as you drag.
- **Exports timelines**: Final Cut Pro and DaVinci Resolve (FCPXML 1.9), Premiere Pro (FCP7 XML),
  CapCut (draft folder) and EDL. Your editor links the timeline to your original video file.
- **Exports video**: re-encodes the kept parts in the browser (hardware encoder when available),
  copies the audio untouched and writes straight to disk.

Your video never leaves your computer. There is no server, no account and no tracking.

## Use it

Open [tahaygun.github.io/pauseless](https://tahaygun.github.io/pauseless/) in **Chrome or Edge** on Windows or macOS (WebCodecs is required) and drop a video.
It can be installed as an app from the address bar and then works offline.

Supported input: MP4, MOV, M4A (AAC or Opus audio; H.264 or HEVC video for rendering) and PCM WAV.
Recordings downloaded from Riverside work as they are.

## Develop

```sh
npm install
npm run dev                     # http://localhost:5173
npm run build                   # static site in dist/, deploy anywhere
npm run build:single            # one self-contained HTML file in dist-single/
```

`bench.html` (dev only) runs the analysis on a chosen file and prints timings.

### Project layout

```
src/engine/    container parsing (MP4/MOV/WAV), audio analysis workers, silence and filler detection
src/export/    FCPXML, Premiere XML, EDL and CapCut writers
src/render/    in-browser video render (WebCodecs + mp4-muxer)
src/ui/        waveform timeline and landing page animation
training/      Python scripts that train the filler-sound model
```

## Filler-sound model

A dilated 1D CNN with 22k parameters on 40-band log-mel features. `src/engine/mel.ts` must stay
identical to `training/mel.py`.

It was trained on the [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) (CC BY 4.0,
© University of Edinburgh and the AMI consortium) and fine-tuned on 32 minutes of hand-corrected
Turkish podcast speech. At the default sensitivity it finds about 70% of filler sounds with about
70-80% precision on held-out English and Turkish speech. See [training/README.md](training/README.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
