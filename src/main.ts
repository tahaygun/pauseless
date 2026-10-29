import { analyze, type Analysis } from './engine/analyze';
import { autoThreshold, combine, DEFAULT_PARAMS, detect, fromDb, toDb, type CutResult, type SilenceParams } from './engine/silence';
import { Timeline } from './ui/timeline';
import { formatTime, formatDuration } from './ui/format';
import { heroWave } from './ui/heroWave';
import { exportTimeline, HOWTO, type ExportKind } from './export';
import { download, joinPath } from './export/common';
import { render, sourceBitrate } from './render';
import { fillerProbabilities, fillerRanges } from './engine/fillers';
import type { Range } from './engine/silence';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('video');
const playBtn = $<HTMLButtonElement>('playBtn');
const skipCuts = $<HTMLInputElement>('skipCuts');
const timecode = $('timecode');
const stats = $('stats');
const mediaInfo = $('mediaInfo');
const busy = $('busy');
const busyText = $('busyText');
const landing = $('landing');
const appEl = $('app');
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
  fillerProb?: Float32Array;
  fillers: Range[];
  keptFillers: Set<number>;
}

const STORE_KEY = 'pauseless.params.v1';
const removeFillers = $<HTMLInputElement>('removeFillers');
const fillerSens = $<HTMLInputElement>('fillerSens');
const fillerInfo = $('fillerInfo');
const state: State = { auto: DEFAULT_PARAMS.threshold, params: loadParams(), fillers: [], keptFillers: new Set() };

function loadParams(): SilenceParams {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      autoBox.checked = saved.autoThreshold ?? true;
      removeFillers.checked = saved.removeFillers ?? true;
      fillerSens.value = String(saved.fillerSens ?? 0.5);
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
      JSON.stringify({
        params: state.params,
        autoThreshold: autoBox.checked,
        padLinked: padLink.checked,
        removeFillers: removeFillers.checked,
        fillerSens: parseFloat(fillerSens.value),
      }),
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
  const silence = detect(a.envelope, a.media.duration, state.params);
  let fillerCuts: Range[] = [];
  if (state.fillerProb) {
    const prev = state.fillers;
    const next = fillerRanges(state.fillerProb, 0.9 - 0.5 * parseFloat(fillerSens.value));
    // keep the user's choices for fillers that are still detected
    const kept = new Set<number>();
    next.forEach(([s, e], i) => {
      if (prev.some(([ps, pe], j) => state.keptFillers.has(j) && ps < e && pe > s)) kept.add(i);
    });
    state.fillers = next;
    state.keptFillers = kept;
    if (removeFillers.checked) fillerCuts = next.filter((_, i) => !kept.has(i));
    const n = next.length;
    fillerInfo.innerHTML = n
      ? `<b>${n}</b> filler sound${n === 1 ? '' : 's'} found${kept.size ? `, ${kept.size} kept` : ''}`
      : 'No filler sounds found';
  }
  state.result = combine(silence, fillerCuts);
  timeline.setCuts(state.result.cuts, state.params.threshold, removeFillers.checked ? state.fillers : [], state.keptFillers);
  const r = state.result;
  stats.innerHTML =
    `duration <b>${formatDuration(r.duration)}</b> – <b>${formatDuration(r.keptDuration)}</b> after cuts – ` +
    `<b>${r.cuts.length}</b> cuts`;
}

removeFillers.addEventListener('change', update);
fillerSens.addEventListener('input', update);
timeline.onFillerClick = (i) => {
  if (state.keptFillers.has(i)) state.keptFillers.delete(i);
  else state.keptFillers.add(i);
  update();
};

// ---------- Export ----------

const mediaFolder = $<HTMLInputElement>('mediaFolder');
const FOLDER_KEY = 'pauseless.mediaFolder';
try {
  mediaFolder.value = localStorage.getItem(FOLDER_KEY) ?? '';
} catch {
  /* storage unavailable */
}
mediaFolder.addEventListener('input', () => {
  try {
    localStorage.setItem(FOLDER_KEY, mediaFolder.value);
  } catch {
    /* storage unavailable */
  }
});

const exportButtons = document.querySelectorAll<HTMLButtonElement>('[data-export]');
exportButtons.forEach((btn) =>
  btn.addEventListener('click', () => {
    const a = state.analysis;
    const r = state.result;
    if (!a || !r || !state.file) return;
    const kind = btn.dataset.export as ExportKind;
    exportTimeline(kind, {
      name: state.file.name,
      path: joinPath(mediaFolder.value, state.file.name),
      media: a.media,
      keeps: r.keeps,
    });
    $('exportHowto').innerHTML = HOWTO[kind];
  }),
);

