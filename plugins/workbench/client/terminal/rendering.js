// WebGL recovery & DPR repair, render-pause release, stable cell fit metrics,
// theme contrast resolution, DOM block fills (U+2580..U+2595), and selection gutter stripping.
// Ported from stablyai/orca (MIT).

import { stopReleasingWebglCanvasBacking } from './webgl-retention.js';

export const WEBGL_CONTEXT_LOSS_RETRY_LIMIT = 3;
export const WEBGL_CONTEXT_LOSS_RETRY_WINDOW_MS = 60_000;
export const LIGHT_BG_MIN_CONTRAST = 4.5;
export const DARK_BG_MIN_CONTRAST = 3;

const BLOCK_FG_VAR = '--anymux-block-fg';
const FILL_ATTR = 'data-anymux-block-fill';
const INLINE_FG_ATTR = 'data-anymux-block-inline-fg';
const INLINE_DECORATION_FG_ATTR = 'data-anymux-block-inline-decoration-fg';

/** Resolve WCAG minimumContrastRatio by colorScheme: 4.5 on light backgrounds, 3 on dark backgrounds. */
export function resolveMinimumContrastRatio(colorScheme, override) {
  const num = Number(override);
  if (Number.isFinite(num) && num >= 1 && num <= 21) return num;
  return colorScheme === 'light' ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST;
}

/** Tracks bounded WebGL context-loss retries per pane (max 3 losses inside 60s). */
export function createWebglRecoveryPolicy(limit = WEBGL_CONTEXT_LOSS_RETRY_LIMIT, windowMs = WEBGL_CONTEXT_LOSS_RETRY_WINDOW_MS) {
  let losses = [];
  const prune = (now = Date.now()) => {
    const cutoff = now - windowMs;
    losses = losses.filter((ts) => ts > cutoff);
    return losses;
  };
  return {
    recordLoss(now = Date.now()) {
      prune(now).push(now);
      return losses.length;
    },
    canRetry(now = Date.now()) {
      return prune(now).length < limit;
    },
    reset() {
      losses = [];
    },
    count(now = Date.now()) {
      return prune(now).length;
    },
  };
}

/** Release xterm's paused render latch and synchronously flush viewport repaint on reveal/unpark. */
export function forceRepaintThroughRenderPause(term) {
  const service = term?._core?._renderService;
  if (!service || typeof service.refreshRows !== 'function' || service._isPaused !== true) {
    return false;
  }
  const rows = term.rows;
  if (typeof rows !== 'number' || rows < 1) return false;
  service._isPaused = false;
  service._needsFullRefresh = false;
  try { service._pausedResizeTask?.flush?.(); } catch { /* ignore */ }
  try {
    service.refreshRows(0, rows - 1, true);
    return true;
  } catch {
    return false;
  }
}

/** Repair WebGL canvas backing store size when DPR changed while pane was hidden/moved across displays. */
export function repairPaneWebglCanvasDpr(term) {
  const renderer = term?._core?._renderService?._renderer?.value;
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas;
  if (!renderer || !canvas) return 'current';
  if (!canvas.isConnected) return 'deferred';
  const view = canvas.ownerDocument?.defaultView;
  const expected = renderer.dimensions?.device?.canvas;
  const expectedW = expected?.width ?? 0;
  const expectedH = expected?.height ?? 0;
  if (!view || expectedW <= 0 || expectedH <= 0) return 'deferred';

  const dprChanged = typeof renderer._devicePixelRatio === 'number' && renderer._devicePixelRatio !== view.devicePixelRatio;
  const tolerance = Math.max(1, Math.ceil((view.devicePixelRatio || 1) / 2));
  if (!dprChanged
    && Math.abs(canvas.width - expectedW) <= tolerance
    && Math.abs(canvas.height - expectedH) <= tolerance) {
    return 'current';
  }
  try {
    renderer.handleDevicePixelRatioChange?.();
    renderer.handleResize?.(term.cols, term.rows);
    term.refresh?.(0, Math.max(0, (term.rows || 1) - 1));
    return 'repaired';
  } catch {
    return 'deferred';
  }
}

/** Restore WebGL canvas backing dimensions synchronously after hidden backing release. */
export function restoreReleasedPaneWebglCanvas(term, devicePixelSize = null) {
  const renderer = term?._core?._renderService?._renderer?.value;
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas;
  if (!canvas) return false;
  const saved = stopReleasingWebglCanvasBacking(canvas);
  const expected = renderer?.dimensions?.device?.canvas || term?._core?._renderService?.dimensions?.device?.canvas;
  const targetW = Math.round(Number(devicePixelSize?.width) || Number(expected?.width) || Number(saved?.width) || 0);
  const targetH = Math.round(Number(devicePixelSize?.height) || Number(expected?.height) || Number(saved?.height) || 0);
  const needsRestore = Boolean(saved) || canvas.width === 0 || canvas.height === 0;
  if (!needsRestore) return false;
  if (targetW > 0 && targetH > 0) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  try {
    renderer?.handleDevicePixelRatioChange?.();
    renderer?.handleResize?.(term.cols, term.rows);
    term.refresh?.(0, Math.max(0, (term.rows || 1) - 1));
  } catch { /* ignore */ }
  return true;
}

