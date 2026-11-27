// Mobile draggable start/end selection handles, edge auto-scroll, and floating copy/clear pill.
// Ported from stablyai/orca (MIT).

import { stripTerminalSelectionGutter } from '../terminal/rendering.js';

const EDGE_SCROLL_PX = 40;
const EDGE_SCROLL_INTERVAL_MS = 60;

export function isStartFirst(a, b) {
  return a.row !== b.row ? a.row < b.row : a.col <= b.col;
}

export function orderedSelectionRange(sel) {
  if (!sel) return null;
  return isStartFirst(sel.anchor, sel.focus)
    ? { start: sel.anchor, end: sel.focus }
    : { start: sel.focus, end: sel.anchor };
}

export function applyXtermSelectionRange(term, sel) {
  const range = orderedSelectionRange(sel);
  if (!term || !range) return;
  const cols = Math.max(1, term.cols || 80);
  const length = range.start.row === range.end.row
    ? Math.max(1, range.end.col - range.start.col + 1)
    : (cols - range.start.col) + Math.max(0, range.end.row - range.start.row - 1) * cols + (range.end.col + 1);
  try {
    term.select?.(range.start.col, range.start.row, length);
  } catch { /* ignore invalid bounds */ }
}

/**
 * Attach draggable start/end handles and a positioned Copy/Clear pill to a mobile pane.
 * Handles stay interactive after lifting the finger from long-press selection.
 */