const renderBtn = $<HTMLButtonElement>('renderBtn');
const renderStatus = $('renderStatus');
const renderBar = $('renderBar');
const renderText = $('renderText');
let cancelRender: (() => void) | undefined;

renderBtn.addEventListener('click', async () => {
  const a = state.analysis;
  const r = state.result;
  const file = state.file;
  if (!a || !r || !file) return;
  const name = `${file.name.replace(/\.[^.]+$/, '')} (Pauseless).mp4`;
  let handle: FileSystemFileHandle | undefined;
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker;
  if (picker) {
    try {
      handle = await picker({ suggestedName: name, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
    } catch {
      return; // user closed the save dialog
    }
  }
  renderBtn.disabled = true;
  renderStatus.hidden = false;
  renderBar.style.width = '0';
  renderText.textContent = 'Starting…';
  const job = render(
    { file, media: a.media, keeps: r.keeps, bitrate: sourceBitrate(a.media), handle },
    (done, fps) => {
      renderBar.style.width = `${(done * 100).toFixed(1)}%`;
      const left = fps > 0 ? ((1 - done) * r.keptDuration * (a.media.video?.fps ?? 30)) / fps : 0;
      renderText.textContent = `${Math.round(done * 100)}% · ${Math.round(fps)} fps · about ${formatDuration(left)} left`;
    },
  );
  cancelRender = job.cancel;
  try {
    const res = await job.promise;
    if (res.buffer) download(res.buffer, name, 'video/mp4');
    renderBar.style.width = '100%';
    renderText.textContent = `Done in ${formatDuration(res.elapsed / 1000)} (${res.frames} frames)`;
    (window as unknown as { recutRendered: unknown }).recutRendered = res;
  } catch (err) {
    const msg = (err as Error).message;
    renderText.textContent = msg === 'cancelled' ? 'Cancelled' : `Failed: ${msg}`;
  } finally {
    cancelRender = undefined;
    renderBtn.disabled = false;
  }
});
$('renderCancel').addEventListener('click', () => cancelRender?.());

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

for (const id of ['fileInput', 'landingInput']) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) open(f);
  });
}

function showLanding(show: boolean) {
  landing.hidden = !show;
  appEl.hidden = show;
  if (!show) requestAnimationFrame(() => timeline.draw());
}
$('homeLink').addEventListener('click', (e) => {
  e.preventDefault();
  video.pause();
  showLanding(true);
});
heroWave($<HTMLCanvasElement>('heroWave'));

const dropTargets = [$('videoWrap'), $('landingDrop')];
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropTargets.forEach((t) => t.classList.add('dragging'));
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropTargets.forEach((t) => t.classList.remove('dragging'));
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropTargets.forEach((t) => t.classList.remove('dragging'));
  const f = e.dataTransfer?.files?.[0];
  if (f) open(f);
});

let objectUrl = '';
async function open(file: File) {
  state.file = file;
  state.analysis = undefined;
  $('fileName').textContent = file.name;
  showLanding(false);
  busy.hidden = false;
  busyText.textContent = 'Analyzing audio…';
  playBtn.disabled = true;
  exportButtons.forEach((b) => (b.disabled = true));
  renderBtn.disabled = true;
  cancelRender?.();
  video.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  try {
    const a = await analyze(file, (p) => (busyText.textContent = `Analyzing audio… ${Math.round(p * 100)}%`));
    state.analysis = a;
    state.fillerProb = undefined;
    state.fillers = [];
    state.keptFillers = new Set();
    fillerInfo.textContent = 'Looking for filler sounds…';
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
    exportButtons.forEach((b) => (b.disabled = false));
    renderBtn.disabled = !a.media.video?.codecString;
    update();
    (window as unknown as { recutReady: Analysis }).recutReady = a;
    const tf = performance.now();
    fillerProbabilities(a.mel)
      .then((p) => {
        if (state.analysis !== a) return;
        state.fillerProb = p;
        (window as unknown as { fillerMs: number }).fillerMs = performance.now() - tf;
        update();
      })
      .catch((err) => (fillerInfo.textContent = `Filler detection failed: ${(err as Error).message}`));
  } catch (err) {
    toast((err as Error).message || String(err));
    showLanding(true);
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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Opened from the OS ("Open with Pauseless") when installed as an app
const launch = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } })
  .launchQueue;
launch?.setConsumer(async ({ files }) => {
  if (files.length) open(await files[0].getFile());
});
