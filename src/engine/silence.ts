import type { Envelope } from './analyze';

export interface SilenceParams {
  /** RMS amplitude (0..1) below which audio counts as silent. */
  threshold: number;
  /** Silences shorter than this (seconds) are kept. */
  minSilence: number;
  /** Seconds of silence left after speech ends (left side of each cut). */
  padLeft: number;
  /** Seconds of silence left before speech starts (right side of each cut). */
  padRight: number;
  /** Speech segments shorter than this (seconds) are removed too. */
  minKeep: number;
}

export const DEFAULT_PARAMS: SilenceParams = {
  threshold: 0.01,
  minSilence: 0.5,
  padLeft: 0.1,
  padRight: 0.1,
  minKeep: 0,
};

export type Range = [start: number, end: number];

export interface CutResult {
  cuts: Range[];
  keeps: Range[];
  duration: number;
  keptDuration: number;
}

export function detect(env: Envelope, duration: number, p: SilenceParams): CutResult {
  const { rms, rate } = env;
  const n = Math.min(rms.length, Math.ceil(duration * rate));
  const minWin = Math.max(1, Math.round(p.minSilence * rate));
  const raw: Range[] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const silent = i < n && rms[i] < p.threshold;
    if (silent && start < 0) start = i;
    else if (!silent && start >= 0) {
      if (i - start >= minWin) raw.push([start / rate, Math.min(duration, i / rate)]);
      start = -1;
    }
  }

  // Padding shrinks each cut, except on the side touching the start/end of the file.
  let cuts: Range[] = [];
  for (const [s, e] of raw) {
    const cs = s <= 0 ? 0 : s + p.padLeft;
    const ce = e >= duration ? duration : e - p.padRight;
    if (ce - cs > 1e-3) cuts.push([cs, ce]);
  }

  if (p.minKeep > 0 && cuts.length) {
    const merged: Range[] = [];
    for (const c of cuts) {
      const last = merged[merged.length - 1];
      const gapStart = last ? last[1] : 0;
      if (c[0] - gapStart < p.minKeep) {
        if (last) last[1] = c[1];
        else merged.push([0, c[1]]);
      } else merged.push([c[0], c[1]]);
    }
    const last = merged[merged.length - 1];
    if (duration - last[1] < p.minKeep) last[1] = duration;
    cuts = merged;
  }

  const keeps: Range[] = [];
  let pos = 0;
  for (const [s, e] of cuts) {
    if (s > pos) keeps.push([pos, s]);
    pos = e;
  }
  if (pos < duration) keeps.push([pos, duration]);
  const keptDuration = keeps.reduce((a, [s, e]) => a + e - s, 0);
  return { cuts, keeps, duration, keptDuration };
}

/**
 * Picks a threshold between the noise floor and speech level using Otsu's
 * method on the distribution of window loudness in dB.
 */
export function autoThreshold(env: Envelope): number {
  const MIN_DB = -90;
  const bins = new Float64Array(91);
  let total = 0;
  for (let i = 0; i < env.rms.length; i++) {
    const r = env.rms[i];
    if (r <= 0) continue; // digital silence carries no information about the noise floor
    const db = Math.max(MIN_DB, 20 * Math.log10(r));
    bins[Math.min(90, Math.floor(db - MIN_DB))]++;
    total++;
  }
  if (!total) return DEFAULT_PARAMS.threshold;
  let sumAll = 0;
  for (let i = 0; i < bins.length; i++) sumAll += i * bins[i];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 45;
  for (let i = 0; i < bins.length; i++) {
    wB += bins[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * bins[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestT = i;
    }
  }
  // Otsu splits between the two clusters; bias slightly toward the noise floor
  // so quiet word endings are not clipped.
  const db = MIN_DB + bestT - 3;
  return Math.pow(10, db / 20);
}

export const toDb = (amp: number) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);
export const fromDb = (db: number) => Math.pow(10, db / 20);
