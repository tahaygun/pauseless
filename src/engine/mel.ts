// Log-mel features for the filler detector. Must match the training
// reference exactly: audio resampled to 16 kHz, 40 bands 60-7600 Hz,
// 25 ms Hann window, 20 ms hop, power spectrum averaged per band, natural log.

export const MEL_BANDS = 40;
export const MEL_HOP = 0.02; // seconds
export const MEL_WIN = 0.025;
export const MEL_RATE = 16000;

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

export function melParams(sr: number) {
  const win = Math.round(MEL_WIN * sr);
  const hop = Math.round(MEL_HOP * sr);
  let nfft = 1;
  while (nfft < win) nfft *= 2;
  return { win, hop, nfft };
}

interface Band {
  lo: number;
  w: Float32Array;
}

/**
 * Streams mono audio at any rate down to 16 kHz: a short box filter
 * (length = rounded rate ratio) followed by linear interpolation.
 */
class Resampler {
  private ratio: number;
  private taps: number;
  private hist: Float32Array;
  private histPos = 0;
  private histSum = 0;
  private inIdx = -1; // absolute index of the next input sample
  private prev = 0; // filtered value of input sample inIdx-1
  private outIdx = 0; // next output sample (absolute, at 16 kHz)
  private out = new Float32Array(4096);
  constructor(private sr: number) {
    this.ratio = sr / MEL_RATE;
    this.taps = Math.max(1, Math.round(this.ratio));
    this.hist = new Float32Array(this.taps);
  }
  /** Returns [samples, count, absolute start index at 16 kHz] */
  push(x: Float32Array, n: number, start: number): [Float32Array, number, number] {
    if (this.inIdx !== start) {
      this.inIdx = start;
      this.hist.fill(0);
      this.histSum = 0;
      this.prev = 0;
      this.outIdx = Math.ceil(start / this.ratio);
    }
    const first = this.outIdx;
    const maxOut = Math.ceil(n / this.ratio) + 2;
    if (this.out.length < maxOut) this.out = new Float32Array(maxOut);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const old = this.hist[this.histPos];
      this.hist[this.histPos] = x[i];
      this.histPos = (this.histPos + 1) % this.taps;
      this.histSum += x[i] - old;
      const cur = this.histSum / this.taps;
      const abs = this.inIdx + i; // index of cur
      // emit outputs whose input position lies in (abs-1, abs]
      for (;;) {
        const pos = this.outIdx * this.ratio;
        if (pos > abs) break;
        const frac = pos - (abs - 1);
        this.out[count++] = frac >= 1 ? cur : this.prev + (cur - this.prev) * Math.max(0, frac);
        this.outIdx++;
      }
      this.prev = cur;
    }
    this.inIdx += n;
    return [this.out, count, first];
  }
}

/** Streams mono samples (with absolute sample positions) into log-mel frames. */
export class MelStream {
  readonly win: number;
  readonly hop: number;
  private nfft: number;
  private window: Float32Array;
  private norm: number;
  private bands: Band[] = [];
  private re: Float64Array;
  private im: Float64Array;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;
  private buf: Float32Array;
  private bufStart = -1; // absolute sample index of buf[0]
  private bufLen = 0;
  /** frames[k - firstFrame] */
  frames: Float32Array[] = [];
  firstFrame = -1;

  private resampler?: Resampler;
  private srcExpected = -1;

