import type { MelFeatures } from './analyze';
import { MEL_BANDS, MEL_HOP } from './mel';
import type { ConvLayer, FillerJob } from './filler.worker';
import FillerWorker from './filler.worker?worker&inline';
import { MODEL } from './fillerModel';
import type { Range } from './silence';

export interface FillerModel {
  layers: ConvLayer[];
  /** frames of context the model looks at on each side */
  context: number;
}

let model: FillerModel | undefined;

function decode(b64: string) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

function loadModel(): FillerModel {
  if (model) return model;
  const layers = MODEL.layers.map((l) => ({ ...l, w: decode(l.w), b: decode(l.b) }));
  const context = layers.reduce((a, l) => a + ((l.k - 1) / 2) * l.dil, 0);
  model = { layers, context };
  return model;
}

/** Per-band standardization using the louder 70% of frames (matches training). */
function normalize(mel: MelFeatures): Float32Array {
  const { data, frames } = mel;
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let b = 0; b < MEL_BANDS; b++) s += data[f * MEL_BANDS + b];
    energy[f] = s / MEL_BANDS;
  }
  const sorted = Float32Array.from(energy).sort();
  const cut = frames > 20 ? sorted[Math.floor(0.3 * (frames - 1))] : -Infinity;
  const mean = new Float64Array(MEL_BANDS);
  const sq = new Float64Array(MEL_BANDS);
  let n = 0;
  for (let f = 0; f < frames; f++) {
    if (energy[f] < cut) continue;
    n++;
    for (let b = 0; b < MEL_BANDS; b++) {
      const v = data[f * MEL_BANDS + b];
      mean[b] += v;
      sq[b] += v * v;
    }
  }
  const out = new Float32Array(data.length);
  for (let b = 0; b < MEL_BANDS; b++) {
    const m = mean[b] / Math.max(1, n);
    const sd = Math.sqrt(Math.max(0, sq[b] / Math.max(1, n) - m * m)) + 1e-3;
    for (let f = 0; f < frames; f++) out[f * MEL_BANDS + b] = (data[f * MEL_BANDS + b] - m) / sd;
  }
  return out;
}

/** Filler probability per mel frame (0..1). */
export async function fillerProbabilities(mel: MelFeatures): Promise<Float32Array> {
  const { layers, context } = loadModel();
  const x = normalize(mel);
  const frames = mel.frames;
  const workers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8, Math.ceil(frames / 5000)));
  const per = Math.ceil(frames / workers);
  const parts = await Promise.all(
    Array.from({ length: workers }, (_, i) => {
      const a = i * per;
      const b = Math.min(frames, a + per);
      const s = Math.max(0, a - context);
      const e = Math.min(frames, b + context);
      const job: FillerJob = {
        mel: x.slice(s * MEL_BANDS, e * MEL_BANDS),
        frames: e - s,
        bands: MEL_BANDS,
        layers,
        padL: a - s,
        padR: e - b,
      };
      return new Promise<Float32Array>((resolve, reject) => {
        const w = new FillerWorker();
        w.onmessage = (ev) => {
          w.terminate();
          resolve(ev.data);
        };
        w.onerror = (ev) => {
          w.terminate();
          reject(new Error(ev.message || 'Filler detection failed'));
        };
        w.postMessage(job, [job.mel.buffer]);
      });
    }),
  );
  const prob = new Float32Array(frames);
  parts.forEach((p, i) => prob.set(p, i * per));
  return prob;
}

/** Turns frame probabilities into filler ranges (seconds). */
export function fillerRanges(prob: Float32Array, threshold: number, minFrames = 5): Range[] {
  const out: Range[] = [];
  let start = -1;
  const n = prob.length;
  for (let i = 0; i <= n; i++) {
    // 3-frame moving average, zero padded like the training evaluation
    const p = i < n ? ((i > 0 ? prob[i - 1] : 0) + prob[i] + (i + 1 < n ? prob[i + 1] : 0)) / 3 : 0;
    const on = p > threshold;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      if (i - start >= minFrames) out.push([start * MEL_HOP, i * MEL_HOP + 0.025]);
      start = -1;
    }
  }
  return out;
}
