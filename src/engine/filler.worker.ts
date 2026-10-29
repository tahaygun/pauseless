// Runs the filler-sound CNN over one chunk of normalized log-mel frames.

export interface ConvLayer {
  w: Float32Array; // [out][in][k]
  b: Float32Array;
  inCh: number;
  outCh: number;
  k: number;
  dil: number;
}

export interface FillerJob {
  mel: Float32Array; // frames x bands, already normalized
  frames: number;
  bands: number;
  layers: ConvLayer[]; // last layer has no ReLU
  /** frames of context at each end that are computed but not returned */
  padL: number;
  padR: number;
}

self.onmessage = (e: MessageEvent<FillerJob>) => {
  const { mel, frames, bands, layers, padL, padR } = e.data;
  let x = mel;
  let ch = bands;
  layers.forEach((L, li) => {
    // Reorder weights to [k][in][out] so the inner loop runs over contiguous outputs.
    const W = new Float32Array(L.w.length);
    for (let o = 0; o < L.outCh; o++)
      for (let i = 0; i < L.inCh; i++)
        for (let k = 0; k < L.k; k++) W[(k * L.inCh + i) * L.outCh + o] = L.w[(o * L.inCh + i) * L.k + k];
    const out = new Float32Array(frames * L.outCh);
    const half = ((L.k - 1) / 2) * L.dil;
    const last = li === layers.length - 1;
    const oc = L.outCh;
    for (let t = 0; t < frames; t++) {
      const o0 = t * oc;
      for (let o = 0; o < oc; o++) out[o0 + o] = L.b[o];
      for (let k = 0; k < L.k; k++) {
        const ts = t + k * L.dil - half;
        if (ts < 0 || ts >= frames) continue;
        const i0 = ts * ch;
        const wk = k * ch * oc;
        for (let i = 0; i < ch; i++) {
          const xv = x[i0 + i];
          if (xv === 0) continue; // ReLU outputs are often zero
          const wb = wk + i * oc;
          for (let o = 0; o < oc; o++) out[o0 + o] += W[wb + o] * xv;
        }
      }
      if (!last) for (let o = 0; o < oc; o++) if (out[o0 + o] < 0) out[o0 + o] = 0;
    }
    x = out;
    ch = oc;
  });
  const prob = new Float32Array(frames - padL - padR);
  for (let t = 0; t < prob.length; t++) prob[t] = 1 / (1 + Math.exp(-x[t + padL]));
  (self as unknown as Worker).postMessage(prob, [prob.buffer]);
};