  constructor(srcRate: number) {
    if (srcRate !== MEL_RATE) this.resampler = new Resampler(srcRate);
    const sr = MEL_RATE;
    const { win, hop, nfft } = melParams(sr);
    this.win = win;
    this.hop = hop;
    this.nfft = nfft;
    this.window = new Float32Array(win);
    let norm = 0;
    for (let i = 0; i < win; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
      norm += this.window[i] ** 2;
    }
    this.norm = norm;
    const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
      mel2hz(hz2mel(60) + ((hz2mel(7600) - hz2mel(60)) * i) / (MEL_BANDS + 1)),
    );
    const nb = nfft / 2 + 1;
    for (let b = 0; b < MEL_BANDS; b++) {
      const w: number[] = [];
      let lo = -1;
      let sum = 0;
      for (let k = 0; k < nb; k++) {
        const f = (k * sr) / nfft;
        const v = Math.max(0, Math.min((f - edges[b]) / (edges[b + 1] - edges[b]), (edges[b + 2] - f) / (edges[b + 2] - edges[b + 1])));
        if (v > 0) {
          if (lo < 0) lo = k;
          w[k - lo] = v;
          sum += v;
        } else if (lo >= 0 && k > lo) w[k - lo] = 0;
      }
      // trim trailing zeros
      while (w.length && w[w.length - 1] === 0) w.pop();
      this.bands.push({ lo: Math.max(0, lo), w: Float32Array.from(w, (x) => (x || 0) / (sum || 1)) });
    }
    this.re = new Float64Array(nfft);
    this.im = new Float64Array(nfft);
    this.cos = new Float64Array(nfft / 2);
    this.sin = new Float64Array(nfft / 2);
    for (let i = 0; i < nfft / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / nfft);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / nfft);
    }
    const bits = Math.log2(nfft);
    this.rev = new Uint32Array(nfft);
    for (let i = 0; i < nfft; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.buf = new Float32Array(win + 16384);
  }

  /** Feed mono samples at the source rate starting at absolute (source) sample index `start`. */
  push(samples: Float32Array, n: number, start: number) {
    // Timestamps are rounded to microseconds, so allow a couple of samples of jitter.
    if (this.srcExpected >= 0 && Math.abs(start - this.srcExpected) <= 2) start = this.srcExpected;
    this.srcExpected = start + n;
    if (this.resampler) [samples, n, start] = this.resampler.push(samples, n, start);
    this.pushRate(samples, n, start);
  }

  private pushRate(samples: Float32Array, n: number, start: number) {
    const expected = this.bufStart + this.bufLen;
    if (this.bufStart < 0 || start !== expected) {
      this.bufStart = start;
      this.bufLen = 0;
    }
    if (this.bufLen + n > this.buf.length) {
      const nb = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + n));
      nb.set(this.buf.subarray(0, this.bufLen));
      this.buf = nb;
    }
    this.buf.set(samples.subarray(0, n), this.bufLen);
    this.bufLen += n;

    let k = Math.ceil(this.bufStart / this.hop);
    for (; k * this.hop + this.win <= this.bufStart + this.bufLen; k++) {
      this.frame(k, k * this.hop - this.bufStart);
    }
    // drop consumed samples
    const keepFrom = k * this.hop - this.bufStart;
    if (keepFrom > 0) {
      const drop = Math.min(keepFrom, this.bufLen);
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.bufStart += drop;
    }
  }

  private frame(k: number, off: number) {
    if (k < 0) return;
    const { re, im, nfft, win, window, rev } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < win; i++) re[rev[i]] = this.buf[off + i] * window[i];
    // iterative radix-2 FFT (input already bit-reversed)
    for (let size = 2; size <= nfft; size <<= 1) {
      const half = size >> 1;
      const step = nfft / size;
      for (let s = 0; s < nfft; s += size) {
        for (let j = 0; j < half; j++) {
          const c = this.cos[j * step];
          const sn = this.sin[j * step];
          const a = s + j;
          const b = a + half;
          const tr = re[b] * c - im[b] * sn;
          const ti = re[b] * sn + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const out = new Float32Array(MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      const { lo, w } = this.bands[b];
      let s = 0;
      for (let i = 0; i < w.length; i++) {
        const q = lo + i;
        s += w[i] * (re[q] * re[q] + im[q] * im[q]);
      }
      out[b] = Math.log(s / this.norm + 1e-8);
    }
    if (this.firstFrame < 0) this.firstFrame = k;
    const idx = k - this.firstFrame;
    if (idx >= 0) this.frames[idx] = out;
  }
}