export function createMobileSelectionOverlay({
  entry,
  globalObj = globalThis,
  pointToCell,
  onCopy,
  onClear,
}) {
  const doc = globalObj.document;
  if (!doc || !entry?.el || !entry?.term) {
    return { show: () => {}, update: () => {}, clear: () => {}, isActive: () => false, dispose: () => {} };
  }

  let sel = null;
  let activeHandle = null;
  let edgeScrollDir = 0;
  let edgeTimer = null;
  let edgeClientX = 0;
  let edgeClientY = 0;

  const root = doc.createElement('div');
  root.className = 'wb-sel-overlay';
  root.hidden = true;

  const handleStart = doc.createElement('button');
  handleStart.type = 'button';
  handleStart.className = 'wb-sel-handle is-start';
  handleStart.setAttribute('aria-label', '选区起点手柄');

  const handleEnd = doc.createElement('button');
  handleEnd.type = 'button';
  handleEnd.className = 'wb-sel-handle is-end';
  handleEnd.setAttribute('aria-label', '选区终点手柄');

  const menu = doc.createElement('div');
  menu.className = 'wb-sel-pill';
  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'wb-sel-pill-btn wb-touch-copy-inline';
  copyBtn.textContent = '复制选区';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'wb-sel-pill-btn';
  closeBtn.textContent = '取消';
  menu.append(copyBtn, closeBtn);

  root.append(handleStart, handleEnd, menu);
  entry.el.append(root);

  const viewportBox = () => entry.el.getBoundingClientRect?.() || { left: 0, top: 0, width: 320, height: 480 };

  const stopEdgeScroll = () => {
    if (edgeTimer != null) {
      globalObj.clearInterval?.(edgeTimer);
      edgeTimer = null;
    }
    edgeScrollDir = 0;
  };

  const reposition = () => {
    if (!sel || root.hidden) return;
    const range = orderedSelectionRange(sel);
    if (!range) return;
    const term = entry.term;
    const screen = term.element?.querySelector?.('.xterm-screen') || term.element || entry.body;
    const screenRect = screen?.getBoundingClientRect?.();
    const box = viewportBox();
    if (!screenRect?.width || !screenRect?.height || !term.cols || !term.rows) return;

    const cellW = screenRect.width / term.cols;
    const cellH = screenRect.height / term.rows;
    const baseY = term.buffer?.active?.viewportY || 0;
    const sx = screenRect.left - box.left + range.start.col * cellW;
    const sy = screenRect.top - box.top + (range.start.row - baseY) * cellH;
    const ex = screenRect.left - box.left + (range.end.col + 1) * cellW;
    const ey = screenRect.top - box.top + (range.end.row - baseY) * cellH;

    handleStart.style.left = `${sx.toFixed(1)}px`;
    handleStart.style.top = `${sy.toFixed(1)}px`;
    handleEnd.style.left = `${ex.toFixed(1)}px`;
    handleEnd.style.top = `${(ey + cellH).toFixed(1)}px`;

    const startVis = sy >= 0 && sy <= box.height;
    const endVis = ey >= 0 && ey <= box.height;
    handleStart.style.visibility = startVis ? 'visible' : 'hidden';
    handleEnd.style.visibility = endVis ? 'visible' : 'hidden';

    let topPx = 8;
    let leftPx = 8;
    if (startVis && sy > 52) {
      topPx = sy - 44;
      leftPx = sx - 40;
    } else if (endVis && ey + cellH + 52 < box.height) {
      topPx = ey + cellH + 8;
      leftPx = ex - 60;
    } else {
      topPx = Math.max(8, Math.min(box.height - 44, box.height / 2 - 20));
      leftPx = Math.max(8, box.width / 2 - 60);
    }
    menu.style.top = `${Math.max(4, Math.min(Math.max(4, box.height - 44), topPx)).toFixed(1)}px`;
    menu.style.left = `${Math.max(6, Math.min(Math.max(6, box.width - 140), leftPx)).toFixed(1)}px`;
  };

  const updateEndpoint = (which, clientX, clientY) => {
    const cell = pointToCell({ clientX, clientY });
    if (!cell || !sel) return false;
    if (which === 'start') sel.anchor = cell;
    else sel.focus = cell;
    applyXtermSelectionRange(entry.term, sel);
    reposition();
    return true;
  };

  const startEdgeScroll = (dir) => {
    if (edgeScrollDir === dir) return;
    stopEdgeScroll();
    edgeScrollDir = dir;
    edgeTimer = globalObj.setInterval(() => {
      if (!edgeScrollDir || !sel) return;
      const before = entry.term.buffer?.active?.viewportY ?? 0;
      entry.term.scrollLines?.(edgeScrollDir);
      const after = entry.term.buffer?.active?.viewportY ?? 0;
      if (before === after) {
        stopEdgeScroll();
        return;
      }
      if (activeHandle) updateEndpoint(activeHandle, edgeClientX, edgeClientY);
      reposition();
    }, EDGE_SCROLL_INTERVAL_MS);
  };

  const bindHandle = (el, which) => {
    const onTouchStart = (e) => {
      if (!e.touches?.[0]) return;
      e.preventDefault();
      e.stopPropagation();
      // Normalize so start stays anchor and end stays focus when crossing earlier
      const range = orderedSelectionRange(sel);
      if (range) sel = { anchor: range.start, focus: range.end };
      activeHandle = which;
      edgeClientX = e.touches[0].clientX;
      edgeClientY = e.touches[0].clientY;
    };
    const onTouchMove = (e) => {
      if (activeHandle !== which || !e.touches?.[0]) return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      edgeClientX = t.clientX;
      edgeClientY = t.clientY;
      updateEndpoint(which, t.clientX, t.clientY);
      const box = viewportBox();
      const relY = t.clientY - box.top;
      if (relY < EDGE_SCROLL_PX) startEdgeScroll(-1);
      else if (relY > box.height - EDGE_SCROLL_PX) startEdgeScroll(1);
      else stopEdgeScroll();
    };
    const onTouchEnd = (e) => {
      if (activeHandle === which) {
        e.preventDefault();
        e.stopPropagation();
        activeHandle = null;
        stopEdgeScroll();
      }
    };
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
  };

  bindHandle(handleStart, 'start');
  bindHandle(handleEnd, 'end');

  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = entry.term.getSelection?.() || '';
    if (raw) onCopy?.(stripTerminalSelectionGutter(raw));
    clear();
    onClear?.();
  });

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clear();
    onClear?.();
  });

  const show = (anchorCell, focusCell) => {
    sel = { anchor: anchorCell, focus: focusCell || anchorCell };
    root.hidden = false;
    applyXtermSelectionRange(entry.term, sel);
    reposition();
  };

  const clear = () => {
    stopEdgeScroll();
    activeHandle = null;
    sel = null;
    root.hidden = true;
    entry.term.clearSelection?.();
  };

  const update = (anchorCell, focusCell) => {
    if (!sel) {
      show(anchorCell, focusCell);
      return;
    }
    sel.anchor = anchorCell || sel.anchor;
    sel.focus = focusCell || sel.focus;
    applyXtermSelectionRange(entry.term, sel);
    reposition();
  };

  return {
    show,
    update,
    reposition,
    clear,
    isActive: () => !root.hidden && sel !== null,
    isDraggingHandle: () => activeHandle !== null,
    dispose() {
      stopEdgeScroll();
      root.remove();
    },
  };
}
