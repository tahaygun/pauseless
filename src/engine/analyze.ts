import { probe, type MediaInfo } from './container';
import type { EnvelopeJob, EnvelopePart } from './envelope.worker';
import EnvelopeWorker from './envelope.worker?worker&inline';
import { MEL_BANDS, MEL_HOP } from './mel';

export const ENVELOPE_RATE = 100; // windows per second (10 ms)

export interface Envelope {
  rate: number;
  /** RMS amplitude per window, 0..1 */
  rms: Float32Array;
  /** Peak amplitude per window, 0..1 */
  peak: Float32Array;
}

export interface MelFeatures {
  /** frames x MEL_BANDS log-mel values, frame k centered at k*MEL_HOP + MEL_WIN/2 */
  data: Float32Array;
  frames: number;
}

export interface Analysis {
  media: MediaInfo;
  envelope: Envelope;
  mel: MelFeatures;
  timings: { probe: number; decode: number; total: number };
}

export async function analyze(file: File, onProgress?: (p: number) => void): Promise<Analysis> {
  const t0 = performance.now();
  const media = await probe(file);
  const t1 = performance.now();
  const track = media.audio;
  const total = track.kind === 'pcm' ? track.dataSize / ((track.bitsPerSample / 8) * track.channels) : track.offsets.length;
  if (!total) throw new Error('The audio track is empty.');

  // AudioDecoder throughput is latency bound, so oversubscribing cores helps
  // (measured: 4 cores, 1 h AAC: 4 workers 6.4 s, 8 workers 4.9 s, 12 workers 4.7 s).
  const workers = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) * 2, 12, Math.ceil(total / 2000)));
  const n = Math.ceil(media.duration * ENVELOPE_RATE) + 1;
  const sumSq = new Float64Array(n);
  const count = new Uint32Array(n);
  const peak = new Float32Array(n);
  const melFrames = Math.max(0, Math.floor(media.duration / MEL_HOP));
  const mel = new Float32Array(melFrames * MEL_BANDS);
  const melHave = new Uint8Array(melFrames);

  let done = 0;
  const jobs = Array.from({ length: workers }, (_, i) => {
    const from = Math.floor((total * i) / workers);
    const to = Math.floor((total * (i + 1)) / workers);
    return runJob({ file, track, from, to, rate: ENVELOPE_RATE }).then((part) => {
      for (let k = 0; k < part.sumSq.length; k++) {
        const w = part.w0 + k;
        if (w >= n) break;
        sumSq[w] += part.sumSq[k];
        count[w] += part.count[k];
        if (part.peak[k] > peak[w]) peak[w] = part.peak[k];
      }
      const cnt = part.mel.length / MEL_BANDS;
      for (let k = 0; k < cnt; k++) {
        const f = part.mel0 + k;
        if (f < 0 || f >= melFrames || melHave[f]) continue;
        mel.set(part.mel.subarray(k * MEL_BANDS, (k + 1) * MEL_BANDS), f * MEL_BANDS);
        melHave[f] = 1;
      }
      onProgress?.(++done / workers);
    });
  });
  await Promise.all(jobs);

  // Frames missing at worker boundaries: copy the nearest earlier frame.
  for (let f = 1; f < melFrames; f++) {
    if (!melHave[f] && melHave[f - 1]) {
      mel.copyWithin(f * MEL_BANDS, (f - 1) * MEL_BANDS, f * MEL_BANDS);
      melHave[f] = 1;
    }
  }
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) rms[i] = count[i] ? Math.sqrt(sumSq[i] / count[i]) : 0;
  const t2 = performance.now();
  return { media, envelope: { rate: ENVELOPE_RATE, rms, peak }, mel: { data: mel, frames: melFrames }, timings: { probe: t1 - t0, decode: t2 - t1, total: t2 - t0 } };
}

function runJob(job: EnvelopeJob): Promise<EnvelopePart> {
  return new Promise((resolve, reject) => {
    const w = new EnvelopeWorker();
    w.onmessage = (e) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.part);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'Worker failed'));
    };
    w.postMessage(job);
  });
}
