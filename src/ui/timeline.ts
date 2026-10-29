import type { Envelope } from '../engine/analyze';
import type { Range } from '../engine/silence';

const RULER = 20;
const DB_FLOOR = -66;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Maps amplitude to 0..1 on a dB scale so quiet passages and the threshold are visible. */
const level = (amp: number) => (amp <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(amp) - DB_FLOOR) / -DB_FLOOR)));

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private env?: Envelope;
  private duration = 0;
  private cuts: Range[] = [];
  private threshold = 0;
  private fillers: Range[] = [];
  private keptFillers = new Set<number>();
  private viewStart = 0;
  private viewDur = 1;
  private time = 0;
  private raf = 0;
  onSeek?: (t: number) => void;
  /** Called with the index of a filler the user clicked. */
  onFillerClick?: (index: number) => void;
  onViewChange?: (zoom: number) => void;

  constructor(private root: HTMLElement, private canvas: HTMLCanvasElement, private playhead: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(root);
    this.bindPointer();
  }

  setMedia(env: Envelope, duration: number) {
    this.env = env;
    this.duration = duration;
    this.viewStart = 0;
    this.viewDur = duration;
    this.draw();
  }

  setCuts(cuts: Range[], threshold: number, fillers: Range[] = [], keptFillers = new Set<number>()) {
    this.cuts = cuts;
    this.threshold = threshold;
    this.fillers = fillers;
    this.keptFillers = keptFillers;
    this.draw();
  }

  setTime(t: number, follow: boolean) {
    this.time = t;
    if (follow && (t < this.viewStart || t > this.viewStart + this.viewDur)) {
      this.viewStart = this.clampStart(t - this.viewDur * 0.1);
      this.draw();
    }
    this.placePlayhead();
  }

  /** zoom: 0 = whole file, 1 = ~5 seconds visible */
  setZoom(z: number, anchorFrac = 0.5) {
    if (!this.duration) return;
    const min = Math.min(5, this.duration);
    const dur = this.duration * Math.pow(min / this.duration, z);
    const anchor = this.viewStart + this.viewDur * anchorFrac;
    this.viewDur = dur;
    this.viewStart = this.clampStart(anchor - dur * anchorFrac);
    this.draw();
  }

  get zoom() {
    const min = Math.min(5, this.duration);
    if (this.duration <= min) return 0;
    return Math.log(this.viewDur / this.duration) / Math.log(min / this.duration);
  }

  private clampStart(s: number) {
    return Math.max(0, Math.min(this.duration - this.viewDur, s));
  }

  private bindPointer() {
    const toTime = (e: PointerEvent | WheelEvent) => {
      const r = this.root.getBoundingClientRect();
      return this.viewStart + ((e.clientX - r.left) / r.width) * this.viewDur;
    };
    let dragging = false;
    this.root.addEventListener('pointerdown', (e) => {
      if (!this.duration) return;
      const t = toTime(e);
      const r = this.root.getBoundingClientRect();
      if (e.clientY - r.top > RULER) {
        const hit = this.fillers.findIndex(([s, en]) => t >= s && t <= en);
        if (hit >= 0 && this.onFillerClick) {
          this.onFillerClick(hit);
          return;
        }
      }
      dragging = true;
      this.root.setPointerCapture(e.pointerId);
      this.onSeek?.(Math.max(0, Math.min(this.duration, t)));
    });
    this.root.addEventListener('pointermove', (e) => {
      if (dragging) this.onSeek?.(Math.max(0, Math.min(this.duration, toTime(e))));
    });
    this.root.addEventListener('pointerup', () => (dragging = false));
    this.root.addEventListener(
      'wheel',
      (e) => {
        if (!this.duration) return;
        e.preventDefault();
        const r = this.root.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          const frac = (e.clientX - r.left) / r.width;
          this.setZoom(Math.max(0, Math.min(1, this.zoom - e.deltaY * 0.002)), frac);
          this.onViewChange?.(this.zoom);
        } else {
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.viewStart = this.clampStart(this.viewStart + (d / r.width) * this.viewDur);
          this.draw();
        }
      },
      { passive: false },
    );
  }

  private placePlayhead() {
    if (!this.duration) {
      this.playhead.style.display = 'none';
      return;
    }
    const f = (this.time - this.viewStart) / this.viewDur;
    this.playhead.style.display = f >= 0 && f <= 1 ? 'block' : 'none';
    this.playhead.style.left = `${f * 100}%`;
  }

  draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  private render() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    this.placePlayhead();
    if (!this.env || !this.duration) return;

    const { viewStart: vs, viewDur: vd } = this;
    const pxPerSec = w / vd;

    // Ruler
    c.fillStyle = css('--muted');
    c.strokeStyle = css('--border');
    c.font = '11px system-ui, sans-serif';
    c.textBaseline = 'middle';
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => s * pxPerSec >= 70) ?? 7200;
    c.beginPath();
    for (let t = Math.ceil(vs / step) * step; t <= vs + vd; t += step) {
      const x = Math.round((t - vs) * pxPerSec) + 0.5;
      c.moveTo(x, RULER - 6);
      c.lineTo(x, RULER);
      c.fillText(formatRuler(t, step), x + 4, RULER / 2);
    }
    c.moveTo(0, RULER + 0.5);
    c.lineTo(w, RULER + 0.5);
    c.stroke();

    // Waveform: peak (faint) and RMS (solid), mirrored around the middle.
    const { rms, peak, rate } = this.env;
    const top = RULER + 4;
    const mid = top + (h - top - 4) / 2;
    const half = (h - top - 4) / 2;
    const colWave = css('--wave');
    c.fillStyle = colWave;
    for (let x = 0; x < w; x++) {
      const t0 = vs + x / pxPerSec;
      const i0 = Math.floor(t0 * rate);
      const i1 = Math.max(i0 + 1, Math.floor((t0 + 1 / pxPerSec) * rate));
      let p = 0;
      let r = 0;
      for (let i = i0; i < i1 && i < rms.length; i++) {
        if (peak[i] > p) p = peak[i];
        if (rms[i] > r) r = rms[i];
      }
      const ph = level(p) * half;
      const rh = level(r) * half;
      c.globalAlpha = 0.35;
      c.fillRect(x, mid - ph, 1, ph * 2 || 1);
      c.globalAlpha = 1;
      c.fillRect(x, mid - rh, 1, rh * 2 || 1);
    }

    // Cuts
    c.fillStyle = css('--cut');
    c.strokeStyle = css('--cut-edge');
    for (const [s, e] of visible(this.cuts, vs, vs + vd)) {
      const x0 = (s - vs) * pxPerSec;
      const x1 = (e - vs) * pxPerSec;
      c.fillRect(x0, top - 4, Math.max(1, x1 - x0), h - top + 4);
      if (x1 - x0 > 3) {
        c.beginPath();
        c.moveTo(Math.round(x0) + 0.5, top - 4);
        c.lineTo(Math.round(x0) + 0.5, h);
        c.moveTo(Math.round(x1) - 0.5, top - 4);
        c.lineTo(Math.round(x1) - 0.5, h);
        c.stroke();
      }
    }

    // Filler sounds: filled when cut, outlined when the user keeps them
    for (let i = 0; i < this.fillers.length; i++) {
      const [s, e] = this.fillers[i];
      if (e < vs || s > vs + vd) continue;
      const x0 = (s - vs) * pxPerSec;
      const w = Math.max(2, (e - s) * pxPerSec);
      if (this.keptFillers.has(i)) {
        c.strokeStyle = css('--filler-edge');
        c.setLineDash([3, 3]);
        c.strokeRect(Math.round(x0) + 0.5, top - 3.5, Math.round(w) - 1, h - top + 2);
        c.setLineDash([]);
      } else {
        c.fillStyle = css('--filler');
        c.fillRect(x0, top - 4, w, h - top + 4);
        c.fillStyle = css('--filler-edge');
        c.fillRect(x0, top - 4, w, 3);
      }
    }

    // Threshold
    const th = level(this.threshold) * half;
    c.strokeStyle = css('--threshold');
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(0, Math.round(mid - th) + 0.5);
    c.lineTo(w, Math.round(mid - th) + 0.5);
    c.moveTo(0, Math.round(mid + th) + 0.5);
    c.lineTo(w, Math.round(mid + th) + 0.5);
    c.stroke();
    c.setLineDash([]);
  }
}

function* visible(cuts: Range[], a: number, b: number) {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (cuts[m][1] < a) lo = m + 1;
    else hi = m;
  }
  for (let i = lo; i < cuts.length && cuts[i][0] <= b; i++) yield cuts[i];
}

function formatRuler(t: number, step: number) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = step < 1 ? s.toFixed(step < 0.5 ? 2 : 1) : String(Math.round(s));
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return s ? `${m}m${ss}s` : `${m}m`;
  return `${ss}s`;
}
