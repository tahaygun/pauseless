// Landing illustration: a speech waveform whose silent gaps close up, on a loop.

export function heroWave(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // Deterministic "speech": bursts separated by pauses.
  const bars: { h: number; silent: boolean }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (bars.length < 150) {
    const len = 6 + Math.floor(rnd() * 14);
    for (let i = 0; i < len; i++) {
      const env = Math.sin((i / len) * Math.PI);
      bars.push({ h: 0.25 + env * (0.45 + rnd() * 0.3), silent: false });
    }
    const gap = 3 + Math.floor(rnd() * 6);
    for (let i = 0; i < gap; i++) bars.push({ h: 0.03 + rnd() * 0.03, silent: true });
  }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let start = performance.now();

  const draw = (now: number) => {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 0..1 hold, 1..2 collapse, 2..3.5 hold collapsed, then restart
    const t = reduce ? 0.6 : ((now - start) / 1000) % 4.5;
    const collapse = t < 1 ? 0 : t < 2 ? ease(t - 1) : t < 3.8 ? 1 : 1 - ease((t - 3.8) / 0.7);
    const n = bars.length;
    const unit = w / (n - bars.filter((b) => b.silent).length * collapse * 0.999);
    const bw = Math.max(1.5, unit * 0.62);
    const mid = h / 2;
    const wave = css('--wave');
    const cut = css('--cut-edge');
    let x = 0;
    for (const b of bars) {
      const width = b.silent ? unit * (1 - collapse) : unit;
      if (b.silent) {
        if (width > 0.5) {
          ctx.fillStyle = cut;
          ctx.globalAlpha = 0.35 * (1 - collapse);
          ctx.fillRect(x, 0, width + 0.5, h);
          ctx.globalAlpha = 1;
        }
      } else {
        const bh = b.h * h * 0.8;
        ctx.fillStyle = wave;
        ctx.beginPath();
        ctx.roundRect(x + (unit - bw) / 2, mid - bh / 2, bw, bh, bw / 2);
        ctx.fill();
      }
      x += width;
      if (x > w) break;
    }
    if (!reduce && canvas.isConnected && canvas.offsetParent) requestAnimationFrame(draw);
    else if (!reduce) setTimeout(() => requestAnimationFrame(draw), 500);
  };
  requestAnimationFrame(draw);
  return () => (start = performance.now());
}

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
