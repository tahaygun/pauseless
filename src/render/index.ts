import type { MediaInfo } from '../engine/container';
import type { RenderJob, RenderMessage } from './render.worker';
import RenderWorker from './render.worker?worker&inline';

export interface RenderResult {
  buffer?: ArrayBuffer;
  elapsed: number;
  frames: number;
}

/** Average source video bitrate, used so the output keeps similar quality. */
export function sourceBitrate(media: MediaInfo) {
  const v = media.video;
  if (!v || !v.duration) return 8e6;
  let bytes = 0;
  for (let i = 0; i < v.sizes.length; i++) bytes += v.sizes[i];
  return Math.min(60e6, Math.max(2e6, Math.round((bytes * 8) / v.duration)));
}

export function render(
  job: RenderJob,
  onProgress: (done: number, fps: number) => void,
): { promise: Promise<RenderResult>; cancel: () => void } {
  const w = new RenderWorker();
  let reject!: (e: Error) => void;
  const promise = new Promise<RenderResult>((res, rej) => {
    reject = rej;
    w.onmessage = (e: MessageEvent<RenderMessage>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.done, m.fps);
      else {
        w.terminate();
        if (m.type === 'done') res({ buffer: m.buffer, elapsed: m.elapsed, frames: m.frames });
        else rej(new Error(m.error));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      rej(new Error(e.message || 'Render failed'));
    };
  });
  w.postMessage(job);
  return {
    promise,
    cancel: () => {
      w.terminate();
      reject(new Error('cancelled'));
    },
  };
}

