// Ported from stablyai/orca (MIT): container client-size delta check and rAF stability scheduler on reveal.

export const MAX_STABILITY_FRAMES = 8;

/** Read rendered client pixel box with JSDOM clientWidth/clientHeight fallback when getBoundingClientRect is zeroed. */
export function readContainerClientSize(container) {
  if (!container) return { width: 0, height: 0 };
  const rect = typeof container.getBoundingClientRect === 'function'
    ? container.getBoundingClientRect()
    : null;
  const rectWidth = rect ? Math.round(Number(rect.width) || 0) : 0;
  const rectHeight = rect ? Math.round(Number(rect.height) || 0) : 0;
  const clientWidth = Math.round(Number(container.clientWidth) || 0);
  const clientHeight = Math.round(Number(container.clientHeight) || 0);
  return {
    width: rectWidth > 0 ? rectWidth : clientWidth,
    height: rectHeight > 0 ? rectHeight : clientHeight,
  };
}

export function containerClientSizeChanged(prev, next, tolerance = 2) {
  if (!prev || !next) return true;
  if (prev.width <= 0 || prev.height <= 0 || next.width <= 0 || next.height <= 0) return true;
  return Math.abs(prev.width - next.width) > tolerance || Math.abs(prev.height - next.height) > tolerance;
}

/** Defer post-reveal fit until container box stabilizes for two animation frames (bounded by maxFrames). */
export function createStableGridScheduler(options = {}) {
  const requestFrame = options.requestFrame
    || (typeof globalThis.requestAnimationFrame === 'function'
      ? fn => globalThis.requestAnimationFrame(fn)
      : fn => globalThis.setTimeout(fn, 16));
  const cancelFrame = options.cancelFrame
    || (typeof globalThis.cancelAnimationFrame === 'function'
      ? id => globalThis.cancelAnimationFrame(id)
      : id => globalThis.clearTimeout(id));
  const measure = options.measure;
  const onStable = options.onStable;
  const maxFrames = Number.isFinite(options.maxFrames) && options.maxFrames >= 1
    ? options.maxFrames
    : MAX_STABILITY_FRAMES;

  let handle = null;
  let frameCount = 0;
  let lastSize = null;

  const cancel = () => {
    if (handle != null) {
      cancelFrame(handle);
      handle = null;
    }
    frameCount = 0;
    lastSize = null;
  };

  const step = () => {
    handle = null;
    frameCount += 1;
    const size = measure ? measure() : null;
    if (!size || size.width <= 0 || size.height <= 0) {
      if (frameCount < maxFrames) {
        handle = requestFrame(step);
      } else {
        cancel();
      }
      return;
    }
    const stable = lastSize && lastSize.width === size.width && lastSize.height === size.height;
    lastSize = size;
    if (stable || frameCount >= maxFrames) {
      frameCount = 0;
      lastSize = null;
      onStable?.(size);
      return;
    }
    handle = requestFrame(step);
  };

  return {
    get active() {
      return handle != null;
    },
    schedule() {
      cancel();
      handle = requestFrame(step);
    },
    cancel,
  };
}
