import { analyze, type Analysis } from './engine/analyze';
import { autoThreshold, DEFAULT_PARAMS, detect, fromDb, toDb, type CutResult, type SilenceParams } from './engine/silence';
import { Timeline } from './ui/timeline';
import { formatTime, formatDuration } from './ui/format';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('video');
const playBtn = $<HTMLButtonElement>('playBtn');
const skipCuts = $<HTMLInputElement>('skipCuts');
const timecode = $('timecode');
const stats = $('stats');
const mediaInfo = $('mediaInfo');
const busy = $('busy');
const busyText = $('busyText');
const dropHint = $('dropHint');
const zoom = $<HTMLInputElement>('zoom');
const autoBox = $<HTMLInputElement>('autoThreshold');
const padLink = $<HTMLInputElement>('padLink');

const timeline = new Timeline($('timeline'), $<HTMLCanvasElement>('timelineCanvas'), $('playhead'));

interface State {
  file?: File;
  analysis?: Analysis;
  auto: number;
  params: SilenceParams;
  result?: CutResult;
}

const STORE_KEY = 'recut.params.v1';
const state: State = { auto: DEFAULT_PARAMS.threshold, params: loadParams() };

function loadParams(): SilenceParams {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      autoBox.checked = saved.autoThreshold ?? true;
      padLink.checked = saved.padLinked ?? true;
      return { ...DEFAULT_PARAMS, ...saved.params };
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_PARAMS };
}

function saveParams() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ params: state.params, autoThreshold: autoBox.checked, padLinked: padLink.checked }),
    );
  } catch {
    /* storage unavailable */
  }
}

// ---------- Parameter controls ----------

type Key = keyof SilenceParams;
interface Control {
  key: Key;
  range: HTMLInputElement;
  num: HTMLInputElement;
  toUi: (v: number) => number;
  fromUi: (v: number) => number;
  digits: number;
}

const id = (v: number) => v;
const controls: Control[] = (
  [
    { key: 'threshold', toUi: toDb, fromUi: fromDb, digits: 1 },
    { key: 'minSilence', toUi: id, fromUi: id, digits: 2 },
    { key: 'padLeft', toUi: id, fromUi: id, digits: 2 },
    { key: 'padRight', toUi: id, fromUi: id, digits: 2 },
    { key: 'minKeep', toUi: id, fromUi: id, digits: 2 },
  ] as const
).map((c) => ({ ...c, range: $<HTMLInputElement>(c.key), num: $<HTMLInputElement>(c.key + 'Num') }));

function syncControls() {
  for (const c of controls) {
    const v = c.toUi(state.params[c.key]);
    c.range.value = String(v);
    if (document.activeElement !== c.num) c.num.value = v.toFixed(c.digits);
  }
  const th = controls[0];
  th.range.disabled = th.num.disabled = autoBox.checked;
}

for (const c of controls) {
  const set = (raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    state.params[c.key] = Math.max(0, c.fromUi(v));
    if (padLink.checked && (c.key === 'padLeft' || c.key === 'padRight')) {
      state.params.padLeft = state.params.padRight = state.params[c.key];
    }
    update();
  };
  c.range.addEventListener('input', () => set(c.range.value));
  c.num.addEventListener('input', () => set(c.num.value));
  c.num.addEventListener('blur', syncControls);
}

autoBox.addEventListener('change', () => {
  if (autoBox.checked) state.params.threshold = state.auto;
  update();
});
padLink.addEventListener('change', () => {
  if (padLink.checked) state.params.padRight = state.params.padLeft;
  update();
});
$('resetParams').addEventListener('click', () => {
  state.params = { ...DEFAULT_PARAMS, threshold: state.auto };
  autoBox.checked = true;
  padLink.checked = true;
  update();
});

function update() {
  syncControls();
  saveParams();
  const a = state.analysis;
  if (!a) return;
  state.result = detect(a.envelope, a.media.duration, state.params);
  timeline.setCuts(state.result.cuts, state.params.threshold);
  const r = state.result;
  stats.innerHTML =
    `duration <b>${formatDuration(r.duration)}</b> – <b>${formatDuration(r.keptDuration)}</b> without silence – ` +
    `<b>${r.cuts.length}</b> cuts`;
}

// ---------- Tabs ----------

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document
      .querySelectorAll<HTMLElement>('.tab-body')
      .forEach((b) => (b.hidden = b.dataset.body !== tab.dataset.tab));
  }),
);

// ---------- File loading ----------

$<HTMLInputElement>('fileInput').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) open(f);
});

const wrap = $('videoWrap');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  wrap.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) wrap.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  wrap.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) open(f);
});

let objectUrl = '';
async function open(file: File) {
  state.file = file;
  state.analysis = undefined;
  $('fileName').textContent = file.name;
  dropHint.hidden = true;
  busy.hidden = false;
  busyText.textContent = 'Analyzing audio…';
  playBtn.disabled = true;
  video.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  try {
    const a = await analyze(file, (p) => (busyText.textContent = `Analyzing audio… ${Math.round(p * 100)}%`));
    state.analysis = a;
    state.auto = autoThreshold(a.envelope);
    if (autoBox.checked) state.params.threshold = state.auto;
    timeline.setMedia(a.envelope, a.media.duration);
    zoom.value = '0';
    const v = a.media.video;
    const au = a.media.audio;
    mediaInfo.textContent = [
      v ? `${v.width}×${v.height} · ${Math.round(v.fps * 100) / 100} fps` : 'audio only',
      `${au.sampleRate / 1000} kHz`,
      `analyzed in ${(a.timings.total / 1000).toFixed(1)} s`,
    ].join(' · ');
    playBtn.disabled = false;
    update();
    (window as unknown as { recutReady: Analysis }).recutReady = a;
  } catch (err) {
    toast((err as Error).message || String(err));
    dropHint.hidden = false;
  } finally {
    busy.hidden = true;
  }
}

// ---------- Playback ----------

function cutAt(t: number) {
  const cuts = state.result?.cuts;
  if (!cuts) return undefined;
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cuts[m][1] <= t) lo = m + 1;
    else if (cuts[m][0] > t) hi = m - 1;
    else return cuts[m];
  }
  return undefined;
}

function tick() {
  let t = video.currentTime;
  if (!video.paused && skipCuts.checked) {
    // Look slightly ahead so we jump before the cut is audible.
    const c = cutAt(t + 0.02);
    if (c) {
      t = c[1];
      video.currentTime = t;
    }
  }
  timecode.textContent = formatTime(t);
  timeline.setTime(t, !video.paused);
  if (!video.paused) requestAnimationFrame(tick);
}

video.addEventListener('play', () => {
  playBtn.textContent = '❚❚';
  requestAnimationFrame(tick);
});
video.addEventListener('pause', () => (playBtn.textContent = '▶'));
video.addEventListener('seeked', tick);
video.addEventListener('ended', () => (playBtn.textContent = '▶'));
playBtn.addEventListener('click', togglePlay);

function togglePlay() {
  if (!state.analysis) return;
  if (video.paused) void video.play();
  else video.pause();
}

timeline.onSeek = (t) => {
  video.currentTime = t;
  timeline.setTime(t, false);
  timecode.textContent = formatTime(t);
};
timeline.onViewChange = (z) => (zoom.value = String(z));
zoom.addEventListener('input', () => timeline.setZoom(parseFloat(zoom.value)));

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const d = (e.shiftKey ? 5 : 1) * (e.code === 'ArrowLeft' ? -1 : 1);
    timeline.onSeek?.(Math.max(0, Math.min(video.duration || 0, video.currentTime + d)));
  }
});

function toast(msg: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

syncControls();