/** Read grid-independent cell dimensions from device pixel metrics divided by DPR. */
export function readStableCellSize(term, fallbackDpr = 1) {
  const dims = term?._core?._renderService?.dimensions;
  if (!dims) return null;
  const dpr = term.element?.ownerDocument?.defaultView?.devicePixelRatio || fallbackDpr || 1;
  const devW = dims.device?.cell?.width;
  const devH = dims.device?.cell?.height;
  if (devW > 0 && devH > 0 && dpr > 0) {
    const width = devW / dpr;
    const height = devH / dpr;
    if (width > 2 && height > 4) return { width, height };
  }
  const css = dims.css?.cell;
  if (css?.width > 2 && css?.height > 4) return { width: css.width, height: css.height };
  return null;
}

// --- DOM Block Element Fill (seamless U+2580..U+2595 without WebGL custom glyphs) ---

function gradient(axis, solidPercent, fromStart) {
  const dir = axis === 'bottom' ? 'to bottom' : 'to right';
  const fg = `var(${BLOCK_FG_VAR})`;
  if (fromStart) return `linear-gradient(${dir}, ${fg} ${solidPercent}%, transparent ${solidPercent}%)`;
  const gap = 100 - solidPercent;
  return `linear-gradient(${dir}, transparent ${gap}%, ${fg} ${gap}%)`;
}

export function backgroundImageForUniformBlockRun(text) {
  if (!text) return null;
  const ch = text[0];
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] !== ch) return null;
  }
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0x2580) return gradient('bottom', 50, true);
  if (code >= 0x2581 && code <= 0x2588) return gradient('bottom', (code - 0x2580) * 12.5, false);
  if (code >= 0x2589 && code <= 0x258f) return gradient('right', (8 - (code - 0x2588)) * 12.5, true);
  if (code === 0x2590) return gradient('right', 50, false);
  if (code === 0x2594) return gradient('bottom', 12.5, true);
  if (code === 0x2595) return gradient('right', 12.5, false);
  return null;
}

function clearBlockFill(span) {
  if (!span.hasAttribute?.(FILL_ATTR)) return;
  const origColor = span.getAttribute(INLINE_FG_ATTR);
  const origDecColor = span.getAttribute(INLINE_DECORATION_FG_ATTR);
  const ownsColor = span.style.color === 'transparent';
  const ownsDec = origDecColor !== null && span.style.textDecorationColor === `var(${BLOCK_FG_VAR})`;
  span.removeAttribute(FILL_ATTR);
  span.removeAttribute(INLINE_FG_ATTR);
  span.removeAttribute(INLINE_DECORATION_FG_ATTR);
  span.style.removeProperty('background-image');
  span.style.removeProperty('background-size');
  span.style.removeProperty('background-repeat');
  span.style.removeProperty(BLOCK_FG_VAR);
  if (ownsDec) {
    if (origDecColor) span.style.textDecorationColor = origDecColor;
    else span.style.removeProperty('text-decoration-color');
  }
  if (ownsColor) {
    if (origColor) span.style.color = origColor;
    else span.style.removeProperty('color');
  }
}

function fillBlockRow(row) {
  for (const span of row.querySelectorAll('span')) {
    const text = span.textContent ?? '';
    const fill = backgroundImageForUniformBlockRun(text);
    if (!fill) {
      clearBlockFill(span);
      continue;
    }
    const inlineFg = span.style.color;
    const ownsColor = span.hasAttribute(FILL_ATTR) && inlineFg === 'transparent';
    if (ownsColor && span.getAttribute(FILL_ATTR) === text) continue;
    const fg = ownsColor
      ? span.style.getPropertyValue(BLOCK_FG_VAR)
      : (inlineFg || (typeof getComputedStyle === 'function' ? getComputedStyle(span).color : ''));
    if (!fg) continue;
    if (!ownsColor) span.setAttribute(INLINE_FG_ATTR, inlineFg);
    const inlineDec = span.style.textDecorationColor;
    if (!inlineDec || inlineDec === 'currentcolor' || inlineDec === 'initial' || inlineDec === 'unset') {
      span.setAttribute(INLINE_DECORATION_FG_ATTR, inlineDec);
      span.style.textDecorationColor = `var(${BLOCK_FG_VAR})`;
    }
    span.setAttribute(FILL_ATTR, text);
    span.style.setProperty(BLOCK_FG_VAR, fg);
    span.style.color = 'transparent';
    span.style.backgroundImage = fill;
    span.style.backgroundSize = `${100 / text.length}% 100%`;
    span.style.backgroundRepeat = 'repeat-x';
  }
}

export function applyDomBlockFills(root, range) {
  if (!root || typeof root.querySelector !== 'function') return;
  const rows = root.querySelector('.xterm-rows');
  if (!rows) return;
  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? rows.children.length - 1, rows.children.length - 1);
  for (let row = start; row <= end; row += 1) {
    if (rows.children[row]) fillBlockRow(rows.children[row]);
  }
}

/** Strip shared leading left-gutter whitespace from multi-line selections while keeping relative indentation and CRLF. */
export function stripTerminalSelectionGutter(selection) {
  if (typeof selection !== 'string' || !selection) return '';
  const lines = selection.split('\n').map((raw) => {
    const hasCr = raw.endsWith('\r');
    const text = hasCr ? raw.slice(0, -1) : raw;
    const indent = /^ */.exec(text)?.[0].length ?? 0;
    return { indent, text, terminator: hasCr ? '\r' : '' };
  });
  let gutter = Number.POSITIVE_INFINITY;
  for (const { indent, text } of lines) {
    if (indent === text.length) continue;
    gutter = Math.min(gutter, indent);
    if (gutter === 0) return selection;
  }
  if (!Number.isFinite(gutter) || gutter === 0) return selection;
  return lines
    .map(({ indent, text, terminator }) => text.slice(Math.min(indent, gutter)) + terminator)
    .join('\n');
}
