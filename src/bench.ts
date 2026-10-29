import { analyze } from './engine/analyze';
import { fillerProbabilities } from './engine/fillers';
import { autoThreshold, detect, DEFAULT_PARAMS } from './engine/silence';

const out = document.getElementById('out')!;
document.getElementById('f')!.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files![0];
  try {
    const a = await analyze(file);
    (window as any).analysis = a;
    (window as any).fprob = await fillerProbabilities(a.mel);
    const thr = autoThreshold(a.envelope);
    const t = performance.now();
    const r = detect(a.envelope, a.media.duration, { ...DEFAULT_PARAMS, threshold: thr, padLeft: 0, padRight: 0, minSilence: 0.3 });
    const detectMs = performance.now() - t;
    const res = {
      size: file.size, duration: a.media.duration, timings: a.timings, detectMs, threshold: thr,
      cuts: r.cuts.length, kept: r.keptDuration, firstCuts: r.cuts.slice(0, 25),
      audio: { ...a.media.audio, offsets: undefined, sizes: undefined, times: undefined, durations: undefined, description: undefined },
      video: a.media.video,
    };
    (window as any).result = res;
    out.textContent = JSON.stringify(res, null, 1);
  } catch (err) {
    (window as any).result = { error: String(err) };
    out.textContent = String(err);
  }
});
