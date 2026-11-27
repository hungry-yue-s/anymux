// Ported from stablyai/orca (MIT): hidden WebGL context LRU retention and delayed canvas backing release.

export const MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = 6;
export const HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS = 30_000;

const releasedBackingState = new WeakMap();

/** Release WebGL canvas GPU backing store while hidden while keeping original pixel dimensions for fast restore. */
export function releaseWebglCanvasBackingWhileHidden(canvas) {
  if (!canvas || releasedBackingState.has(canvas)) return false;
  const width = Number(canvas.width) || 0;
  const height = Number(canvas.height) || 0;
  releasedBackingState.set(canvas, { width, height });
  if (width > 0) canvas.width = 0;
  if (height > 0) canvas.height = 0;
  return true;
}

/** Clear hidden-release tracking for a canvas and return its saved backing pixel dimensions if any. */
export function stopReleasingWebglCanvasBacking(canvas) {
  if (!canvas) return null;
  const saved = releasedBackingState.get(canvas) || null;
  if (saved) releasedBackingState.delete(canvas);
  return saved;
}

export function isWebglCanvasBackingReleased(canvas) {
  return Boolean(canvas && releasedBackingState.has(canvas));
}

/** Create an LRU registry retaining WebGL contexts across hidden switches and releasing backing stores after delay. */
export function createHiddenWebglRetentionRegistry(options = {}) {
  const maxRetained = Number.isFinite(options.maxRetained) && options.maxRetained >= 0
    ? options.maxRetained
    : MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS;
  const releaseDelayMs = Number.isFinite(options.releaseDelayMs) && options.releaseDelayMs >= 0
    ? options.releaseDelayMs
    : HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS;
  const setTimer = options.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimeout || ((id) => globalThis.clearTimeout(id));
  const entries = new Map();

  const evictEntry = (key, record) => {
    entries.delete(key);
    if (record.releaseTimer != null) {
      clearTimer(record.releaseTimer);
      record.releaseTimer = null;
    }
    if (record.canvas) stopReleasingWebglCanvasBacking(record.canvas);
    record.dispose?.();
  };

  return {
    get size() {
      return entries.size;
    },
    has(key) {
      return entries.has(key);
    },
    retain(key, descriptor = {}) {
      if (maxRetained === 0) {
        descriptor.dispose?.();
        return false;
      }
      const existing = entries.get(key);
      if (existing) {
        if (existing.releaseTimer != null) clearTimer(existing.releaseTimer);
        entries.delete(key);
      }
      const canvas = descriptor.canvas || null;
      const record = {
        canvas,
        dispose: descriptor.dispose || null,
        onReleaseCanvas: descriptor.onReleaseCanvas || null,
        releaseTimer: null,
      };
      if (canvas && releaseDelayMs > 0) {
        record.releaseTimer = setTimer(() => {
          record.releaseTimer = null;
          if (!entries.has(key)) return;
          if (releaseWebglCanvasBackingWhileHidden(canvas)) {
            record.onReleaseCanvas?.(canvas);
          }
        }, releaseDelayMs);
      }
      entries.set(key, record);
      while (entries.size > maxRetained) {
        const oldestKey = entries.keys().next().value;
        const oldestRecord = entries.get(oldestKey);
        evictEntry(oldestKey, oldestRecord);
      }
      return true;
    },
    take(key) {
      const record = entries.get(key);
      if (!record) return null;
      entries.delete(key);
      if (record.releaseTimer != null) {
        clearTimer(record.releaseTimer);
        record.releaseTimer = null;
      }
      const savedBacking = record.canvas ? stopReleasingWebglCanvasBacking(record.canvas) : null;
      return {
        canvas: record.canvas,
        savedBacking,
      };
    },
    evict(key) {
      const record = entries.get(key);
      if (!record) return false;
      evictEntry(key, record);
      return true;
    },
    clear() {
      for (const [key, record] of [...entries.entries()]) {
        evictEntry(key, record);
      }
    },
  };
}

let defaultRegistry = null;

export function getHiddenWebglRetentionRegistry(options) {
  if (!defaultRegistry) {
    defaultRegistry = createHiddenWebglRetentionRegistry(options);
  }
  return defaultRegistry;
}
