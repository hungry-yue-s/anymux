import { validateTarget, validateWindowTarget, newId } from './model.js';
import { TileRegistry, parseTilePayload } from './tile-registry.js';

const FONT_FAMILY = "'Anymux Mono', 'Maple Mono NF CN', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Symbols Nerd Font Mono', monospace";
const MAX_WEBGL_PANES = 6;
const MAX_RENDER_BACKLOG = 16 * 1024 * 1024;
const INPUT_CHUNK_BYTES = 32768;
const SYNC_UPDATE_START = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
const SYNC_UPDATE_END = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);
const SGR_HOVER_MOVE_RE = /^\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+[Mm]$/;

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const TRACKPAD_WHEEL_DELTA_THRESHOLD = 100;
const DISCRETE_WHEEL_DELTA_UNIT = 120;
const CONTINUOUS_GESTURE_GAP_MS = 300;
const WHEEL_DELTA_RATIOS = [3, 1];
const WHEEL_DELTA_TOLERANCE = 3;
const DEFAULT_CELL_HEIGHT = 16;
const LOG_ACCEL = 1.6;
const FAST_STREAK_MIN_GAP_MS = 16;
const FAST_STREAK_MAX_GAP_MS = 45;
const FAST_STREAK_MAX_BONUS = 3;
const FAST_STREAK_STEPS = 4;
const FAST_STREAK_DECAY_RATIO = 0.85;
const MAX_BASE_ROWS = 6;
const MAX_DISCRETE_ROWS = 9;
const MAX_REPORTS_PER_FLUSH = 24;
const REPLAYED_WHEEL_FLAG = '__anymuxReplayedWheelEvent';

function readWheelDeltaY(event) {
  if (typeof event.wheelDeltaY === 'number' && Number.isFinite(event.wheelDeltaY)) return event.wheelDeltaY;
  if (typeof event.wheelDelta === 'number' && Number.isFinite(event.wheelDelta)) return event.wheelDelta;
  return null;
}

function isContinuousGesture(event, state) {
  if ((event.deltaMode ?? DOM_DELTA_PIXEL) !== DOM_DELTA_PIXEL) {
    state.continuousGestureAt = null;
    return false;
  }
  const ts = typeof event.timeStamp === 'number' && Number.isFinite(event.timeStamp) ? event.timeStamp : null;
  const rawWheel = readWheelDeltaY(event);
  const ratioMatch = rawWheel !== null && WHEEL_DELTA_RATIOS.some(
    (ratio) => Math.abs(Math.abs(event.deltaY) * ratio - Math.abs(rawWheel)) <= WHEEL_DELTA_TOLERANCE,
  );
  const continuous = rawWheel === null
    || Math.abs(rawWheel) < TRACKPAD_WHEEL_DELTA_THRESHOLD
    || (ts !== null && state.continuousGestureAt !== null && ts >= state.continuousGestureAt
      && ts - state.continuousGestureAt <= CONTINUOUS_GESTURE_GAP_MS && ratioMatch);
  state.continuousGestureAt = continuous ? ts : null;
  return continuous;
}

function readCellHeight(term) {
  const coreH = term?._core?._renderService?.dimensions?.css?.cell?.height;
  if (typeof coreH === 'number' && Number.isFinite(coreH) && coreH > 0) return coreH;
  const rect = term?.element?.querySelector?.('.xterm-screen')?.getBoundingClientRect?.();
  if (rect && rect.height > 0 && term.rows > 0) return rect.height / term.rows;
  return DEFAULT_CELL_HEIGHT;
}

/**
 * Smooths trackpad & discrete wheel events for mouse-tracking TUIs (Orca MIT pattern),
 * avoiding xterm's 0.3x trackpad attenuation and coalescing multi-row reports per microtask.
 */
export function installTuiWheelHandler(term, {
  onBeforeDrain,
  onAfterDrain,
  multiplier = 1,
  global: hostGlobal = null,
} = {}) {
  if (typeof term?.attachCustomWheelEventHandler !== 'function') return () => {};
  const win = hostGlobal || term.element?.ownerDocument?.defaultView || globalThis;
  const scheduleMicrotask = typeof win.queueMicrotask === 'function'
    ? (fn) => win.queueMicrotask(fn)
    : (fn) => Promise.resolve().then(fn);
  const mult = typeof multiplier === 'number' && Number.isFinite(multiplier)
    ? Math.round(Math.min(10, Math.max(1, multiplier)))
    : 1;
  const state = {
    continuousGestureAt: null,
    fastStreak: 0,
    lastDistanceRows: null,
    lastInputAt: null,
    pendingDirection: 0,
    pendingRows: 0,
    pendingReports: 0,
    pendingEvent: null,
    pendingTarget: null,
    drainScheduled: false,
  };
  let disposed = false;

  const drain = () => {
    state.drainScheduled = false;
    if (disposed || !state.pendingTarget || !state.pendingEvent || state.pendingReports <= 0) {
      state.pendingReports = 0;
      state.pendingEvent = null;
      state.pendingTarget = null;
      return;
    }
    if (!term.modes?.mouseTrackingMode || term.modes.mouseTrackingMode === 'none') {
      state.pendingReports = 0;
      state.pendingDirection = 0;
      state.pendingEvent = null;
      state.pendingTarget = null;
      return;
    }
    const target = state.pendingTarget;
    const src = state.pendingEvent;
    const count = Math.min(MAX_REPORTS_PER_FLUSH, state.pendingReports);
    state.pendingReports = 0;
    state.pendingEvent = null;
    state.pendingTarget = null;
    const WheelEventCtor = win.WheelEvent || globalThis.WheelEvent;
    if (typeof WheelEventCtor !== 'function') return;
    const dirY = src.deltaY < 0 ? -1 : 1;
    onBeforeDrain?.();
    try {
      for (let i = 0; i < count; i++) {
        const replay = new WheelEventCtor(src.type || 'wheel', {
          bubbles: src.bubbles !== false,
          cancelable: src.cancelable !== false,
          composed: src.composed !== false,
          view: src.view,
          detail: src.detail,
          screenX: src.screenX,
          screenY: src.screenY,
          clientX: src.clientX,
          clientY: src.clientY,
          ctrlKey: src.ctrlKey,
          altKey: src.altKey,
          shiftKey: src.shiftKey,
          metaKey: src.metaKey,
          button: src.button,
          buttons: src.buttons,
          relatedTarget: src.relatedTarget,
          deltaX: 0,
          deltaY: dirY,
          deltaZ: 0,
          deltaMode: DOM_DELTA_LINE,
        });
        Object.defineProperty(replay, REPLAYED_WHEEL_FLAG, { configurable: true, value: true });
        target.dispatchEvent(replay);
      }
    } finally {
      onAfterDrain?.();
    }
  };

  term.attachCustomWheelEventHandler((event) => {
    if (disposed || !event || event[REPLAYED_WHEEL_FLAG] === true) return true;
    const modeName = term.modes?.mouseTrackingMode;
    if (!modeName || modeName === 'none' || event.deltaY === 0 || event.shiftKey || event.ctrlKey || event.metaKey) {
      return true;
    }

    const dir = event.deltaY < 0 ? -1 : 1;
    if (state.pendingDirection !== 0 && state.pendingDirection !== dir) {
      state.fastStreak = 0;
      state.lastDistanceRows = null;
      state.lastInputAt = null;
      state.pendingRows = 0;
      state.pendingReports = 0;
    }
    state.pendingDirection = dir;

    const continuous = isContinuousGesture(event, state);
    const cellHeight = readCellHeight(term);
    const deltaMode = event.deltaMode ?? DOM_DELTA_PIXEL;
    const absY = Math.abs(event.deltaY);
    const rawRows = deltaMode === DOM_DELTA_LINE
      ? absY
      : deltaMode === DOM_DELTA_PAGE
        ? absY * Math.max(1, term.rows || 24)
        : absY / cellHeight;

    let wholeRows;
    if (continuous) {
      state.fastStreak = 0;
      state.lastDistanceRows = null;
      state.lastInputAt = null;
      const acc = state.pendingRows + rawRows;
      wholeRows = Math.trunc(acc);
      state.pendingRows = acc - wholeRows;
    } else {
      const rawWheel = readWheelDeltaY(event);
      const wheelRows = rawWheel === null ? 0 : Math.abs(rawWheel) / DISCRETE_WHEEL_DELTA_UNIT;
      const dist = Math.max(1, rawRows, wheelRows);
      const base = dist <= 1 ? dist : Math.min(MAX_BASE_ROWS, 1 + Math.log2(dist) * LOG_ACCEL);
      let bonus = 0;
      const ts = typeof event.timeStamp === 'number' && Number.isFinite(event.timeStamp) ? event.timeStamp : null;
      if (ts !== null) {
        const gap = state.lastInputAt === null ? null : ts - state.lastInputAt;
        const decayed = state.lastDistanceRows !== null && dist < state.lastDistanceRows * FAST_STREAK_DECAY_RATIO;
        state.lastDistanceRows = dist;
        state.lastInputAt = ts;
        if (decayed || gap === null || gap < 0 || gap > FAST_STREAK_MAX_GAP_MS) {
          state.fastStreak = 0;
        } else {
          const factor = gap <= FAST_STREAK_MIN_GAP_MS
            ? 1
            : (FAST_STREAK_MAX_GAP_MS - gap) / (FAST_STREAK_MAX_GAP_MS - FAST_STREAK_MIN_GAP_MS);
          state.fastStreak = Math.min(FAST_STREAK_STEPS, state.fastStreak + 1);
          bonus = FAST_STREAK_MAX_BONUS * factor * (state.fastStreak / FAST_STREAK_STEPS);
        }
      } else {
        state.fastStreak = 0;
        state.lastDistanceRows = null;
        state.lastInputAt = null;
      }
      const scaled = Math.min(MAX_DISCRETE_ROWS, base + bonus) * mult;
      const acc = state.pendingRows + scaled;
      wholeRows = Math.trunc(acc);
      state.pendingRows = acc - wholeRows;
    }

    event.preventDefault?.();
    if (wholeRows > 0) {
      const EventTargetCtor = win.EventTarget;
      const target = (typeof EventTargetCtor === 'function' && event.currentTarget instanceof EventTargetCtor)
        ? event.currentTarget
        : (event.currentTarget || term.element);
      if (!target || typeof target.dispatchEvent !== 'function') return false;
      state.pendingReports += wholeRows;
      state.pendingEvent = event;
      state.pendingTarget = target;
      if (!state.drainScheduled) {
        state.drainScheduled = true;
        scheduleMicrotask(drain);
      }
    }
    return false;
  });

  return () => {
    if (disposed) return;
    disposed = true;
    state.pendingReports = 0;
    state.pendingRows = 0;
    state.pendingDirection = 0;
    state.pendingEvent = null;
    state.pendingTarget = null;
    state.drainScheduled = false;
    term.attachCustomWheelEventHandler(() => true);
  };
}

const SVG_NS = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">';
const PANE_ICONS = {
  claude: SVG_NS + '<path d="M12 3v4M12 17v4M4.9 6.5l3.2 2M15.9 15.5l3.2 2M4.9 17.5l3.2-2M15.9 8.5l3.2-2"/></svg>',
  codex: SVG_NS + '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 9.5 2.5 2.5-2.5 2.5M12.5 14.5H16"/></svg>',
  git: SVG_NS + '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 3.6-4.8 3.2-9.8 5.6"/></svg>',
  browser: SVG_NS + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  diff: SVG_NS + '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M9.5 14h5M12 11.5v5"/></svg>',
  doc: SVG_NS + '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/></svg>',
  rich: SVG_NS + '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="18" height="8" rx="1.5"/></svg>',
  shell: SVG_NS + '<path d="m7 8 4 4-4 4M13 16h5"/></svg>',
  splitH: SVG_NS + '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  splitV: SVG_NS + '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg>',
  zoom: SVG_NS + '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
  unzoom: SVG_NS + '<path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg>',
  more: SVG_NS + '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  close: SVG_NS + '<path d="M18 6 6 18M6 6l12 12"/></svg>',
  device: SVG_NS + '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18h2"/></svg>',
  minimize: SVG_NS + '<path d="M6 12h12"/></svg>',
};

// xterm's public onData omits the input source. Track that bit so native tty
// answers still flow while keyboard/IME input is disabled during hydration.
export function installInputHandler(term, send) {
  const core = term._core?.coreService;
  if (typeof core?.triggerDataEvent !== 'function') throw new Error('终端组件版本不兼容，请更新面板。');
  const original = core.triggerDataEvent;
  let user = false;
  const forwarded = function (data, wasUserInput = false) {
    const previous = user; user = wasUserInput;
    try { return original.call(this, data, wasUserInput); } finally { user = previous; }
  };
  core.triggerDataEvent = forwarded;
  const listener = term.onData((data) => send(data, user));
  return () => { listener.dispose(); if (core.triggerDataEvent === forwarded) core.triggerDataEvent = original; };
}

export function installClipboardHandler(term, copy) {
  return term.parser.registerOscHandler(52, (payload) => {
    const separator = payload.indexOf(';');
    const encoded = payload.slice(separator + 1);
    // Clipboard queries are never answered by the browser. Keep side effects out
    // of snapshots/history and bound the live copy, like the legacy OSC52 path.
    if (separator < 0 || encoded === '?' || encoded.length > 1_500_000) return true;
    try {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      copy(new TextDecoder().decode(bytes));
    } catch { /* malformed clipboard content is not terminal input */ }
    return true;
  });
}

export function decodeWindowBinaryFrame(raw) {
  let bytes;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  else throw new Error('无效的二进制窗口帧');

  if (bytes.byteLength < 9) throw new Error('窗口帧长度无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameType = view.getUint8(0);
  const paneNum = view.getUint32(1, false);
  const seq = view.getUint32(5, false);
  const paneId = '%' + paneNum;

  if (frameType === 0x01) {
    return { kind: 'output', paneId, seq, data: bytes.subarray(9) };
  }
  if (frameType === 0x02) {
    if (bytes.byteLength < 21) throw new Error('快照帧长度无效');
    return {
      kind: 'snapshot',
      paneId,
      seq,
      cols: view.getUint16(9, false),
      rows: view.getUint16(11, false),
      historyLines: view.getUint32(13, false),
      historyTotal: view.getUint32(17, false),
      data: bytes.subarray(21),
    };
  }
  if (frameType === 0x03) {
    if (bytes.byteLength < 25) throw new Error('分片快照帧长度无效');
    const chunkIndex = view.getUint16(21, false);
    const chunkCount = view.getUint16(23, false);
    if (chunkCount < 1 || chunkIndex >= chunkCount) throw new Error('快照分片索引无效');
    return {
      kind: 'snapshot-chunk',
      paneId,
      seq,
      cols: view.getUint16(9, false),
      rows: view.getUint16(11, false),
      historyLines: view.getUint32(13, false),
      historyTotal: view.getUint32(17, false),
      chunkIndex,
      chunkCount,
      data: bytes.subarray(25),
    };
  }
  throw new Error('未知二进制帧类型: ' + frameType);
}

function basenameOf(path) {
  if (!path) return '';
  const clean = String(path).replace(/[\\/]+$/, '');
  if (!clean) return '/';
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.pop() || clean;
}

function commandKind(command) {
  const lower = String(command || '').toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('git') || lower.includes('lazygit')) return 'git';
  return 'shell';
}

const PANE_RAIL_PX = 28;
const MOBILE_PANE_RAIL_PX = 38;
const PANE_PAD_X = 16;
const PANE_PAD_Y = 10;
const PANE_MIN_PAD_X = 8; // left padding before canvas; right 8px is compressible breathing room
const PANE_MIN_PAD_Y = 4; // top padding before canvas; bottom 6px is compressible breathing room
const DIVIDER_PX = 1;

function measureLayoutMetrics(node, panes, cell, railPx = PANE_RAIL_PX) {
  const fallback = {
    chromeW: PANE_PAD_X,
    chromeH: railPx + PANE_PAD_Y,
    contentCols: 1,
    contentRows: 1,
    netWidthPx: PANE_PAD_X,
    netHeightPx: railPx + PANE_PAD_Y,
    minNetWidthPx: PANE_MIN_PAD_X,
    minNetHeightPx: railPx + PANE_MIN_PAD_Y,
  };
  if (!node) return fallback;
  if (node.type === 'pane') {
    const entry = panes?.get(node.paneId);
    const isRich = Boolean(entry?.isRich);
    const chromeW = isRich ? 0 : PANE_PAD_X;
    const chromeH = railPx + (isRich ? 0 : PANE_PAD_Y);
    const minChromeW = isRich ? 0 : PANE_MIN_PAD_X;
    const minChromeH = railPx + (isRich ? 0 : PANE_MIN_PAD_Y);
    const layoutW = node.width || entry?.meta?.width || 1;
    const layoutH = node.height || entry?.meta?.height || 1;
    const contentCols = Math.max(1, entry?.meta?.width || layoutW);
    const contentRows = Math.max(1, entry?.meta?.height || layoutH);
    // Clamp per-pane tmux non-content cells (e.g. pane-border-status) to [0, 2]
    // so transient/stale metadata cannot distort window resize calculations.
    const borderCols = Math.max(0, Math.min(2, layoutW - contentCols));
    const borderRows = Math.max(0, Math.min(2, layoutH - contentRows));
    return {
      chromeW,
      chromeH,
      contentCols,
      contentRows,
      netWidthPx: chromeW - borderCols * cell.width,
      netHeightPx: chromeH - borderRows * cell.height,
      minNetWidthPx: minChromeW - borderCols * cell.width,
      minNetHeightPx: minChromeH - borderRows * cell.height,
    };
  }
  const children = (node.children || []).filter((child) => child && (child.type !== 'pane' || !panes || panes.has(child.paneId)));
  if (!children.length) return fallback;
  const childMetrics = children.map((child) => measureLayoutMetrics(child, panes, cell, railPx));
  const dividerCount = Math.max(0, children.length - 1);
  if (node.dir === 'row') {
    return {
      chromeW: childMetrics.reduce((sum, item) => sum + item.chromeW, 0) + dividerCount * DIVIDER_PX,
      chromeH: Math.max(...childMetrics.map((item) => item.chromeH)),
      contentCols: Math.max(1, childMetrics.reduce((sum, item) => sum + item.contentCols, 0)),
      contentRows: Math.max(1, Math.min(...childMetrics.map((item) => item.contentRows))),
      netWidthPx: childMetrics.reduce((sum, item) => sum + item.netWidthPx, 0) + dividerCount * (DIVIDER_PX - cell.width),
      netHeightPx: Math.max(...childMetrics.map((item) => item.netHeightPx)),
      minNetWidthPx: childMetrics.reduce((sum, item) => sum + item.minNetWidthPx, 0) + dividerCount * (DIVIDER_PX - cell.width),
      minNetHeightPx: Math.max(...childMetrics.map((item) => item.minNetHeightPx)),
    };
  }
  return {
    chromeH: childMetrics.reduce((sum, item) => sum + item.chromeH, 0) + dividerCount * DIVIDER_PX,
    chromeW: Math.max(...childMetrics.map((item) => item.chromeW)),
    contentRows: Math.max(1, childMetrics.reduce((sum, item) => sum + item.contentRows, 0)),
    contentCols: Math.max(1, Math.min(...childMetrics.map((item) => item.contentCols))),
    netHeightPx: childMetrics.reduce((sum, item) => sum + item.netHeightPx, 0) + dividerCount * (DIVIDER_PX - cell.height),
    netWidthPx: Math.max(...childMetrics.map((item) => item.netWidthPx)),
    minNetHeightPx: childMetrics.reduce((sum, item) => sum + item.minNetHeightPx, 0) + dividerCount * (DIVIDER_PX - cell.height),
    minNetWidthPx: Math.max(...childMetrics.map((item) => item.minNetWidthPx)),
  };
}

function measureActivePaneAxis(node, paneId, panes, axis) {
  if (!node) return { found: false, paneContent: 0, totalContent: 0, fixed: 0 };
  if (node.type === 'pane') {
    const layoutSize = axis === 'row' ? node.width : node.height;
    const meta = panes?.get(node.paneId)?.meta;
    const content = Math.max(1, (axis === 'row' ? meta?.width : meta?.height) || layoutSize || 1);
    const fixed = Math.max(0, Math.min(2, (layoutSize || content) - content));
    return {
      found: node.paneId === paneId,
      paneContent: node.paneId === paneId ? content : 0,
      totalContent: content,
      fixed,
    };
  }
  const children = (node.children || []).filter((child) => child && (child.type !== 'pane' || !panes || panes.has(child.paneId)));
  if (!children.length) return { found: false, paneContent: 0, totalContent: 0, fixed: 0 };
  const results = children.map((child) => measureActivePaneAxis(child, paneId, panes, axis));
  const foundChild = results.find((item) => item.found);
  if (node.dir !== axis) return foundChild || results[0];
  const totalContent = Math.max(1, results.reduce((sum, item) => sum + item.totalContent, 0));
  const fixed = results.reduce((sum, item) => sum + item.fixed, 0) + Math.max(0, children.length - 1);
  return {
    found: Boolean(foundChild),
    paneContent: foundChild ? foundChild.paneContent : 0,
    totalContent,
    fixed,
  };
}

function firstLeafPaneId(node, side = 'start') {
  if (!node) return null;
  if (node.type === 'pane') return node.paneId || node.id || null;
  const children = node.children || [];
  if (!children.length) return null;
  return firstLeafPaneId(side === 'end' ? children[children.length - 1] : children[0], side);
}

function collectLayoutPaneIds(node, panes = null, out = new Set()) {
  if (!node) return out;
  if (node.type === 'pane') {
    if (node.paneId && (!panes || panes.has(node.paneId))) out.add(node.paneId);
    return out;
  }
  for (const child of node.children || []) collectLayoutPaneIds(child, panes, out);
  return out;
}

function collectDomPaneIds(el, out = new Set()) {
  if (!el) return out;
  if (el.classList?.contains('seam-pane') && el.dataset?.paneId) out.add(el.dataset.paneId);
  const nested = el.querySelectorAll?.('.seam-pane[data-pane-id]');
  if (nested) {
    for (const paneEl of nested) {
      if (paneEl.dataset?.paneId) out.add(paneEl.dataset.paneId);
    }
  }
  return out;
}

function collectDividerSegments(node, domNode, panes = null, fallbackX = 0, fallbackY = 0, out = []) {
  if (!node || !domNode || node.type === 'pane') return out;
  if (!domNode.classList?.contains('seam-split')) return out;
  const splitX = Number.isInteger(node.x) ? node.x : fallbackX;
  const splitY = Number.isInteger(node.y) ? node.y : fallbackY;
  const activeChildren = (node.children || []).filter((child) => child && (child.type !== 'pane' || !panes || panes.has(child.paneId)));
  const branches = [];
  const dividers = [];
  for (const el of domNode.children) {
    if (el.classList?.contains('seam-branch')) branches.push(el);
    else if (el.classList?.contains('seam-divider')) dividers.push(el);
  }
  if (branches.length !== activeChildren.length || dividers.length !== Math.max(0, activeChildren.length - 1)) {
    return out;
  }
  let cursorX = splitX;
  let cursorY = splitY;
  for (let idx = 0; idx < activeChildren.length; idx++) {
    const child = activeChildren[idx];
    const childX = Number.isInteger(child.x) ? child.x : cursorX;
    const childY = Number.isInteger(child.y) ? child.y : cursorY;
    const childW = child.width || 1;
    const childH = child.height || 1;
    collectDividerSegments(child, branches[idx].firstElementChild, panes, childX, childY, out);
    if (idx < dividers.length) {
      if (node.dir === 'row') {
        const divX = childX + childW;
        out.push({
          dir: 'row',
          divider: dividers[idx],
          leftBranch: branches[idx],
          rightBranch: branches[idx + 1],
          leftNode: child,
          rightNode: activeChildren[idx + 1],
          x: divX,
          y1: splitY,
          y2: splitY + (node.height || childH),
        });
        cursorX = divX + 1;
      } else {
        const divY = childY + childH;
        out.push({
          dir: 'col',
          divider: dividers[idx],
          leftBranch: branches[idx],
          rightBranch: branches[idx + 1],
          leftNode: child,
          rightNode: activeChildren[idx + 1],
          y: divY,
          x1: splitX,
          x2: splitX + (node.width || childW),
        });
        cursorY = divY + 1;
      }
    }
  }
  return out;
}

function findLayoutJunctions(segments) {
  const vs = segments.filter((seg) => seg.dir === 'row');
  const hs = segments.filter((seg) => seg.dir === 'col');
  const byKey = new Map();
  for (const v of vs) {
    for (const h of hs) {
      if (h.y < v.y1 - 1 || h.y > v.y2 || v.x < h.x1 - 1 || v.x > h.x2) continue;
      let anchor = null;
      if (v.x === h.x1 - 1) anchor = { divider: h.divider, side: 'left' };
      else if (v.x === h.x2) anchor = { divider: h.divider, side: 'right' };
      else if (h.y === v.y1 - 1) anchor = { divider: v.divider, side: 'top' };
      else if (h.y === v.y2) anchor = { divider: v.divider, side: 'bottom' };
      if (!anchor) continue;
      const key = v.x + ':' + h.y;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { x: v.x, y: h.y, vSegments: new Set(), hSegments: new Set(), anchor };
        byKey.set(key, entry);
      }
      entry.vSegments.add(v);
      entry.hSegments.add(h);
    }
  }
  return [...byKey.values()].map((entry) => ({
    x: entry.x,
    y: entry.y,
    vSegments: [...entry.vSegments],
    hSegments: [...entry.hSegments],
    anchor: entry.anchor,
  }));
}

/** Multi-pane Seam tiling workbench session backed by `/ws/window-stream/:windowId`. */
export class SeamWindowSession {
  constructor(global, {
    container,
    target,
    onFocus = () => {},
    onState = () => {},
    onTitle = () => {},
    onFontSize = () => {},
    onFontDelta = () => {},
    onContext = () => {},
    onAction = () => {},
    onStickyModifierChange = () => {},
    visible = true,
    fontSize,
    fontDelta,
  }) {
    this.global = global;
    this.container = container;
    this.target = validateWindowTarget(target);
    if (!this.target) throw new Error('无效的窗口目标');
    this.onFocus = onFocus;
    this.onState = onState;
    this.onTitle = onTitle;
    this.onFontSize = onFontSize;
    this.onFontDelta = onFontDelta;
    this.onContext = onContext;
    this.onAction = onAction;
    this.onStickyModifierChange = typeof onStickyModifierChange === 'function' ? onStickyModifierChange : () => {};
    this.visible = visible;
    this.status = 'connecting';
    this.disposed = false;
    this.epoch = 0;
    this.attempt = 0;
    this.inputVersion = 0;
    this.sizeLease = 'owner';
    this.inputAllowed = true;
    this.foreignClient = false;
    this.paneLeases = null;
    this.sizeOverridden = false;
    this.stickyCtrl = false;
    this._leaseCollapsed = false;
    this._leasePending = false;
    this._lastLeaseMode = 'owner';
    this.zoomed = false;
    this.activePaneId = null;
    this._localActivePaneId = null;
    this._pendingSelectPane = null;
    this.windowCols = 80;
    this.windowRows = 24;
    this.layoutTree = null;
    this.layoutString = '';
    this.layoutCols = null;
    this.layoutRows = null;
    this.layoutZoomed = false;
    this._layoutSyncPending = false;
    this.lastRequestedSize = null;
    this._resizeHistory = new Set();
    this._resizeHistoryEnv = null;
    this._settledViewportEnv = null;
    this.cleanups = [];
    this.panes = new Map();
    this.context = null;
    this.contextRequest = null;
    this._treeTopologyKey = null;
    this._draggingDivider = false;
    this._activeDragCleanup = null;
    this.parked = false;
    this._webglAttachHandle = null;
    this._pendingAcks = new Map();
    this._ackTimer = null;
    this._lastFocusSig = null;

    const doc = global.document;
    const mobile = !!global.MobileUI?.isMobile();
    const typo = global.Theme?.getTerminalTypography?.() || {};
    this._lastMobileMode = mobile;
    const baseFont = typo.fontSize || (mobile ? 13 : 14);
    this.fontDelta = Number.isFinite(fontDelta)
      ? Math.max(-8, Math.min(8, Math.round(fontDelta)))
      : (Number.isFinite(fontSize) ? Math.max(-8, Math.min(8, Math.round(fontSize) - baseFont)) : 0);
    this.fontSize = Math.max(mobile ? 11 : 8, Math.min(22, Number.isFinite(fontDelta) ? (baseFont + this.fontDelta) : (fontSize || baseFont)));
    this.lineHeight = typo.lineHeight || 1.2;
    this.cursorStyle = typo.cursorStyle || 'block';
    this.cursorBlink = typo.cursorBlink !== false;
    this.fontReady = false;
    this.rendererPrepared = true;

    this.stage = doc.createElement('div');
    this.stage.className = 'seam-stage';
    this.leaseBar = doc.createElement('div');
    this.leaseBar.className = 'seam-lease-bar';
    this.leaseBar.hidden = true;
    this.mobilePaneBar = doc.createElement('div');
    this.mobilePaneBar.className = 'seam-mobile-panes';
    this.mobilePaneBar.setAttribute('role', 'tablist');
    this.mobilePaneBar.setAttribute('aria-label', '窗格切换');
    this.mobilePaneBar.hidden = true;
    this.treeHost = doc.createElement('div');
    this.treeHost.className = 'seam-tree-host';
    this.viewport = doc.createElement('div');
    this.viewport.className = 'seam-viewport';
    this.viewport.append(this.treeHost, this.leaseBar);
    this.stage.append(this.mobilePaneBar, this.viewport);
    container.append(this.stage);

    this._listen(container, 'pointerdown', onFocus, true);
    this._listen(container, 'focusin', onFocus);
    this._listen(container, 'wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      this.wheelDelta = (this.wheelDelta || 0) + event.deltaY;
      global.clearTimeout(this.wheelTimer);
      this.wheelTimer = global.setTimeout(() => {
        if (!this.disposed && this.wheelDelta) {
          this.setFontSize(this.fontSize + (this.wheelDelta < 0 ? 1 : -1));
        }
        this.wheelDelta = 0;
      }, 150);
    }, { capture: true, passive: false });

    const themeSync = () => {
      if (this.disposed) return;
      const theme = global.Theme?.getTerminalTheme?.();
      const allowTransparency = Boolean(global.Theme?.isBackdropActive?.() || (global.Theme?.getTransparency?.() || 0) > 0);
      for (const pane of this.panes.values()) {
        if (pane.term) {
          pane.term.options.theme = theme;
          pane.term.options.allowTransparency = allowTransparency;
        }
      }
    };
    const typographySync = () => {
      if (this.disposed) return;
      const next = global.Theme?.getTerminalTypography?.();
      if (!next) return;
      const mobile = this._isMobile();
      const baseFont = next.fontSize || (mobile ? 13 : 14);
      this.fontSize = Math.max(mobile ? 11 : 8, Math.min(22, baseFont + (this.fontDelta || 0)));
      this.lineHeight = next.lineHeight || 1.2;
      this.cursorStyle = next.cursorStyle || 'block';
      this.cursorBlink = next.cursorBlink !== false;
      for (const pane of this.panes.values()) {
        if (!pane.term) continue;
        pane.term.options.fontSize = this.fontSize;
        pane.term.options.lineHeight = this.lineHeight;
        pane.term.options.cursorStyle = this.cursorStyle;
        pane.term.clearTextureAtlas?.();
      }
      this._syncInputGates();
      this._resetResizeGuard();
      this.fit();
    };
    const resetFontDelta = () => {
      if (this.disposed) return;
      this.fontDelta = 0;
      this.onFontDelta(0);
      typographySync();
    };
    this._listen(doc, 'tmux-theme-change', themeSync);
    this._listen(doc, 'tmux-transparency-change', themeSync);
    this._listen(doc, 'tmux-wallpaper-change', themeSync);
    this._listen(doc, 'tmux-typography-change', typographySync);
    this._listen(doc, 'anymux-reset-font-offsets', resetFontDelta);

    this._bindStageMenus();

    const handleViewportResize = () => {
      const mobileNow = this._isMobile();
      if (mobileNow !== this._lastMobileMode) {
        this._lastMobileMode = mobileNow;
        this._renderTree();
        this._renderMobilePaneBar();
        this._resetResizeGuard();
        this._reportPaneFocus();
      }
      this.fit();
    };
    if (global.ResizeObserver) {
      this.resizeObserver = new global.ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.treeHost);
    }
    this._listen(global, 'resize', handleViewportResize);
    if (global.visualViewport) this._listen(global.visualViewport, 'resize', handleViewportResize);

    this._prepareFonts();
    this.ready = Promise.resolve().then(() => {
      if (this.disposed || !container.isConnected) return;
      if (this.visible && !this.ws) this._connect();
    });
  }

  get term() {
    const active = (this.activePaneId && this.panes.get(this.activePaneId)) || this.panes.values().next().value;
    return active?.term || null;
  }

  get hydrated() {
    if (!this.panes.size) return false;
    const active = (this.activePaneId && this.panes.get(this.activePaneId)) || this.panes.values().next().value;
    return Boolean(active?.isRich || active?.hydrated);
  }

  _listen(element, name, handler, options) {
    element?.addEventListener(name, handler, options);
    this.cleanups.push(() => element?.removeEventListener(name, handler, options));
  }

  _applyReadyFont() {
    this.fontReady = true;
    if (!this.panes.size) return;
    let changed = false;
    for (const pane of this.panes.values()) {
      if (!pane.term || pane.term.options.fontFamily === FONT_FAMILY) continue;
      pane.term.options.fontFamily = FONT_FAMILY;
      pane.term.clearTextureAtlas?.();
      changed = true;
    }
    if (changed) this.fit();
  }

  async _prepareFonts() {
    try {
      const loaded = await (this.global.TerminalFonts?.coreReady(1500) || Promise.resolve(false));
      if (this.disposed) return;
      if (loaded === true) this._applyReadyFont();
      else if (loaded === null) {
        this.global.TerminalFonts.coreReady(0).then((late) => {
          if (late && !this.disposed) this._applyReadyFont();
        }).catch(() => {});
      }
    } catch { /* fallback monospace */ }
  }

  _setStatus(status, message = '', reason = null) {
    this.status = status;
    this.message = message;
    this.reason = reason;
    this._syncInputGates();
    if (!this.disposed) this.onState({ status, message, reason, target: this.target });
  }

  _isPaneInputAllowed(paneId) {
    if (this.paneLeases && paneId && Object.prototype.hasOwnProperty.call(this.paneLeases, paneId)) {
      return Boolean(this.paneLeases[paneId]?.inputAllowed);
    }
    return this.inputAllowed;
  }

  _syncInputGates() {
    const windowLive = this.status === 'live';
    for (const pane of this.panes.values()) {
      if (!pane.term) continue;
      const allowed = windowLive && this._isPaneInputAllowed(pane.paneId);
      const ready = allowed && pane.hydrated && !pane.restoring;
      // Keep disableStdin false across in-place live resize/resync snapshots so mobile WebKit/Chrome
      // does not dismiss an open soft keyboard when xterm's helper textarea momentarily toggles readOnly.
      const keepStdin = allowed && (pane.hydrated || (pane.restoring && pane.everHydrated));
      const disableStdin = !keepStdin;
      if (pane.term.options.disableStdin !== disableStdin) {
        pane.term.options.disableStdin = disableStdin;
      }
      pane.term.options.cursorBlink = ready && pane.paneId === this.activePaneId && this.cursorBlink;
    }
  }

  _url() {
    const global = this.global;
    const { serverId, instanceId, sessionId, windowId, clientId } = this.target;
    const path = global.Api.nodeUrl(serverId, '/ws/window-stream/' + encodeURIComponent(windowId));
    const grid = this._measureWindowGrid();
    const params = {
      instanceId,
      sessionId,
      clientId,
      cols: String(grid.cols || this.windowCols || 80),
      rows: String(grid.rows || this.windowRows || 24),
      device: this._isMobile() ? 'mobile' : 'desktop',
      ack: '1',
      protocol: '1',
    };
    const focusPane = this.activePaneId || this.target.paneId;
    if (focusPane) params.paneId = focusPane;
    const query = new URLSearchParams(params);
    const auth = global.Auth?.wsTokenParam?.();
    if (auth) for (const [key, value] of new URLSearchParams(auth)) query.set(key, value);
    return (global.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + global.location.host + path + '?' + query;
  }

  _connect() {
    if (this.disposed || this.status === 'exited' || this.status === 'invalid' || this.status === 'detached') return;
    if (!this.visible) { this._setStatus('disconnected', '窗口已暂停显示'); return; }
    const epoch = ++this.epoch;
    const current = () => !this.disposed && epoch === this.epoch;
    this.serverReady = false;
    this.layoutReceived = false;
    this.layoutCols = null;
    this.layoutRows = null;
    this.layoutZoomed = false;
    this._layoutSyncPending = false;
    this._pendingSelectPane = this._localActivePaneId || null;
    this._settledViewportEnv = null;
    this._cancelResizeTimer();
    this._resetResizeGuard();
    for (const pane of this.panes.values()) {
      pane.hydrated = Boolean(pane.isRich);
      pane.everHydrated = Boolean(pane.isRich);
      pane.restoring = false;
      pane.lastSeq = null;
      pane.pendingWrites = [];
      pane.pendingBytes = 0;
      pane.snapshotAssembly = null;
      pane.historyLoading = false;
      pane.historyRequestedLines = 0;
    }
    this._setStatus('connecting', this.attempt ? '正在重新连接' : '正在连接');

    const ws = new this.global.WebSocket(this._url());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectTimer = this.global.setTimeout(() => { if (current()) this._drop(true, '连接超时'); }, 20_000);
    ws.onopen = () => {};
    ws.onmessage = (event) => {
      if (!current()) return;
      try {
        if (typeof event.data !== 'string') {
          this._handleBinaryFrame(decodeWindowBinaryFrame(event.data), epoch);
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === 'ready' || message.type === 'size-lease') {
          this._handleLeaseMessage(message);
        } else if (message.type === 'layout') {
          this._handleLayoutMessage(message);
        } else if (message.type === 'pane-exit') {
          this._disposePane(message.paneId);
        } else if (message.type === 'clipboard' && typeof message.data === 'string') {
          this.copy(message.data);
        } else if (message.type === 'exit' || message.type === 'window-exit') {
          this._pause(message.reason || (message.type === 'window-exit' ? 'window_closed' : undefined));
        } else if (message.type === 'error') {
          this._drop(message.retryable === true, message.message || '无法连接窗口');
        }
      } catch (error) {
        this._drop(false, error.message || '窗口流协议无效');
      }
    };
    ws.onclose = (event) => {
      if (!current()) return;
      if (event.code === 1000) this._pause(event.reason === 'window closed' ? 'window_closed' : undefined);
      else this._drop(![1008, 1013].includes(event.code), '连接已断开');
    };
    ws.onerror = () => {};
  }

  _handleLeaseMessage(message) {
    if (message.protocol != null && message.protocol !== 1) throw new Error('窗口流协议版本不匹配');
    if (message.instanceId && message.instanceId !== this.target.instanceId) {
      throw new Error('tmux 实例已变化');
    }
    const prevLease = this.sizeLease;
    this.sizeLease = message.sizeLease || 'owner';
    this.foreignClient = Boolean(message.foreignClient);
    this.paneLeases = message.paneLeases && typeof message.paneLeases === 'object' ? message.paneLeases : null;
    this.sizeOverridden = Boolean(message.sizeOverridden);
    this.inputAllowed = typeof message.inputAllowed === 'boolean' ? message.inputAllowed : this.sizeLease !== 'observer';
    this._leasePending = false;
    if (this.sizeLease === 'observer' && this._lastLeaseMode !== 'observer') {
      this._leaseCollapsed = false;
    }
    this._lastLeaseMode = this.sizeLease;
    const nextCols = Number.isInteger(message.windowCols) ? message.windowCols : this.windowCols;
    const nextRows = Number.isInteger(message.windowRows) ? message.windowRows : this.windowRows;
    const nextZoomed = typeof message.zoomed === 'boolean' ? message.zoomed : this.zoomed;
    const geometryChanged = this.layoutReceived && (
      nextCols !== this.layoutCols
      || nextRows !== this.layoutRows
      || nextZoomed !== this.layoutZoomed
    );
    this.windowCols = nextCols;
    this.windowRows = nextRows;
    this.zoomed = nextZoomed;
    if (geometryChanged) {
      this._layoutSyncPending = true;
      this._cancelResizeTimer();
    }
    if (prevLease !== this.sizeLease && this.sizeLease === 'owner') {
      this._settledViewportEnv = null;
      this._resetResizeGuard();
    }
    if (message.type === 'ready') this.serverReady = true;
    this._syncInputGates();
    this._renderLeaseBar();
    this._renderPaneTakeovers();
    this._renderMobilePaneBar();
    this._becameReady();
  }

  _handleLayoutMessage(message) {
    this.layoutReceived = true;
    this._layoutSyncPending = false;
    if (Number.isInteger(message.windowCols)) {
      this.windowCols = message.windowCols;
      this.layoutCols = message.windowCols;
    }
    if (Number.isInteger(message.windowRows)) {
      this.windowRows = message.windowRows;
      this.layoutRows = message.windowRows;
    }
    this.zoomed = Boolean(message.zoomed);
    this.layoutZoomed = this.zoomed;
    this.layoutString = message.layoutString || '';
    this.layoutTree = message.tree || null;
    const panes = Array.isArray(message.panes) ? message.panes : [];
    const liveIds = new Set(panes.map((item) => item.id));
    const activeFromPanes = panes.find((item) => item.active)?.id;
    if (this._localActivePaneId && !liveIds.has(this._localActivePaneId)) {
      this._localActivePaneId = null;
    }
    const preserveMobilePane = this._isMobile() && this._localActivePaneId && liveIds.has(this._localActivePaneId);
    this.activePaneId = preserveMobilePane
      ? this._localActivePaneId
      : (message.activePaneId || activeFromPanes || panes[0]?.id || null);

    let panesTopologyChanged = false;
    for (const paneId of [...this.panes.keys()]) {
      if (!liveIds.has(paneId)) {
        this._disposePane(paneId);
        panesTopologyChanged = true;
      }
    }
    for (const meta of panes) {
      const existed = this.panes.has(meta.id);
      const prevCwd = this.panes.get(meta.id)?.meta?.cwd || '';
      const entry = this._ensurePane(meta);
      this._updatePaneMeta(entry, meta);
      if (!existed || prevCwd !== (meta.cwd || '')) panesTopologyChanged = true;
    }

    this._renderTree();
    if (panesTopologyChanged) this._emitPanesChanged();
    for (const meta of panes) {
      const entry = this.panes.get(meta.id);
      if (!entry) continue;
      this._ensurePaneRenderer(entry, meta);
      if (!entry.isRich && entry.term && !entry.restoring && Number.isInteger(meta.width) && Number.isInteger(meta.height) && meta.width >= 2 && meta.height >= 2) {
        if (entry.term.cols !== meta.width || entry.term.rows !== meta.height) {
          entry.term.resize(meta.width, meta.height);
        }
      }
    }

    this._renderLeaseBar();
    this._renderPaneTakeovers();
    this._syncActivePaneState();
    this._renderMobilePaneBar();
    this._publishContext();
    this._syncInputGates();
    this.syncAttention();
    this._becameReady();
    this._reportPaneFocus();
  }

  _handleBinaryFrame(frame, epoch) {
    let entry = this.panes.get(frame.paneId);
    if (!entry) {
      entry = this._ensurePane({ id: frame.paneId, index: Number(frame.paneId.slice(1)) || 0, active: this.activePaneId === frame.paneId });
      this._ensurePaneRenderer(entry, entry.meta);
    }
    if (entry.isRich || !entry.term) return;
    if (frame.kind === 'output') {
      if (entry.lastSeq !== null && frame.seq <= entry.lastSeq) return;
      entry.lastSeq = frame.seq;
      if (entry.restoring) {
        entry.pendingBytes += frame.data.byteLength;
        if (entry.pendingBytes > MAX_RENDER_BACKLOG) { this._drop(true, '终端输出积压，正在恢复'); return; }
        entry.pendingWrites.push(frame.data);
        return;
      }
      if (entry.hydrated) {
        this._queueLiveWrite(entry, frame.data, epoch);
      }
      return;
    }

    if (frame.kind === 'snapshot-chunk') {
      if (frame.chunkCount < 1 || frame.chunkIndex >= frame.chunkCount) return;
      let asm = entry.snapshotAssembly;
      if (!asm || asm.seq !== frame.seq || asm.chunkCount !== frame.chunkCount) {
        asm = {
          seq: frame.seq,
          chunkCount: frame.chunkCount,
          cols: frame.cols,
          rows: frame.rows,
          historyLines: frame.historyLines,
          historyTotal: frame.historyTotal,
          parts: new Array(frame.chunkCount),
          received: 0,
          totalBytes: 0,
        };
        entry.snapshotAssembly = asm;
      }
      if (!asm.parts[frame.chunkIndex]) {
        asm.parts[frame.chunkIndex] = frame.data;
        asm.received += 1;
        asm.totalBytes += frame.data.byteLength;
      }
      if (asm.received < asm.chunkCount) return;
      const merged = new Uint8Array(asm.totalBytes);
      let offset = 0;
      for (const part of asm.parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      entry.snapshotAssembly = null;
      frame = {
        kind: 'snapshot',
        paneId: frame.paneId,
        seq: asm.seq,
        cols: asm.cols,
        rows: asm.rows,
        historyLines: asm.historyLines,
        historyTotal: asm.historyTotal,
        data: merged,
      };
    } else {
      entry.snapshotAssembly = null;
    }

    // Snapshot fence (`0x02` or assembled `0x03`): always authoritative over an ordered WebSocket.
    const prevBuf = entry.everHydrated ? entry.term.buffer?.active : null;
    const preserveScrollFromBottom = (
      prevBuf
      && prevBuf.type !== 'alternate'
      && Number(prevBuf.baseY) > 0
      && Number(prevBuf.viewportY) < Number(prevBuf.baseY)
    ) ? (Number(prevBuf.baseY) - Number(prevBuf.viewportY)) : 0;
    const prevReq = entry.historyRequestedLines || 0;
    const prevLines = entry.historyPrevLines || 0;
    entry.lastSeq = frame.seq;
    entry.historyTotal = frame.historyTotal;
    entry.historyLines = frame.historyLines;
    entry.historyLoading = false;
    entry.historyRequestedLines = 0;
    if (prevReq > 0 && frame.historyLines <= prevLines && frame.historyTotal > frame.historyLines) {
      entry.historyExhausted = true;
    } else if (frame.historyLines > prevLines) {
      entry.historyExhausted = false;
    }
    entry.hydrated = false;
    entry.restoring = true;
    entry.pendingWrites = [];
    entry.pendingBytes = 0;
    entry.liveChunks = [];
    entry.liveBytes = 0;
    const snapEpoch = (entry.snapshotEpoch = (entry.snapshotEpoch || 0) + 1);
    this._syncInputGates();

    const finishRestore = () => {
      if (this.disposed || epoch !== this.epoch || snapEpoch !== entry.snapshotEpoch || !this.panes.has(entry.paneId)) return;
      entry.hydrated = true;
      entry.everHydrated = true;
      entry.restoring = false;
      const queued = entry.pendingWrites.splice(0);
      entry.pendingBytes = 0;
      for (const chunk of queued) this._queueLiveWrite(entry, chunk, epoch);
      if (preserveScrollFromBottom > 0) {
        const nextBuf = entry.term.buffer?.active;
        if (nextBuf && nextBuf.type !== 'alternate' && Number(nextBuf.baseY) > 0) {
          entry.term.scrollToLine?.(Math.max(0, Number(nextBuf.baseY) - preserveScrollFromBottom));
        }
      }
      this._syncInputGates();
      this._syncMobileViewportTransform(entry);
      this._syncHistoryPill(entry);
      this._becameReady();
    };

    const hasRis = frame.data.byteLength >= 2 && frame.data[0] === 0x1b && frame.data[1] === 0x63;
    if (!hasRis) entry.term.reset();
    if (frame.cols >= 2 && frame.rows >= 2 && (entry.term.cols !== frame.cols || entry.term.rows !== frame.rows)) {
      entry.term.resize(frame.cols, frame.rows);
    }
    if (frame.data.byteLength === 0) {
      finishRestore();
    } else if (hasRis) {
      const body = frame.data.subarray(2);
      const wrapped = new Uint8Array(2 + SYNC_UPDATE_START.byteLength + body.byteLength + SYNC_UPDATE_END.byteLength);
      wrapped[0] = 0x1b;
      wrapped[1] = 0x63;
      wrapped.set(SYNC_UPDATE_START, 2);
      wrapped.set(body, 2 + SYNC_UPDATE_START.byteLength);
      wrapped.set(SYNC_UPDATE_END, 2 + SYNC_UPDATE_START.byteLength + body.byteLength);
      entry.term.write(wrapped, finishRestore);
    } else {
      entry.term.write(frame.data, finishRestore);
    }
  }

  _ackOutput(paneId, bytes) {
    if (this.disposed || this.status !== 'live' || !(bytes > 0)) return;
    const next = (this._pendingAcks.get(paneId) || 0) + bytes;
    this._pendingAcks.set(paneId, next);
    if (next >= 64 * 1024) {
      this._flushAcks();
      return;
    }
    if (this._ackTimer == null) {
      this._ackTimer = this.global.setTimeout(() => {
        this._ackTimer = null;
        this._flushAcks();
      }, 4);
    }
  }

  _flushAcks() {
    if (this._ackTimer != null) {
      this.global.clearTimeout(this._ackTimer);
      this._ackTimer = null;
    }
    if (!this._pendingAcks.size || this.disposed || this.ws?.readyState !== 1) return;
    for (const [paneId, bytes] of this._pendingAcks.entries()) {
      if (bytes > 0) this._send({ type: 'ack', paneId, bytes });
    }
    this._pendingAcks.clear();
  }

  _queueLiveWrite(entry, bytes, epoch) {
    if (!bytes?.byteLength) return;
    entry.liveBytes += bytes.byteLength;
    if (entry.liveBytes > MAX_RENDER_BACKLOG) {
      this._drop(true, '终端输出积压，正在恢复完整画面');
      return;
    }
    entry.liveChunks.push(bytes);
    if (entry.flushScheduled) return;
    entry.flushScheduled = true;
    const schedule = typeof this.global.queueMicrotask === 'function'
      ? (fn) => this.global.queueMicrotask(fn)
      : (fn) => Promise.resolve().then(fn);
    schedule(() => {
      entry.flushScheduled = false;
      if (this.disposed || epoch !== this.epoch || entry.restoring || !this.panes.has(entry.paneId)) return;
      if (!entry.liveChunks.length) return;
      const chunks = entry.liveChunks.splice(0);
      entry.liveBytes = 0;
      if (chunks.length === 1) {
        const len = chunks[0].byteLength;
        entry.term.write(chunks[0], () => {
          if (!this.disposed && epoch === this.epoch) this._ackOutput(entry.paneId, len);
        });
      } else {
        let total = 0;
        for (const chunk of chunks) total += chunk.byteLength;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        entry.term.write(merged, () => {
          if (!this.disposed && epoch === this.epoch) this._ackOutput(entry.paneId, total);
        });
      }
    });
  }

  _reportPaneFocus() {
    if (this.disposed || this.status !== 'live' || this.ws?.readyState !== 1) return;
    const singlePane = (this.zoomed || this._isMobileSinglePane()) && this.activePaneId && this.panes.has(this.activePaneId);
    const visiblePaneIds = singlePane ? [this.activePaneId] : null;
    const sig = `${this.activePaneId || ''}|${visiblePaneIds ? visiblePaneIds.join(',') : '*'}`;
    if (sig === this._lastFocusSig) return;
    this._lastFocusSig = sig;
    this._send({
      type: 'pane-focus',
      paneId: this.activePaneId || null,
      visiblePaneIds,
    });
  }

  _syncHistoryPill(entry) {
    const pill = entry?.historyPill;
    const buf = entry?.term?.buffer?.active;
    if (!pill || !buf || entry.isRich || buf.type === 'alternate') {
      if (pill) pill.hidden = true;
      return;
    }
    if (entry.historyLoading) {
      pill.textContent = '正在加载更早历史…';
      pill.hidden = false;
      return;
    }
    const remaining = (entry.historyTotal || 0) - (entry.historyLines || 0);
    if (remaining > 0 && Number(buf.viewportY) <= 4 && ((entry.historyLines || 0) >= 10_000 || entry.historyExhausted)) {
      pill.textContent = `还有 ${remaining} 行更早历史 · 打开完整历史`;
      pill.hidden = false;
      return;
    }
    pill.hidden = true;
  }

  _checkHistoryExpand(entry) {
    if (this.disposed || this.status !== 'live' || !entry?.term || entry.isRich || !entry.hydrated || entry.restoring) return;
    if (entry.historyLoading || entry.historyExhausted) return;
    const buf = entry.term.buffer?.active;
    if (!buf || buf.type === 'alternate') return;
    if (Number(buf.viewportY) > 24) return;
    const total = entry.historyTotal || 0;
    const loaded = entry.historyLines || 0;
    if (total <= loaded || loaded >= 10_000) {
      this._syncHistoryPill(entry);
      return;
    }
    const now = Date.now();
    if (now - (entry.historyLastAttemptAt || 0) < 1200) return;
    const nextTarget = Math.min(10_000, total, loaded < 5000 ? 5000 : 10_000);
    if (nextTarget <= loaded) return;
    entry.historyLoading = true;
    entry.historyPrevLines = loaded;
    entry.historyRequestedLines = nextTarget;
    entry.historyLastAttemptAt = now;
    this._syncHistoryPill(entry);
    this._send({
      type: 'resync',
      paneId: entry.paneId,
      forceSnapshot: true,
      historyLines: nextTarget,
    });
  }

  _becameReady() {
    if (!this.serverReady || !this.layoutReceived || !this.panes.size) return;
    const allHydrated = [...this.panes.values()].every((pane) => pane.isRich || pane.hydrated);
    if (!allHydrated && !this.hydrated) return;
    this.global.clearTimeout(this.connectTimer);
    this.attempt = 0;
    if (this.status !== 'live') this._setStatus('live');
    else this._syncInputGates();
    if (this._pendingSelectPane && this.panes.has(this._pendingSelectPane)) {
      const pendingPane = this._pendingSelectPane;
      this._pendingSelectPane = null;
      this._send({ type: 'select-pane', paneId: pendingPane });
    }
    this._reportPaneFocus();
    this._publishContext();
    this.fit();
  }

  _createTerminalInstance() {
    const mobile = !!this.global.MobileUI?.isMobile();
    const term = new this.global.Terminal({
      theme: this.global.Theme?.getTerminalTheme?.(),
      minimumContrastRatio: 4.5,
      allowTransparency: Boolean(this.global.Theme?.isBackdropActive?.() || (this.global.Theme?.getTransparency?.() || 0) > 0),
      fontFamily: this.fontReady ? FONT_FAMILY : 'monospace',
      fontSize: this.fontSize,
      lineHeight: this.lineHeight,
      cursorStyle: this.cursorStyle,
      cursorBlink: this.cursorBlink,
      scrollback: 10000,
      scrollSensitivity: 1.15,
      fastScrollSensitivity: 5,
      overviewRuler: { width: 0 },
      rescaleOverlappingGlyphs: false,
      macOptionClickForcesSelection: mobile,
      convertEol: false,
      allowProposedApi: true,
      disableStdin: true,
    });
    const fitAddon = this.global.FitAddon?.FitAddon ? new this.global.FitAddon.FitAddon() : null;
    if (fitAddon) term.loadAddon(fitAddon);
    return { term, fitAddon };
  }

  _teardownPaneRenderer(entry) {
    this._clearHoverTimer(entry);
    entry.inputBatchActive = false;
    entry.inputBatchBuf = '';
    entry.pointerType = null;
    for (const cleanup of entry.cleanups) {
      if (typeof cleanup === 'function') cleanup();
      else cleanup?.dispose?.();
    }
    entry.cleanups = [];
    entry.linkProvider?.dispose?.();
    entry.linkProvider = null;
    entry.webglAddon?.dispose?.();
    entry.webglAddon = null;
    entry.term?.dispose?.();
    entry.term = null;
    entry.fitAddon = null;
    entry.tileHandle?.dispose?.();
    entry.tileHandle = null;
    entry.opened = false;
    entry.body.replaceChildren();
  }

  _ensurePaneRenderer(entry, meta = entry.meta) {
    const kind = meta.kind && meta.kind !== 'terminal' ? meta.kind : 'terminal';
    const payload = kind !== 'terminal' ? (meta.payload || '') : '';
    const isRich = kind !== 'terminal';
    const registry = this.global.TileRegistry || TileRegistry;

    if (isRich) {
      if (entry.isRich && entry.renderedKind === kind && entry.tileHandle) {
        if (entry.renderedPayload !== payload) {
          entry.renderedPayload = payload;
          entry.tileHandle.update?.({
            global: this.global,
            serverId: this.target.serverId,
            windowId: this.target.windowId,
            paneId: entry.paneId,
            kind,
            payload,
            payloadData: parseTilePayload(payload),
            onUpdatePayload: (next) => this.onAction('set-pane-payload', { paneId: entry.paneId, payload: next }),
            onConvertToTerminal: () => this.onAction('set-pane-kind', { paneId: entry.paneId, kind: 'terminal' }),
            onClose: () => (this.panes.size <= 1 ? this.onAction('close-window', { paneId: entry.paneId }) : this.onAction('close-pane', { paneId: entry.paneId })),
          });
        }
        return;
      }
      this._teardownPaneRenderer(entry);
      entry.isRich = true;
      entry.renderedKind = kind;
      entry.renderedPayload = payload;
      entry.hydrated = true;
      entry.everHydrated = true;
      entry.restoring = false;
      entry.el.classList.add('is-rich');
      entry.tileHandle = registry.mount(kind, entry.body, {
        global: this.global,
        serverId: this.target.serverId,
        windowId: this.target.windowId,
        paneId: entry.paneId,
        payload,
        payloadData: parseTilePayload(payload),
        onUpdatePayload: (next) => this.onAction('set-pane-payload', { paneId: entry.paneId, payload: next }),
        onConvertToTerminal: () => this.onAction('set-pane-kind', { paneId: entry.paneId, kind: 'terminal' }),
        onClose: () => (this.panes.size <= 1 ? this.onAction('close-window', { paneId: entry.paneId }) : this.onAction('close-pane', { paneId: entry.paneId })),
      });
      return;
    }

    if (entry.isRich) {
      this._teardownPaneRenderer(entry);
      entry.hydrated = false;
      entry.everHydrated = false;
    }
    entry.isRich = false;
    entry.renderedKind = 'terminal';
    entry.renderedPayload = '';
    entry.el.classList.remove('is-rich');
    if (!entry.term) {
      const created = this._createTerminalInstance();
      entry.term = created.term;
      entry.fitAddon = created.fitAddon;
    }
    if (!entry.opened && entry.body.isConnected) {
      entry.opened = true;
      entry.term.open(entry.body);
      this._setupPaneAddonsAndBindings(entry);
    }
  }

  _ensurePane(meta) {
    const paneId = meta.id;
    let entry = this.panes.get(paneId);
    if (entry) return entry;

    const doc = this.global.document;
    const isRich = Boolean(meta.kind && meta.kind !== 'terminal');
    const created = isRich ? { term: null, fitAddon: null } : this._createTerminalInstance();
    const term = created.term;
    const fitAddon = created.fitAddon;

    const el = doc.createElement('section');
    el.className = 'seam-pane';
    el.dataset.paneId = paneId;

    const rail = doc.createElement('header');
    rail.className = 'seam-rail';
    rail.dataset.contextZone = 'pane-rail';
    rail.dataset.paneId = paneId;

    const num = doc.createElement('span');
    num.className = 'pane-num';
    const agentStateEl = doc.createElement('span');
    agentStateEl.className = 'pane-agent-state';
    agentStateEl.hidden = true;
    const ico = doc.createElement('span');
    ico.className = 'pane-proc-ico';
    const identity = doc.createElement('div');
    identity.className = 'pane-identity';
    const titleEl = doc.createElement('span');
    titleEl.className = 'pane-title';
    titleEl.title = '双击重命名窗格';
    const cmdChip = doc.createElement('span');
    cmdChip.className = 'pane-cmd-chip';
    const ctxEl = doc.createElement('span');
    ctxEl.className = 'pane-ctx';
    const statusBadge = doc.createElement('span');
    statusBadge.className = 'pane-status';
    statusBadge.hidden = true;
    identity.append(titleEl, cmdChip, ctxEl, statusBadge);

    const actions = doc.createElement('div');
    actions.className = 'pane-actions';
    const gitSlot = doc.createElement('div');
    gitSlot.className = 'pane-git-slot';
    gitSlot.dataset.paneId = paneId;
    gitSlot.hidden = true;
    const makeBtn = (action, label, icon, extraClass = '') => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'pane-btn ' + extraClass;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.dataset.paneAction = action;
      btn.innerHTML = icon;
      return btn;
    };
    const splitHBtn = makeBtn('split-h', '左右分窗', PANE_ICONS.splitH, 'is-secondary');
    const splitVBtn = makeBtn('split-v', '上下分窗', PANE_ICONS.splitV, 'is-secondary');
    const zoomBtn = makeBtn('zoom', '放大/还原窗格', PANE_ICONS.zoom, 'is-secondary');
    const menuBtn = makeBtn('menu', '窗格菜单', PANE_ICONS.more, 'is-pane-menu');
    const closeBtn = makeBtn('close', '关闭窗格', PANE_ICONS.close, 'is-secondary is-close');
    actions.append(splitHBtn, splitVBtn, zoomBtn, menuBtn, closeBtn);

    const confirmBox = doc.createElement('div');
    confirmBox.className = 'pane-confirm';
    confirmBox.hidden = true;
    const confirmLabel = doc.createElement('span');
    confirmLabel.className = 'pane-confirm-label';
    confirmLabel.textContent = '关闭窗格?';
    const confirmYes = doc.createElement('button');
    confirmYes.type = 'button';
    confirmYes.className = 'pane-confirm-btn is-danger';
    confirmYes.textContent = '确认';
    const confirmNo = doc.createElement('button');
    confirmNo.type = 'button';
    confirmNo.className = 'pane-confirm-btn';
    confirmNo.textContent = '取消';
    confirmBox.append(confirmLabel, confirmYes, confirmNo);

    rail.append(num, agentStateEl, ico, identity, gitSlot, actions, confirmBox);

    const body = doc.createElement('div');
    body.className = 'pane-body';
    body.dataset.contextZone = 'pane-body';
    body.dataset.paneId = paneId;

    const historyPill = doc.createElement('button');
    historyPill.type = 'button';
    historyPill.className = 'wb-history-pill';
    historyPill.hidden = true;
    historyPill.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAction('history', { paneId });
    });

    const takeoverEl = doc.createElement('div');
    takeoverEl.className = 'seam-pane-takeover';
    takeoverEl.hidden = true;

    el.append(rail, body, historyPill, takeoverEl);

    entry = {
      paneId,
      meta: { ...meta },
      el,
      rail,
      body,
      historyPill,
      takeoverEl,
      takeoverCollapsed: false,
      fitScale: 1,
      userScale: 1,
      panX: 0,
      panY: 0,
      num,
      agentStateEl,
      ico,
      titleEl,
      cmdChip,
      ctxEl,
      statusBadge,
      gitSlot,
      actions,
      zoomBtn,
      confirmBox,
      term,
      fitAddon,
      webglAddon: null,
      linkProvider: null,
      tileHandle: null,
      isRich,
      renderedKind: null,
      renderedPayload: null,
      cleanups: [],
      opened: false,
      hydrated: isRich,
      everHydrated: isRich,
      restoring: false,
      lastSeq: null,
      pendingWrites: [],
      pendingBytes: 0,
      liveChunks: [],
      liveBytes: 0,
      flushScheduled: false,
      pointerType: null,
      inputBatchActive: false,
      inputBatchBuf: '',
      pendingHoverSeq: null,
      hoverTimer: null,
      historyTotal: 0,
      historyLines: 0,
      historyLoading: false,
      historyExhausted: false,
      historyRequestedLines: 0,
      historyPrevLines: 0,
      historyLastAttemptAt: 0,
      snapshotAssembly: null,
    };

    const focusThisPane = () => {
      if (this.disposed) return;
      if (this.activePaneId !== paneId) this.selectPane(paneId);
      else this.onFocus();
    };
    el.addEventListener('pointerdown', focusThisPane, true);
    rail.addEventListener('click', (event) => {
      if (event.target.closest('.pane-git-slot')) return;
      const btn = event.target.closest('[data-pane-action]');
      if (!btn) {
        focusThisPane();
        if (!this._isMobile()) entry.term?.focus();
        return;
      }
      event.stopPropagation();
      const action = btn.dataset.paneAction;
      if (action === 'split-h') this.onAction('split', { paneId, direction: 'horizontal' });
      else if (action === 'split-v') this.onAction('split', { paneId, direction: 'vertical' });
      else if (action === 'zoom') this.zoomPane(paneId);
      else if (action === 'menu') this._openPaneRailMenu(paneId, { anchor: btn });
      else if (action === 'close') {
        if (this.panes.size <= 1) this.onAction('close-window', { paneId });
        else { actions.hidden = true; confirmBox.hidden = false; el.classList.add('is-confirming'); }
      }
    });
    confirmYes.addEventListener('click', (event) => {
      event.stopPropagation();
      confirmBox.hidden = true; actions.hidden = false; el.classList.remove('is-confirming');
      this.onAction('close-pane', { paneId });
    });
    confirmNo.addEventListener('click', (event) => {
      event.stopPropagation();
      confirmBox.hidden = true; actions.hidden = false; el.classList.remove('is-confirming');
    });
    titleEl.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.startRenamePane(paneId);
    });

    this.panes.set(paneId, entry);
    return entry;
  }

  _setupPaneAddonsAndBindings(entry) {
    const { paneId, term, body, cleanups } = entry;
    const global = this.global;

    cleanups.push(installClipboardHandler(term, (text) => {
      if (!this.disposed && this.status === 'live' && entry.hydrated) this.copy(text);
    }));
    if (term.onTitleChange) {
      cleanups.push(term.onTitleChange((title) => {
        if (this.disposed) return;
        entry.meta.title = title;
        this._updatePaneMeta(entry, entry.meta);
        if (paneId === this.activePaneId) this.onTitle(title);
      }));
    }
    cleanups.push(installInputHandler(term, (data, user) => {
      if (user) {
        if (!entry.composing && !this._duplicateComposition(entry, data)) {
          this.send(data, !entry.pointerDispatch, paneId);
        }
      } else {
        this._sendInput(paneId, data, false);
      }
    }));
    if (term.onBinary) {
      cleanups.push(term.onBinary((data) => {
        if (this.status === 'live' && entry.hydrated) {
          if (!entry.pointerDispatch) this.inputVersion++;
          this._sendInput(paneId, data, true);
        }
      }));
    }
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'wheel']) {
      const handler = () => {
        if (type === 'mousedown' || type === 'wheel') this.inputVersion++;
        entry.pointerDispatch = true;
        entry.pointerType = type;
        global.queueMicrotask(() => {
          entry.pointerDispatch = false;
          entry.pointerType = null;
        });
      };
      body.addEventListener(type, handler, true);
      cleanups.push(() => body.removeEventListener(type, handler, true));
    }
    cleanups.push(installTuiWheelHandler(term, {
      global,
      onBeforeDrain: () => this._beginInputBatch(entry),
      onAfterDrain: () => this._flushInputBatch(entry),
    }));
    this._installCompositionGuard(entry);
    const onMouseUp = () => {
      if (!global.MobileUI?.isMobile()) {
        const selection = term.getSelection?.();
        if (selection) this.copy(selection);
      }
    };
    term.element?.addEventListener('mouseup', onMouseUp);
    cleanups.push(() => term.element?.removeEventListener('mouseup', onMouseUp));
    if (term.onScroll) {
      cleanups.push(term.onScroll(() => {
        this._checkHistoryExpand(entry);
        this._syncHistoryPill(entry);
      }));
    }
    if (term.onWriteParsed) {
      cleanups.push(term.onWriteParsed(() => this._syncHistoryPill(entry)));
    }
    this._installTouchSelection(entry);

    if (entry.paneId === this.activePaneId || this.panes.size <= 1) {
      this._attachWebglAddon(entry);
    } else {
      this._scheduleWebglAddons();
    }
    this._attachPaneLinkProvider(entry);
  }

  _attachWebglAddon(entry) {
    if (this.disposed || this.parked || !this.global.WebglAddon || this.panes.size > MAX_WEBGL_PANES || !entry?.term || entry.isRich || entry.webglAddon) {
      return;
    }
    try {
      const addon = new this.global.WebglAddon.WebglAddon();
      addon.onContextLoss(() => { addon.dispose(); if (entry.webglAddon === addon) entry.webglAddon = null; if (!this.disposed) entry.term?.refresh?.(0, entry.term.rows - 1); });
      entry.term.loadAddon(addon);
      entry.webglAddon = addon;
    } catch { /* canvas fallback */ }
  }

  _cancelWebglAttach() {
    if (this._webglAttachHandle == null) return;
    this.global.clearTimeout(this._webglAttachHandle);
    this._webglAttachHandle = null;
  }

  _releaseWebglAddons() {
    this._cancelWebglAttach();
    for (const pane of this.panes.values()) {
      if (!pane.webglAddon) continue;
      pane.webglAddon.dispose?.();
      pane.webglAddon = null;
    }
  }

  _scheduleWebglAddons() {
    if (this.disposed || this.parked || !this.global.WebglAddon || this.panes.size > MAX_WEBGL_PANES) return;
    if (this._webglAttachHandle != null) return;
    this._webglAttachHandle = this.global.setTimeout(() => {
      this._webglAttachHandle = null;
      if (this.disposed || this.parked || !this.visible || !this.global.WebglAddon || this.panes.size > MAX_WEBGL_PANES) return;
      const active = this.activePaneId && this.panes.get(this.activePaneId);
      if (active) this._attachWebglAddon(active);
      for (const pane of this.panes.values()) {
        if (pane !== active) this._attachWebglAddon(pane);
      }
    }, 0);
  }

  _attachPaneLinkProvider(entry) {
    entry.linkProvider?.dispose?.();
    if (!this.global.FilePreview?.registerLinkProvider) return;
    const { serverId, windowId } = this.target;
    const paneId = entry.paneId;
    const source = Object.freeze({
      serverId,
      paneId,
      isCurrent: () => this.status === 'live' && entry.hydrated && this.target.serverId === serverId,
    });
    const panes = () => Promise.resolve([...this.panes.values()].map((item) => ({
      id: item.paneId,
      cwd: item.meta.cwd || '',
      command: item.meta.command || '',
      title: item.meta.title || '',
    })));
    entry.linkProvider = this.global.FilePreview.registerLinkProvider(entry.term, paneId, () => paneId, source, { panes });
  }

  _resolvePaneAgentVisual(entry) {
    const isRich = Boolean(entry.meta?.kind && entry.meta.kind !== 'terminal');
    if (isRich) return { isRich: true, agentInfo: null, resolvedKind: entry.meta.kind };
    const agentIcons = this.global.AgentIcons;
    const agentInfo = this.global.AgentStatus?.getPane?.(this.target.serverId, entry.paneId)
      || agentIcons?.detectFromPane?.(entry.meta)
      || null;
    const resolvedKind = agentIcons
      ? ((agentInfo && (agentInfo.appKind || agentInfo.agentType))
          || agentIcons.resolveKind(entry.meta?.command || entry.meta?.label || '', agentInfo?.agentType))
      : commandKind(entry.meta?.command || entry.meta?.label);
    return { isRich: false, agentInfo, resolvedKind };
  }

  _updatePaneMeta(entry, meta) {
    const prevCwd = entry.meta?.cwd;
    entry.meta = { ...entry.meta, ...meta };
    const idx = Number.isInteger(entry.meta.index) ? entry.meta.index : Number(entry.paneId.slice(1)) || 0;
    const agentIcons = this.global.AgentIcons;
    const { isRich, agentInfo, resolvedKind } = this._resolvePaneAgentVisual(entry);
    const kind = resolvedKind;

    entry.num.textContent = String(idx);
    entry.ico.className = 'pane-proc-ico is-' + kind;
    if (!isRich && agentIcons?.appIcon) {
      const icoKey = 'agent:' + kind;
      if (entry._icoKey !== icoKey) {
        entry._icoKey = icoKey;
        entry.ico.innerHTML = agentIcons.appIcon(kind);
      }
      const st = agentInfo?.status;
      if (st && st !== 'idle' && st !== 'session_ended' && typeof agentIcons.statusIcon === 'function') {
        const stateKey = st + ':' + Boolean(agentInfo.unread);
        if (entry._agentStateKey !== stateKey) {
          entry._agentStateKey = stateKey;
          entry.agentStateEl.innerHTML = agentIcons.statusIcon(st, agentInfo.unread);
        }
        entry.agentStateEl.hidden = false;
      } else {
        entry._agentStateKey = '';
        entry.agentStateEl.hidden = true;
        entry.agentStateEl.innerHTML = '';
      }
    } else {
      const icoKey = isRich ? (PANE_ICONS[kind] ? kind : 'rich') : (PANE_ICONS[kind] ? kind : 'shell');
      if (entry._icoKey !== icoKey) {
        entry._icoKey = icoKey;
        entry.ico.innerHTML = PANE_ICONS[icoKey] || PANE_ICONS.shell;
      }
      entry._agentStateKey = '';
      entry.agentStateEl.hidden = true;
      entry.agentStateEl.innerHTML = '';
    }

    const parsedPayload = isRich ? parseTilePayload(entry.meta.payload) : null;
    const richFallbackTitle = isRich
      ? (kind === 'diff'
        ? (parsedPayload?.path && parsedPayload.path !== '.' ? 'Git · ' + basenameOf(parsedPayload.path) : 'Git 预览')
        : '[' + kind + '] ' + (parsedPayload?.url || parsedPayload?.path || kind))
      : '';
    let fallbackTitle = entry.meta.title || entry.meta.command || ('窗格 ' + idx);
    if (!isRich && !entry.meta.label && !entry.agentStateEl.hidden && agentIcons?.stripTitle && entry.meta.title) {
      fallbackTitle = agentIcons.stripTitle(entry.meta.title) || fallbackTitle;
    }
    const primaryTitle = entry.meta.label || (isRich ? richFallbackTitle : fallbackTitle);
    entry.titleEl.textContent = primaryTitle;
    entry.titleEl.title = isRich && kind === 'diff' && parsedPayload?.path && parsedPayload.path !== '.'
      ? parsedPayload.path
      : '双击重命名窗格';
    const rawCmd = isRich ? '' : basenameOf(entry.meta.command);
    const chipCmd = (!isRich && agentInfo?.agentType && agentIcons?.labelOf && /^(?:node|nodejs|python\d?|bun|deno|agy)$/i.test(rawCmd))
      ? agentIcons.labelOf(agentInfo.agentType)
      : rawCmd;
    entry.cmdChip.textContent = chipCmd && chipCmd !== primaryTitle ? chipCmd : '';
    entry.cmdChip.hidden = !entry.cmdChip.textContent;
    const cwdShort = basenameOf(entry.meta.cwd);
    entry.ctxEl.textContent = cwdShort || '';
    entry.ctxEl.title = entry.meta.cwd || '';
    entry.ctxEl.hidden = !cwdShort;
    const isZoomed = this.zoomed && entry.paneId === this.activePaneId;
    entry.zoomBtn.classList.toggle('is-zoomed', isZoomed);
    const zoomKey = isZoomed ? 'unzoom' : 'zoom';
    if (entry._zoomIconKey !== zoomKey) {
      entry._zoomIconKey = zoomKey;
      entry.zoomBtn.innerHTML = PANE_ICONS[zoomKey];
    }
    if (!isRich && entry.opened && prevCwd !== entry.meta.cwd) {
      this._attachPaneLinkProvider(entry);
    }
  }

  _syncAgentVisuals() {
    if (this.disposed) return;
    for (const entry of this.panes.values()) {
      if (entry.titleEl.hidden) continue; // preserve active inline rename input
      this._updatePaneMeta(entry, entry.meta);
    }
    this._renderMobilePaneBar();
  }

  _syncActivePaneState() {
    for (const entry of this.panes.values()) {
      const isActive = entry.paneId === this.activePaneId;
      const isZoomed = this.zoomed && isActive;
      entry.el.classList.toggle('is-active', isActive);
      entry.zoomBtn.classList.toggle('is-zoomed', isZoomed);
      const zoomKey = isZoomed ? 'unzoom' : 'zoom';
      if (entry._zoomIconKey !== zoomKey) {
        entry._zoomIconKey = zoomKey;
        entry.zoomBtn.innerHTML = PANE_ICONS[zoomKey];
      }
    }
  }

  _renderLeaseBar() {
    const doc = this.global.document;
    this.leaseBar.replaceChildren();
    if (this.sizeLease === 'observer') {
      if (!this._leaseCollapsed) {
        this.leaseBar.hidden = false;
        this.leaseBar.className = 'seam-lease-bar is-overlay is-driving';
        this.leaseBar.setAttribute('role', 'dialog');
        this.leaseBar.setAttribute('aria-live', 'assertive');

        const card = doc.createElement('div');
        card.className = 'seam-takeover-card';

        const iconWrap = doc.createElement('div');
        iconWrap.className = 'seam-takeover-icon';
        iconWrap.innerHTML = PANE_ICONS.device;
        const dot = doc.createElement('span');
        dot.className = 'seam-takeover-dot';
        dot.setAttribute('aria-hidden', 'true');
        iconWrap.append(dot);

        const body = doc.createElement('div');
        body.className = 'seam-takeover-body';
        const title = doc.createElement('div');
        title.className = 'seam-takeover-title';
        title.textContent = '其他端正在控制此窗口';
        const desc = doc.createElement('div');
        desc.className = 'seam-takeover-desc';
        desc.textContent = '当前端输入已暂停，输出仍在实时同步（' + this.windowCols + '×' + this.windowRows + '）。';

        const actions = doc.createElement('div');
        actions.className = 'seam-takeover-actions';
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'seam-lease-btn is-primary';
        btn.disabled = this._leasePending;
        btn.textContent = this._leasePending ? '正在接管…' : '接管控制';
        btn.addEventListener('click', () => this.takeover());
        actions.append(btn);

        body.append(title, desc, actions);

        const minBtn = doc.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'seam-takeover-min';
        minBtn.title = '最小化为角标';
        minBtn.setAttribute('aria-label', '最小化');
        minBtn.innerHTML = PANE_ICONS.minimize;
        minBtn.addEventListener('click', () => {
          this._leaseCollapsed = true;
          this._renderLeaseBar();
        });

        card.append(iconWrap, body, minBtn);
        this.leaseBar.append(card);
        return;
      }

      this.leaseBar.hidden = false;
      this.leaseBar.className = 'seam-lease-bar is-chip is-driving';
      this.leaseBar.setAttribute('role', 'status');
      this.leaseBar.removeAttribute('aria-live');

      const chip = doc.createElement('div');
      chip.className = 'seam-takeover-chip';

      const iconWrap = doc.createElement('span');
      iconWrap.className = 'seam-takeover-icon is-compact';
      iconWrap.innerHTML = PANE_ICONS.device;
      const dot = doc.createElement('span');
      dot.className = 'seam-takeover-dot';
      dot.setAttribute('aria-hidden', 'true');
      iconWrap.append(dot);

      const expandBtn = doc.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'seam-chip-expand';
      expandBtn.textContent = '其他端控制中';
      expandBtn.title = '展开控制详情';
      expandBtn.addEventListener('click', () => {
        this._leaseCollapsed = false;
        this._renderLeaseBar();
      });

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'seam-lease-btn is-primary is-compact';
      btn.disabled = this._leasePending;
      btn.textContent = this._leasePending ? '正在接管…' : '接管';
      btn.addEventListener('click', () => this.takeover());

      chip.append(iconWrap, expandBtn, btn);
      this.leaseBar.append(chip);
      return;
    }

    if (this.sizeLease === 'follow-foreign' || this.sizeLease === 'follow-peer') {
      this.leaseBar.hidden = false;
      this.leaseBar.className = 'seam-lease-bar is-chip is-held';
      this.leaseBar.setAttribute('role', 'status');
      this.leaseBar.removeAttribute('aria-live');

      const chip = doc.createElement('div');
      chip.className = 'seam-takeover-chip';
      const iconWrap = doc.createElement('span');
      iconWrap.className = 'seam-takeover-icon is-compact';
      iconWrap.innerHTML = PANE_ICONS.device;
      const label = doc.createElement('span');
      label.className = 'seam-chip-label';
      const activePane = this.activePaneId && this.panes.get(this.activePaneId);
      const dispCols = this.sizeLease === 'follow-peer' ? (activePane?.meta?.width || this.windowCols) : this.windowCols;
      const dispRows = this.sizeLease === 'follow-peer' ? (activePane?.meta?.height || this.windowRows) : this.windowRows;
      label.title = this.sizeLease === 'follow-peer'
        ? '桌面端控制窗口布局，当前窗格可直接操作并自动缩放适配'
        : '其他客户端正在控制窗口尺寸，当前可继续输入';
      label.textContent = (this.sizeLease === 'follow-peer' ? '跟随尺寸 ' : '其他端尺寸 ') + dispCols + '×' + dispRows;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'seam-lease-btn is-primary is-compact';
      btn.disabled = this._leasePending;
      btn.textContent = this._leasePending ? '正在接管…' : (this.sizeLease === 'follow-peer' ? '适配尺寸' : '接管尺寸');
      btn.addEventListener('click', () => (
        this.sizeLease === 'follow-peer'
          ? this.takeover({ paneId: this.activePaneId, claimSize: true })
          : this.takeover()
      ));
      chip.append(iconWrap, label, btn);
      this.leaseBar.append(chip);
      return;
    }

    if (this.sizeLease === 'owner' && (this.foreignClient || this.sizeOverridden)) {
      this.leaseBar.hidden = false;
      this.leaseBar.className = 'seam-lease-bar is-chip is-taken';
      this.leaseBar.setAttribute('role', 'status');
      this.leaseBar.removeAttribute('aria-live');

      const chip = doc.createElement('div');
      chip.className = 'seam-takeover-chip';
      const label = doc.createElement('span');
      label.className = 'seam-chip-label';
      label.textContent = '已接管尺寸 ' + this.windowCols + '×' + this.windowRows;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'seam-lease-btn is-compact';
      btn.textContent = '恢复跟随';
      btn.addEventListener('click', () => this.releaseTakeover());
      chip.append(label, btn);
      this.leaseBar.append(chip);
      return;
    }

    this.leaseBar.hidden = true;
    this.leaseBar.className = 'seam-lease-bar';
    this.leaseBar.removeAttribute('role');
    this.leaseBar.removeAttribute('aria-live');
  }

  _renderPaneTakeovers() {
    const doc = this.global.document;
    for (const entry of this.panes.values()) {
      if (!entry.takeoverEl) continue;
      const lease = this.paneLeases?.[entry.paneId];
      const drivenRemotely = Boolean(this.sizeLease !== 'observer' && lease && lease.inputAllowed === false);
      entry.el.classList.toggle('is-driven-remote', drivenRemotely);
      if (!drivenRemotely) {
        entry.takeoverEl.hidden = true;
        entry.takeoverEl.className = 'seam-pane-takeover';
        entry.takeoverEl.replaceChildren();
        entry.takeoverCollapsed = false;
        continue;
      }

      const driverLabel = lease.driverDevice === 'mobile' ? '手机端' : '其他端';
      entry.takeoverEl.hidden = false;
      if (!entry.takeoverCollapsed) {
        entry.takeoverEl.className = 'seam-pane-takeover is-overlay';
        const card = doc.createElement('div');
        card.className = 'seam-takeover-card is-pane';

        const iconWrap = doc.createElement('div');
        iconWrap.className = 'seam-takeover-icon';
        iconWrap.innerHTML = PANE_ICONS.device;
        const dot = doc.createElement('span');
        dot.className = 'seam-takeover-dot';
        dot.setAttribute('aria-hidden', 'true');
        iconWrap.append(dot);

        const body = doc.createElement('div');
        body.className = 'seam-takeover-body';
        const title = doc.createElement('div');
        title.className = 'seam-takeover-title';
        title.textContent = driverLabel + '正在控制此窗格';
        const desc = doc.createElement('div');
        desc.className = 'seam-takeover-desc';
        desc.textContent = '当前窗格已锁定只读同步，其余窗格可继续独立操作。';

        const actions = doc.createElement('div');
        actions.className = 'seam-takeover-actions';
        const paneBtn = doc.createElement('button');
        paneBtn.type = 'button';
        paneBtn.className = 'seam-lease-btn is-primary';
        paneBtn.disabled = this._leasePending;
        paneBtn.textContent = this._leasePending ? '正在接管…' : '接管此窗格';
        paneBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          this.takeover({ paneId: entry.paneId });
        });
        actions.append(paneBtn);

        if (this.panes.size > 1) {
          const allBtn = doc.createElement('button');
          allBtn.type = 'button';
          allBtn.className = 'seam-lease-btn';
          allBtn.disabled = this._leasePending;
          allBtn.textContent = '接管全部';
          allBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.takeover();
          });
          actions.append(allBtn);
        }
        body.append(title, desc, actions);

        const minBtn = doc.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'seam-takeover-min';
        minBtn.title = '最小化为角标';
        minBtn.setAttribute('aria-label', '最小化');
        minBtn.innerHTML = PANE_ICONS.minimize;
        minBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          entry.takeoverCollapsed = true;
          this._renderPaneTakeovers();
        });

        card.append(iconWrap, body, minBtn);
        entry.takeoverEl.replaceChildren(card);
      } else {
        entry.takeoverEl.className = 'seam-pane-takeover is-chip';
        const chip = doc.createElement('div');
        chip.className = 'seam-takeover-chip';

        const iconWrap = doc.createElement('span');
        iconWrap.className = 'seam-takeover-icon is-compact';
        iconWrap.innerHTML = PANE_ICONS.device;
        const dot = doc.createElement('span');
        dot.className = 'seam-takeover-dot';
        dot.setAttribute('aria-hidden', 'true');
        iconWrap.append(dot);

        const expandBtn = doc.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'seam-chip-expand';
        expandBtn.textContent = driverLabel + '控制中';
        expandBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          entry.takeoverCollapsed = false;
          this._renderPaneTakeovers();
        });

        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'seam-lease-btn is-primary is-compact';
        btn.disabled = this._leasePending;
        btn.textContent = this._leasePending ? '正在接管…' : '接管此窗格';
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          this.takeover({ paneId: entry.paneId });
        });

        chip.append(iconWrap, expandBtn, btn);
        entry.takeoverEl.replaceChildren(chip);
      }
    }
  }

  _isMobile() {
    return Boolean(this.global.MobileUI?.isMobile?.());
  }

  _isMobileSinglePane() {
    return Boolean(this._isMobile() && !this.zoomed && this.panes.size > 1 && this.activePaneId && this.panes.has(this.activePaneId));
  }

  _renderMobilePaneBar() {
    const doc = this.global.document;
    if (!this._isMobile() || this.panes.size <= 1) {
      this.mobilePaneBar.hidden = true;
      this.mobilePaneBar.replaceChildren();
      return;
    }
    this.mobilePaneBar.hidden = false;
    const tabs = doc.createElement('div');
    tabs.className = 'seam-mobile-pane-tabs';
    const sorted = [...this.panes.values()].sort((a, b) => (a.meta?.index ?? 0) - (b.meta?.index ?? 0));
    for (const entry of sorted) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      const isActive = entry.paneId === this.activePaneId;
      btn.className = 'seam-mobile-pane-tab' + (isActive ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(isActive));
      btn.dataset.paneId = entry.paneId;
      const num = doc.createElement('span');
      num.className = 'pane-num';
      num.textContent = String(Number.isInteger(entry.meta?.index) ? entry.meta.index : Number(entry.paneId.slice(1)) || 0);
      const name = doc.createElement('span');
      name.className = 'seam-mobile-pane-name';
      name.textContent = entry.titleEl?.textContent || entry.meta?.command || ('窗格 ' + num.textContent);
      const agentIcons = this.global.AgentIcons;
      const { isRich, agentInfo, resolvedKind } = this._resolvePaneAgentVisual(entry);
      if (!isRich && agentIcons?.appIcon) {
        const icoWrap = doc.createElement('span');
        icoWrap.className = 'seam-mobile-pane-ico';
        const st = agentInfo?.status;
        const stHtml = (st && st !== 'idle' && st !== 'session_ended' && typeof agentIcons.statusIcon === 'function')
          ? agentIcons.statusIcon(st, agentInfo.unread)
          : '';
        icoWrap.innerHTML = stHtml + agentIcons.appIcon(resolvedKind);
        btn.append(num, icoWrap, name);
      } else {
        btn.append(num, name);
      }
      if (entry.el.classList.contains('is-needs-you')) {
        const dot = doc.createElement('span');
        dot.className = 'seam-mobile-pane-dot';
        dot.setAttribute('aria-hidden', 'true');
        btn.append(dot);
      }
      btn.addEventListener('click', () => this.selectPane(entry.paneId));
      tabs.append(btn);
    }
    this.mobilePaneBar.replaceChildren(tabs);
  }

  _layoutTopologyKey() {
    if (this.zoomed && this.activePaneId && this.panes.has(this.activePaneId)) {
      return 'zoom:' + this.activePaneId;
    }
    if (this._isMobileSinglePane()) {
      return 'mobile-single:' + this.activePaneId;
    }
    if (!this.layoutTree) {
      const firstId = this.panes.values().next().value?.paneId || '';
      return 'single:' + firstId;
    }
    const sig = (node) => {
      if (!node) return '';
      if (node.type === 'pane') return this.panes.has(node.paneId) ? ('P:' + node.paneId) : '';
      const children = (node.children || []).map(sig).filter(Boolean);
      if (!children.length) return '';
      return (node.dir === 'col' ? 'C' : 'R') + '(' + children.join(',') + ')';
    };
    return sig(this.layoutTree);
  }

  _branchFlex(child, dir) {
    const metrics = measureLayoutMetrics(child, this.panes, this._cellMetrics(), this._isMobile() ? MOBILE_PANE_RAIL_PX : PANE_RAIL_PX);
    return dir === 'col'
      ? (metrics.contentRows + ' 1 ' + metrics.chromeH + 'px')
      : (metrics.contentCols + ' 1 ' + metrics.chromeW + 'px');
  }

  _updateDividerMeta(divider, leftNode, rightNode) {
    divider._seamNodes = { leftNode, rightNode };
    const leftPane = firstLeafPaneId(leftNode, 'end');
    const rightPane = firstLeafPaneId(rightNode, 'start');
    if (leftPane) divider.dataset.leftPane = leftPane;
    else delete divider.dataset.leftPane;
    if (rightPane) divider.dataset.rightPane = rightPane;
    else delete divider.dataset.rightPane;
  }

  _createDivider(dir, leftNode, rightNode) {
    const doc = this.global.document;
    const divider = doc.createElement('div');
    divider.className = 'seam-divider ' + (dir === 'col' ? 'is-h' : 'is-v');
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', dir === 'col' ? 'horizontal' : 'vertical');
    divider.tabIndex = 0;
    divider.dataset.contextZone = 'divider';
    divider.dataset.splitDir = dir === 'col' ? 'col' : 'row';
    this._updateDividerMeta(divider, leftNode, rightNode);
    this._bindDivider(divider, dir);
    return divider;
  }

  _syncTreeInPlace(node, domNode) {
    if (!node || !domNode) return false;
    if (node.type === 'pane') return domNode.dataset?.paneId === node.paneId;
    if (!domNode.classList?.contains('seam-split')) return false;
    if (!domNode.classList.contains(node.dir === 'col' ? 'is-col' : 'is-row')) return false;
    const activeChildren = (node.children || []).filter((child) => {
      if (!child) return false;
      if (child.type === 'pane') return this.panes.has(child.paneId);
      return true;
    });
    const branches = [];
    const dividers = [];
    for (const el of domNode.children) {
      if (el.classList?.contains('seam-branch')) branches.push(el);
      else if (el.classList?.contains('seam-divider')) dividers.push(el);
    }
    if (branches.length !== activeChildren.length || dividers.length !== Math.max(0, activeChildren.length - 1)) {
      return false;
    }
    for (let idx = 0; idx < activeChildren.length; idx++) {
      const child = activeChildren[idx];
      const branch = branches[idx];
      if (!this._draggingDivider) {
        branch.style.flex = this._branchFlex(child, node.dir);
      }
      if (!this._syncTreeInPlace(child, branch.firstElementChild)) return false;
      if (idx < dividers.length) {
        this._updateDividerMeta(dividers[idx], child, activeChildren[idx + 1]);
      }
    }
    return true;
  }

  _reconcileNode(node, existingDom) {
    if (!node) return null;
    if (node.type === 'pane') {
      return this.panes.get(node.paneId)?.el || null;
    }
    const activeChildren = (node.children || []).filter((child) => collectLayoutPaneIds(child, this.panes).size > 0);
    if (!activeChildren.length) return null;

    const doc = this.global.document;
    const dir = node.dir === 'col' ? 'col' : 'row';
    const splitClass = dir === 'col' ? 'is-col' : 'is-row';
    const reuseSplit = Boolean(existingDom?.classList?.contains('seam-split') && existingDom.classList.contains(splitClass));
    const split = reuseSplit ? existingDom : doc.createElement('div');
    if (!reuseSplit) split.className = 'seam-split ' + splitClass;

    const oldBranches = [];
    if (reuseSplit) {
      for (const el of split.children) {
        if (el.classList?.contains('seam-branch')) {
          oldBranches.push({ el, panes: collectDomPaneIds(el) });
        }
      }
    }

    const usedBranches = new Set();
    const matched = new Array(activeChildren.length).fill(null);

    // Pass 1: exact single-pane leaf match preserves stationary branches in place.
    for (let i = 0; i < activeChildren.length; i++) {
      const child = activeChildren[i];
      if (child.type !== 'pane') continue;
      const found = oldBranches.find((item) => !usedBranches.has(item) && item.el.firstElementChild?.dataset?.paneId === child.paneId);
      if (found) {
        usedBranches.add(found);
        matched[i] = found.el;
      }
    }

    // Pass 2: largest subtree pane overlap (with same-dir tiebreaker) preserves newly split containers.
    for (let i = 0; i < activeChildren.length; i++) {
      if (matched[i]) continue;
      const child = activeChildren[i];
      const wantPanes = collectLayoutPaneIds(child, this.panes);
      let best = null;
      let bestScore = 0;
      for (const item of oldBranches) {
        if (usedBranches.has(item)) continue;
        let overlap = 0;
        for (const id of wantPanes) {
          if (item.panes.has(id)) overlap++;
        }
        if (overlap === 0) continue;
        const sameSplit = child.type !== 'pane'
          && item.el.firstElementChild?.classList?.contains('seam-split')
          && item.el.firstElementChild?.classList?.contains(child.dir === 'col' ? 'is-col' : 'is-row');
        const score = overlap + (sameSplit ? 0.5 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (best) {
        usedBranches.add(best);
        matched[i] = best.el;
      }
    }

    const branches = [];
    for (let i = 0; i < activeChildren.length; i++) {
      const child = activeChildren[i];
      const branch = matched[i] || doc.createElement('div');
      if (!matched[i]) branch.className = 'seam-branch';
      if (!this._draggingDivider) {
        branch.style.flex = this._branchFlex(child, dir);
      }
      const childDom = this._reconcileNode(child, branch.firstElementChild);
      if (childDom && (branch.firstElementChild !== childDom || branch.childElementCount !== 1)) {
        for (const extra of [...branch.children]) {
          if (extra !== childDom) extra.remove();
        }
        if (childDom.parentElement !== branch) branch.append(childDom);
      }
      branches.push(branch);
    }

    const wantDividerClass = dir === 'col' ? 'is-h' : 'is-v';
    const usedDividers = new Set();
    const desiredChildren = [];
    for (let i = 0; i < branches.length; i++) {
      desiredChildren.push(branches[i]);
      if (i < branches.length - 1) {
        const adjacent = reuseSplit ? branches[i].nextElementSibling : null;
        let divider = (adjacent
          && !usedDividers.has(adjacent)
          && adjacent.classList?.contains('seam-divider')
          && adjacent.classList.contains(wantDividerClass))
          ? adjacent
          : null;
        if (divider) {
          usedDividers.add(divider);
          this._updateDividerMeta(divider, activeChildren[i], activeChildren[i + 1]);
        } else {
          divider = this._createDivider(dir, activeChildren[i], activeChildren[i + 1]);
        }
        desiredChildren.push(divider);
      }
    }

    const desiredSet = new Set(desiredChildren);
    for (const existing of [...split.children]) {
      if (!desiredSet.has(existing)) existing.remove();
    }
    let cursor = split.firstElementChild;
    for (const want of desiredChildren) {
      if (cursor === want) {
        cursor = cursor.nextElementSibling;
      } else {
        split.insertBefore(want, cursor);
      }
    }
    return split;
  }

  _renderTree() {
    const doc = this.global.document;
    const host = this.treeHost;
    const nextKey = this._layoutTopologyKey();
    if (nextKey && nextKey === this._treeTopologyKey && host.childElementCount > 0) {
      if (this.zoomed || this._isMobileSinglePane() || !this.layoutTree || this._syncTreeInPlace(this.layoutTree, host.firstElementChild)) {
        this._syncJunctions();
        return;
      }
    }
    this._resetResizeGuard();

    const hadFocus = Boolean(doc.activeElement && host.contains(doc.activeElement));

    if ((this.zoomed || this._isMobileSinglePane()) && this.activePaneId && this.panes.has(this.activePaneId)) {
      const entry = this.panes.get(this.activePaneId);
      const existingWrap = host.firstElementChild;
      if (!(existingWrap?.classList?.contains('seam-split') && existingWrap.firstElementChild === entry.el && existingWrap.childElementCount === 1 && host.childElementCount === 1)) {
        const wrap = doc.createElement('div');
        wrap.className = 'seam-split is-row';
        wrap.append(entry.el);
        host.replaceChildren(wrap);
      }
      this._ensurePaneRenderer(entry, entry.meta);
      this._treeTopologyKey = nextKey;
      if (hadFocus && !entry.isRich && doc.activeElement !== entry.term?.textarea) entry.term?.focus();
      return;
    }

    const rootNode = this.layoutTree
      ? this._reconcileNode(this.layoutTree, host.firstElementChild)
      : (this.panes.values().next().value?.el || null);
    if (!rootNode) {
      if (host.childElementCount > 0) host.replaceChildren();
    } else if (host.firstElementChild !== rootNode || host.childElementCount !== 1) {
      for (const extra of [...host.children]) {
        if (extra !== rootNode) extra.remove();
      }
      if (rootNode.parentElement !== host) host.append(rootNode);
    }
    for (const entry of this.panes.values()) {
      if (entry.body.isConnected && !entry.opened && !entry.isRich) {
        this._ensurePaneRenderer(entry, entry.meta);
      }
    }
    this._treeTopologyKey = nextKey;
    this._syncJunctions();
    if (hadFocus && this.activePaneId) {
      const activeEntry = this.panes.get(this.activePaneId);
      if (activeEntry && !activeEntry.isRich && doc.activeElement !== activeEntry.term?.textarea) activeEntry.term?.focus();
    }
  }

  _buildAxisDragState(seg, cell) {
    const dir = seg.dir;
    const { leftNode: curLeft, rightNode: curRight } = seg.divider._seamNodes || { leftNode: seg.leftNode, rightNode: seg.rightNode };
    const leftPaneId = firstLeafPaneId(curLeft, 'end');
    if (!leftPaneId) return null;
    const leftMetrics = measureLayoutMetrics(curLeft, this.panes, cell);
    const rightMetrics = measureLayoutMetrics(curRight, this.panes, cell);
    const startLeftUnits = dir === 'row' ? leftMetrics.contentCols : leftMetrics.contentRows;
    const startRightUnits = dir === 'row' ? rightMetrics.contentCols : rightMetrics.contentRows;
    const leftChromePx = dir === 'row' ? leftMetrics.chromeW : leftMetrics.chromeH;
    const rightChromePx = dir === 'row' ? rightMetrics.chromeW : rightMetrics.chromeH;
    const leafMeta = this.panes.get(leftPaneId)?.meta;
    const leafRawUnits = dir === 'row' ? leafMeta?.width : leafMeta?.height;
    const leafStartUnits = Number.isInteger(leafRawUnits) && leafRawUnits >= 2 ? leafRawUnits : startLeftUnits;
    const rightBranch = seg.rightBranch || (seg.divider.nextElementSibling?.classList?.contains('seam-branch') ? seg.divider.nextElementSibling : null);
    const minDelta = Math.max(2 - startLeftUnits, 2 - leafStartUnits);
    const maxDelta = Math.max(minDelta, startRightUnits - 2);
    return {
      dir,
      leftPaneId,
      leftBranch: seg.leftBranch,
      rightBranch,
      startLeftUnits,
      startRightUnits,
      leftChromePx,
      rightChromePx,
      leafStartUnits,
      minDelta,
      maxDelta,
    };
  }

  _previewAxisDelta(state, clampedDelta) {
    state.leftBranch.style.flex = (state.startLeftUnits + clampedDelta) + ' 1 ' + state.leftChromePx + 'px';
    if (state.rightBranch) {
      state.rightBranch.style.flex = (state.startRightUnits - clampedDelta) + ' 1 ' + state.rightChromePx + 'px';
    }
    return state.leafStartUnits + clampedDelta;
  }

  _startAxisDrag(event, targetEl, { cursorClass, activeDividers = [], onMove, onFinish }) {
    this._activeDragCleanup?.(false);
    let ended = false;
    if (typeof event.pointerId === 'number') {
      try { targetEl.setPointerCapture?.(event.pointerId); } catch { /* noop */ }
    }
    this._draggingDivider = true;
    targetEl.classList.add('is-dragging');
    for (const div of activeDividers) div.classList.add('is-dragging');
    this.stage.classList.add('is-dragging-divider', cursorClass);

    const handleMove = (moveEvent) => {
      if (!ended) onMove(moveEvent);
    };

    const finish = (commit, upEvent = null) => {
      if (ended) return;
      ended = true;
      if (this._activeDragCleanup === finish) this._activeDragCleanup = null;
      this.global.removeEventListener('pointermove', handleMove);
      this.global.removeEventListener('pointerup', onUp);
      this.global.removeEventListener('pointercancel', onCancel);
      this.global.removeEventListener('blur', onCancel);
      targetEl.removeEventListener('lostpointercapture', onCancel);
      if (typeof event.pointerId === 'number') {
        try {
          if (targetEl.hasPointerCapture?.(event.pointerId)) targetEl.releasePointerCapture?.(event.pointerId);
        } catch { /* noop */ }
      }
      this._draggingDivider = false;
      targetEl.classList.remove('is-dragging');
      for (const div of activeDividers) div.classList.remove('is-dragging', 'is-junction-hover');
      this.stage.classList.remove('is-dragging-divider', cursorClass);

      const didCommit = onFinish(commit, upEvent);
      if (!didCommit && this.layoutTree && this.treeHost.firstElementChild) {
        this._syncTreeInPlace(this.layoutTree, this.treeHost.firstElementChild);
        this._syncJunctions();
      }
    };

    const onUp = (upEvent) => finish(true, upEvent);
    const onCancel = () => finish(false, null);
    this._activeDragCleanup = finish;
    this.global.addEventListener('pointermove', handleMove);
    this.global.addEventListener('pointerup', onUp);
    this.global.addEventListener('pointercancel', onCancel);
    this.global.addEventListener('blur', onCancel);
    targetEl.addEventListener('lostpointercapture', onCancel);
  }

  _bindDivider(divider, dir, leftNode = null, rightNode = null) {
    if (leftNode || rightNode) this._updateDividerMeta(divider, leftNode, rightNode);
    divider.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.onAction('equalize', { layout: dir === 'col' ? 'even-vertical' : 'even-horizontal' });
    });
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const leftBranch = divider.previousElementSibling?.classList?.contains('seam-branch') ? divider.previousElementSibling : null;
      if (!leftBranch) return;
      const cell = this._cellMetrics();
      const nodes = divider._seamNodes || { leftNode, rightNode };
      const state = this._buildAxisDragState({ dir, divider, leftBranch, leftNode: nodes.leftNode, rightNode: nodes.rightNode }, cell);
      if (!state) return;
      event.preventDefault();

      const startPos = dir === 'row' ? event.clientX : event.clientY;
      const stepPx = Math.max(4, dir === 'row' ? cell.width : cell.height);
      let pendingTargetUnits = state.leafStartUnits;

      const clampDelta = (clientPos) => {
        const raw = Number.isFinite(clientPos) ? Math.round((clientPos - startPos) / stepPx) : 0;
        return Math.max(state.minDelta, Math.min(state.maxDelta, raw));
      };

      this._startAxisDrag(event, divider, {
        cursorClass: dir === 'col' ? 'is-dragging-h' : 'is-dragging-v',
        onMove: (moveEvent) => {
          const clamped = clampDelta(dir === 'row' ? moveEvent.clientX : moveEvent.clientY);
          pendingTargetUnits = this._previewAxisDelta(state, clamped);
        },
        onFinish: (commit, upEvent) => {
          if (!commit) return false;
          const clientPos = upEvent ? (dir === 'row' ? upEvent.clientX : upEvent.clientY) : NaN;
          const targetUnits = Number.isFinite(clientPos) ? (state.leafStartUnits + clampDelta(clientPos)) : pendingTargetUnits;
          if (targetUnits === state.leafStartUnits) return false;
          this._send({
            type: 'resize-pane-size',
            paneId: state.leftPaneId,
            ...(dir === 'row' ? { cols: targetUnits } : { rows: targetUnits }),
          });
          return true;
        },
      });
    });
  }

  _syncJunctions() {
    if (this._draggingDivider) return;
    for (const old of this.treeHost.querySelectorAll('.seam-junction')) old.remove();
    if (this.zoomed || !this.layoutTree || !this.treeHost.firstElementChild) return;
    const segments = collectDividerSegments(this.layoutTree, this.treeHost.firstElementChild, this.panes);
    const junctions = findLayoutJunctions(segments);
    const doc = this.global.document;
    for (const junction of junctions) {
      const handle = doc.createElement('div');
      handle.className = 'seam-junction is-anchor-' + junction.anchor.side;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', '同时调整交界处分窗大小');
      handle.dataset.contextZone = 'divider';
      handle.dataset.junctionKind = junction.vSegments.length + junction.hSegments.length >= 3 ? 'cross' : 't';
      handle.dataset.junctionX = String(junction.x);
      handle.dataset.junctionY = String(junction.y);
      junction.anchor.divider.append(handle);
      this._bindJunction(handle, junction);
    }
  }

  _bindJunction(handle, junction) {
    const allDividers = [...new Set([...junction.vSegments.map((s) => s.divider), ...junction.hSegments.map((s) => s.divider)])];
    const setHover = (hovered) => {
      for (const div of allDividers) div.classList.toggle('is-junction-hover', hovered);
    };
    handle.addEventListener('pointerenter', () => setHover(true));
    handle.addEventListener('pointerleave', () => { if (!handle.classList.contains('is-dragging')) setHover(false); });
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAction('equalize', { layout: 'tiled' });
    });
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const cell = this._cellMetrics();
      const vStates = junction.vSegments.map((seg) => this._buildAxisDragState(seg, cell)).filter(Boolean);
      const hStates = junction.hSegments.map((seg) => this._buildAxisDragState(seg, cell)).filter(Boolean);
      if (!vStates.length || !hStates.length) return;

      const boundAxis = (states) => {
        const min = Math.max(...states.map((s) => s.minDelta));
        const max = Math.min(...states.map((s) => s.maxDelta));
        return min <= max ? [min, max] : [0, 0];
      };
      const [minDeltaX, maxDeltaX] = boundAxis(vStates);
      const [minDeltaY, maxDeltaY] = boundAxis(hStates);
      const startX = event.clientX;
      const startY = event.clientY;
      const stepX = Math.max(4, cell.width);
      const stepY = Math.max(4, cell.height);
      let pendingDX = 0;
      let pendingDY = 0;

      const clampX = (clientX) => Math.max(minDeltaX, Math.min(maxDeltaX, Number.isFinite(clientX) ? Math.round((clientX - startX) / stepX) : 0));
      const clampY = (clientY) => Math.max(minDeltaY, Math.min(maxDeltaY, Number.isFinite(clientY) ? Math.round((clientY - startY) / stepY) : 0));

      this._startAxisDrag(event, handle, {
        cursorClass: 'is-dragging-xy',
        activeDividers: allDividers,
        onMove: (moveEvent) => {
          pendingDX = clampX(moveEvent.clientX);
          pendingDY = clampY(moveEvent.clientY);
          for (const st of vStates) this._previewAxisDelta(st, pendingDX);
          for (const st of hStates) this._previewAxisDelta(st, pendingDY);
        },
        onFinish: (commit, upEvent) => {
          if (!commit) return false;
          const dx = upEvent && Number.isFinite(upEvent.clientX) ? clampX(upEvent.clientX) : pendingDX;
          const dy = upEvent && Number.isFinite(upEvent.clientY) ? clampY(upEvent.clientY) : pendingDY;
          const byPane = new Map();
          if (dx !== 0) {
            for (const st of vStates) {
              const prev = byPane.get(st.leftPaneId) || { paneId: st.leftPaneId };
              prev.cols = st.leafStartUnits + dx;
              byPane.set(st.leftPaneId, prev);
            }
          }
          if (dy !== 0) {
            for (const st of hStates) {
              const prev = byPane.get(st.leftPaneId) || { paneId: st.leftPaneId };
              prev.rows = st.leafStartUnits + dy;
              byPane.set(st.leftPaneId, prev);
            }
          }
          const resizes = [...byPane.values()];
          if (resizes.length === 1) {
            this._send({ type: 'resize-pane-size', ...resizes[0] });
            return true;
          }
          if (resizes.length > 1) {
            this._send({ type: 'resize-pane-batch', resizes });
            return true;
          }
          return false;
        },
      });
    });
  }

  _openPaneRailMenu(paneId, pos = {}) {
    const ContextMenu = this.global.ContextMenu;
    if (!ContextMenu) return false;
    const entry = this.panes.get(paneId);
    ContextMenu.open({
      ...(Number.isFinite(pos.x) ? { x: pos.x } : {}),
      ...(Number.isFinite(pos.y) ? { y: pos.y } : {}),
      ...(pos.anchor ? { anchor: pos.anchor } : {}),
      label: '窗格操作',
      items: [
        { id: 'split-h', label: '左右分窗', action: () => this.onAction('split', { paneId, direction: 'horizontal' }) },
        { id: 'split-v', label: '上下分窗', action: () => this.onAction('split', { paneId, direction: 'vertical' }) },
        { id: 'split-rich-browser', label: '拆分富窗格: 网页', action: () => this.onAction('split-rich', { paneId, direction: 'horizontal', kind: 'browser' }) },
        { id: 'split-rich-doc', label: '拆分富窗格: 文档', action: () => this.onAction('split-rich', { paneId, direction: 'horizontal', kind: 'doc' }) },
        {
          id: 'open-git-preview',
          label: '打开 Git 预览',
          children: [
            { id: 'git-preview-sidebar', label: '侧边栏', action: () => this.onAction('open-git-preview', { paneId, mode: 'sidebar' }) },
            { id: 'git-preview-replace', label: '覆盖当前窗格', action: () => this.onAction('open-git-preview', { paneId, mode: 'replace' }) },
            { id: 'git-preview-down', label: '向下分窗展示', action: () => this.onAction('open-git-preview', { paneId, mode: 'split-down' }) },
            { id: 'git-preview-right', label: '向右分窗展示', action: () => this.onAction('open-git-preview', { paneId, mode: 'split-right' }) },
          ],
        },
        ...(entry?.isRich ? [{ id: 'to-terminal', label: '切换回终端', action: () => this.onAction('set-pane-kind', { paneId, kind: 'terminal' }) }] : []),
        { id: 'zoom', label: this.zoomed && this.activePaneId === paneId ? '还原窗格' : '最大化窗格', action: () => this.zoomPane(paneId) },
        { id: 'rename', label: '重命名窗格', action: () => this.startRenamePane(paneId) },
        { id: 'break', label: '拆分为独立窗口', disabled: this.panes.size <= 1, action: () => this.onAction('break-pane', { paneId }) },
        ...(!entry?.isRich ? [{ id: 'history', label: '更多历史', action: () => this.onAction('history', { paneId }) }, { id: 'clear', label: '清屏', action: () => this.onAction('clear-pane', { paneId }) }] : []),
        { separator: true },
        { id: 'respawn', label: '重置窗格', danger: true, action: () => this.onAction('respawn-pane', { paneId }) },
        { id: 'close', label: '关闭窗格', danger: true, action: () => (this.panes.size <= 1 ? this.onAction('close-window', { paneId }) : this.onAction('close-pane', { paneId })) },
      ],
      onClose: () => entry?.term?.focus(),
    });
    return true;
  }

  _bindStageMenus() {
    const doc = this.global.document;
    const gitPreviewItem = (paneId) => ({
      id: 'open-git-preview',
      label: '打开 Git 预览',
      children: [
        { id: 'git-preview-sidebar', label: '侧边栏', action: () => this.onAction('open-git-preview', { paneId, mode: 'sidebar' }) },
        { id: 'git-preview-replace', label: '覆盖当前窗格', action: () => this.onAction('open-git-preview', { paneId, mode: 'replace' }) },
        { id: 'git-preview-down', label: '向下分窗展示', action: () => this.onAction('open-git-preview', { paneId, mode: 'split-down' }) },
        { id: 'git-preview-right', label: '向右分窗展示', action: () => this.onAction('open-git-preview', { paneId, mode: 'split-right' }) },
      ],
    });
    const openMenuForTarget = (targetEl, clientX, clientY) => {
      const ContextMenu = this.global.ContextMenu;
      if (!ContextMenu) return false;
      const rail = targetEl.closest?.('[data-context-zone="pane-rail"]');
      if (rail) {
        return this._openPaneRailMenu(rail.dataset.paneId, { x: clientX, y: clientY });
      }

      const divider = targetEl.closest?.('[data-context-zone="divider"]');
      if (divider) {
        ContextMenu.open({
          x: clientX,
          y: clientY,
          label: '分窗布局',
          items: [
            { id: 'even-horizontal', label: '左右均分布局', action: () => this.onAction('equalize', { layout: 'even-horizontal' }) },
            { id: 'even-vertical', label: '上下均分布局', action: () => this.onAction('equalize', { layout: 'even-vertical' }) },
            { id: 'tiled', label: '平铺布局 (tiled)', action: () => this.onAction('equalize', { layout: 'tiled' }) },
          ],
        });
        return true;
      }

      const body = targetEl.closest?.('[data-context-zone="pane-body"]');
      if (body) {
        const paneId = body.dataset.paneId;
        const entry = this.panes.get(paneId);
        if (entry?.isRich) return false;
        const sel = entry?.term?.getSelection?.() || '';
        const cwd = entry?.meta?.cwd || '';
        ContextMenu.open({
          x: clientX,
          y: clientY,
          label: '终端操作',
          items: [
            { id: 'copy', label: '复制选中', disabled: !sel, action: () => { if (sel) this.copy(sel); } },
            { id: 'paste', label: '粘贴', action: async () => {
              const text = await this.global.navigator.clipboard?.readText?.();
              if (text) this.paste(text, paneId);
            } },
            { id: 'clear', label: '清屏', action: () => this.onAction('clear-pane', { paneId }) },
            { separator: true },
            { id: 'split-h', label: '左右分窗', action: () => this.onAction('split', { paneId, direction: 'horizontal' }) },
            { id: 'split-v', label: '上下分窗', action: () => this.onAction('split', { paneId, direction: 'vertical' }) },
            gitPreviewItem(paneId),
            { id: 'history', label: '更多历史', action: () => this.onAction('history', { paneId }) },
            ...(cwd ? [{ id: 'copy-cwd', label: '复制工作目录', action: () => this.copy(cwd) }] : []),
            { separator: true },
            { id: 'respawn', label: '重置窗格', danger: true, action: () => this.onAction('respawn-pane', { paneId }) },
          ],
          onClose: () => entry?.term?.focus(),
        });
        return true;
      }
      return false;
    };

    this._listen(this.stage, 'contextmenu', (event) => {
      // Zone 2: Shift+Right-Click passes straight through to tmux / TUI mouse apps.
      if (event.shiftKey && event.target.closest?.('[data-context-zone="pane-body"]')) return;
      if (openMenuForTarget(event.target, event.clientX, event.clientY)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    if (this.global.ContextMenu?.installLongPress) {
      this.cleanups.push(this.global.ContextMenu.installLongPress(
        this.stage,
        '[data-context-zone="pane-rail"], [data-context-zone="divider"]',
        (el, coords) => openMenuForTarget(el, coords.clientX, coords.clientY),
      ));
    }

    // Ensure pressing Escape inside rename input stays localized cleanly.
    this._listen(doc, 'notifications-changed', () => this.syncAttention());
    this._listen(this.global, 'agent-status-changed', () => this._syncAgentVisuals());
  }

  startRenamePane(paneId) {
    const entry = this.panes.get(paneId);
    if (!entry || entry.rail.querySelector('.pane-rename-input')) return;
    const doc = this.global.document;
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'pane-rename-input';
    input.value = entry.meta.label || entry.titleEl.textContent || '';
    input.maxLength = 80;
    entry.titleEl.hidden = true;
    entry.titleEl.after(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      input.remove();
      entry.titleEl.hidden = false;
      const label = input.value.trim();
      if (commit && label && label !== entry.meta.label) {
        entry.meta.label = label;
        this._updatePaneMeta(entry, entry.meta);
        this.onAction('rename-pane', { paneId, label });
      }
      entry.term?.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  syncAttention() {
    const items = this.global.NotificationPanel?.needsYou?.() || [];
    const byPane = new Map();
    for (const item of items) {
      if (item.paneId) byPane.set(item.paneId, item);
    }
    for (const entry of this.panes.values()) {
      const notice = byPane.get(entry.paneId);
      if (!notice) {
        entry.statusBadge.hidden = true;
        entry.el.classList.remove('is-needs-you');
        continue;
      }
      entry.statusBadge.hidden = false;
      entry.el.classList.add('is-needs-you');
      entry.statusBadge.className = 'pane-status ' + (notice.state === 'failed' ? 'is-failed' : 'is-waiting');
      entry.statusBadge.textContent = notice.state === 'failed' ? '◆ 异常停止' : '◆ 等待确认';
    }
    this._renderMobilePaneBar();
  }

  _publishContext() {
    const active = this.activePaneId && this.panes.get(this.activePaneId);
    const pane = validateTarget({
      serverId: this.target.serverId,
      instanceId: this.target.instanceId,
      sessionId: this.target.sessionId,
      windowId: this.target.windowId,
      paneId: active?.paneId || this.activePaneId,
    });
    if (!pane) return;
    const next = Object.freeze({
      ...pane,
      clientId: this.target.clientId,
      cwd: active?.meta?.cwd || '',
      command: active?.meta?.command || '',
      title: active?.meta?.title || '',
    });
    if (!this.context || ['paneId', 'windowId', 'sessionId', 'cwd', 'command'].some((k) => this.context[k] !== next[k])) {
      this.context = next;
      this.onContext(next);
    }
  }

  requestContext() {
    if (this.status !== 'live' || !this.hydrated || !this.context) {
      return Promise.reject(new Error('工作台尚未确认当前窗格'));
    }
    return Promise.resolve(this.context);
  }

  _send(message) {
    if (!this.disposed && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  _beginInputBatch(entry) {
    if (!entry) return;
    entry.inputBatchActive = true;
    entry.inputBatchBuf = '';
  }

  _flushInputBatch(entry) {
    if (!entry) return;
    entry.inputBatchActive = false;
    const data = entry.inputBatchBuf;
    entry.inputBatchBuf = '';
    if (data && !this.disposed && this.status === 'live' && this._isPaneInputAllowed(entry.paneId) && entry.hydrated && !entry.restoring) {
      this.inputVersion++;
      this._sendInput(entry.paneId, data, false);
    }
  }

  _clearHoverTimer(entry) {
    if (!entry) return;
    if (entry.hoverTimer != null) {
      this.global.clearTimeout(entry.hoverTimer);
      entry.hoverTimer = null;
    }
    entry.pendingHoverSeq = null;
  }

  _sendInputImmediate(paneId, data, binary = false) {
    if (this.disposed || typeof data !== 'string' || !paneId) return false;
    if (!binary) {
      for (let start = 0; start < data.length; start += INPUT_CHUNK_BYTES) {
        if (!this._send({ type: 'input', paneId, data: data.slice(start, start + INPUT_CHUNK_BYTES) })) return false;
      }
      return true;
    }
    const bytes = Uint8Array.from(data, (ch) => ch.charCodeAt(0));
    for (let start = 0; start < bytes.length; start += INPUT_CHUNK_BYTES) {
      let raw = '';
      for (const byte of bytes.subarray(start, start + INPUT_CHUNK_BYTES)) raw += String.fromCharCode(byte);
      if (!this._send({ type: 'input', paneId, encoding: 'base64', data: this.global.btoa(raw) })) return false;
    }
    return true;
  }

  _sendInput(paneId, data, binary = false) {
    if (this.disposed || typeof data !== 'string' || !paneId) return false;
    if (binary) return this._sendInputImmediate(paneId, data, true);
    const entry = this.panes.get(paneId);
    if (entry?.inputBatchActive) {
      entry.inputBatchBuf += data;
      return true;
    }
    if (entry && entry.pointerType === 'mousemove' && SGR_HOVER_MOVE_RE.test(data)) {
      entry.pendingHoverSeq = data;
      if (entry.hoverTimer == null) {
        entry.hoverTimer = this.global.setTimeout(() => {
          entry.hoverTimer = null;
          const pending = entry.pendingHoverSeq;
          entry.pendingHoverSeq = null;
          if (pending && !this.disposed && this.status === 'live' && this._isPaneInputAllowed(paneId) && entry.hydrated && !entry.restoring) {
            this._sendInputImmediate(paneId, pending, false);
          }
        }, 16);
      }
      return true;
    }
    if (entry) this._clearHoverTimer(entry);
    return this._sendInputImmediate(paneId, data, false);
  }

  setStickyModifier(name, armed) {
    if (this.disposed || name !== 'ctrl') return false;
    const next = Boolean(armed);
    if (this.stickyCtrl === next) return next;
    this.stickyCtrl = next;
    this.onStickyModifierChange({ ctrl: next });
    return next;
  }

  send(data, trackIntent = true, paneId = this.activePaneId) {
    const entry = paneId && this.panes.get(paneId);
    if (this.status !== 'live' || !this._isPaneInputAllowed(paneId) || !entry?.term || !entry?.hydrated || entry.restoring || typeof data !== 'string') return false;
    if (this.stickyCtrl && data.length === 1) {
      const code = data.charCodeAt(0);
      if ((code >= 64 && code <= 95) || (code >= 97 && code <= 122)) {
        data = String.fromCharCode(code & 0x1f);
        this.setStickyModifier('ctrl', false);
      }
    }
    if (trackIntent) this.inputVersion++;
    return this._sendInput(paneId, data, false);
  }

  paste(text, paneId = this.activePaneId) {
    const entry = paneId && this.panes.get(paneId);
    if (this.status !== 'live' || !this._isPaneInputAllowed(paneId) || !entry?.term || !entry?.hydrated || entry.restoring) return false;
    if (entry.term.paste) entry.term.paste(text);
    else this.send(text, true, paneId);
    return true;
  }

  selectPane(paneId) {
    if (this.disposed || !this.panes.has(paneId)) return false;
    const prev = this.activePaneId;
    this.activePaneId = paneId;
    if (this._isMobile()) this._localActivePaneId = paneId;
    this._syncActivePaneState();
    if (this._isMobileSinglePane()) {
      this._renderTree();
      this._resetResizeGuard();
      this.fit();
    } else if (this._isMobile()) {
      this._syncMobileViewportTransform(this.panes.get(paneId));
    }
    this._renderMobilePaneBar();
    this._syncInputGates();
    this._publishContext();
    if (!this._isMobile()) this.panes.get(paneId)?.term?.focus();
    if (prev !== paneId) {
      if (this.status === 'live') {
        this._pendingSelectPane = null;
        this._send({ type: 'select-pane', paneId });
      } else {
        this._pendingSelectPane = paneId;
      }
    }
    this._reportPaneFocus();
    return true;
  }

  zoomPane(paneId = this.activePaneId, zoomed) {
    if (!paneId || !this.panes.has(paneId)) return false;
    return this._send({ type: 'zoom-pane', paneId, ...(typeof zoomed === 'boolean' ? { zoomed } : {}) });
  }

  takeover(options = null) {
    this._leasePending = true;
    this._renderLeaseBar();
    this._renderPaneTakeovers();
    const payload = { type: 'takeover' };
    if (options && typeof options === 'object') {
      if (options.paneId) payload.paneId = options.paneId;
      if (options.claimSize === true) payload.claimSize = true;
    }
    const sent = this._send(payload);
    if (!sent) {
      this._leasePending = false;
      this._renderLeaseBar();
      this._renderPaneTakeovers();
    }
    return sent;
  }

  releaseTakeover() {
    return this._send({ type: 'release-takeover' });
  }

  getPaneMeta(paneId) {
    return this.panes.get(paneId)?.meta || null;
  }

  getPaneRailSlots() {
    if (this.disposed) return { serverId: this.target.serverId, windowId: this.target.windowId, panes: [] };
    const panes = [];
    for (const entry of this.panes.values()) {
      if (entry.isRich || !entry.gitSlot) continue;
      panes.push({
        paneId: entry.paneId,
        cwd: entry.meta?.cwd || '',
        slotEl: entry.gitSlot,
        railEl: entry.rail,
        paneEl: entry.el,
      });
    }
    return { serverId: this.target.serverId, windowId: this.target.windowId, panes };
  }

  _emitPanesChanged() {
    if (typeof this.global?.dispatchEvent !== 'function' || typeof this.global?.CustomEvent !== 'function') return;
    this.global.dispatchEvent(new this.global.CustomEvent('workbench-panes-changed', {
      detail: { serverId: this.target.serverId, windowId: this.target.windowId, disposed: this.disposed },
    }));
  }

  requestResync(paneId = null, forceSnapshot = false) {
    return this._send({
      type: 'resync',
      ...(paneId ? { paneId } : {}),
      ...(forceSnapshot ? { forceSnapshot: true } : {}),
    });
  }

  _cancelResizeTimer() {
    if (this.resizeTimer != null) {
      this.global.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  _resetResizeGuard() {
    this.lastRequestedSize = null;
    this._resizeHistory?.clear();
    this._resizeHistoryEnv = null;
  }

  _viewportEnvelopeKey(cell = this._cellMetrics()) {
    const mode = this._isMobileSinglePane()
      ? ('m:' + this.activePaneId)
      : (this._isMobile() ? 'ms' : 'd');
    return [
      this.treeHost.clientWidth,
      this.treeHost.clientHeight,
      Math.round(cell.width * 10),
      Math.round(cell.height * 10),
      this.fontSize,
      this.zoomed ? 1 : 0,
      mode,
    ].join('|');
  }

  _fitEnvelopeKey(cell = this._cellMetrics()) {
    return this._viewportEnvelopeKey(cell) + '|' + (this._layoutTopologyKey() || '');
  }

  _hasMeasuredCellMetrics() {
    let hasTerminal = false;
    for (const entry of this.panes.values()) {
      if (!entry?.term || entry.isRich) continue;
      hasTerminal = true;
      const dims = entry.term?._core?._renderService?.dimensions?.css?.cell;
      if (dims?.width > 2 && dims?.height > 4) return true;
      if (entry.body?.isConnected) {
        const screen = entry.body.querySelector?.('.xterm-screen');
        const rect = screen?.getBoundingClientRect?.();
        if (rect?.width > 0 && rect?.height > 0 && entry.term.cols > 0 && entry.term.rows > 0) {
          return true;
        }
      }
    }
    return !hasTerminal;
  }

  _cellMetrics() {
    const active = this.activePaneId && this.panes.get(this.activePaneId);
    const ordered = active ? [active, ...this.panes.values()] : [...this.panes.values()];
    for (const entry of ordered) {
      if (!entry?.term) continue;
      const dims = entry.term?._core?._renderService?.dimensions?.css?.cell;
      if (dims?.width > 2 && dims?.height > 4) return { width: dims.width, height: dims.height };
      if (entry.body?.isConnected) {
        const screen = entry.body.querySelector?.('.xterm-screen');
        const rect = screen?.getBoundingClientRect?.();
        if (rect?.width > 0 && rect?.height > 0 && entry.term.cols > 0 && entry.term.rows > 0) {
          return { width: rect.width / entry.term.cols, height: rect.height / entry.term.rows };
        }
      }
    }
    return { width: 8.4, height: Math.max(14, Math.round(this.fontSize * 1.35)) };
  }

  _measureWindowGrid() {
    const w = this.treeHost.clientWidth;
    const h = this.treeHost.clientHeight;
    if (!w || !h) return { cols: 0, rows: 0 };
    const cell = this._cellMetrics();
    const railPx = this._isMobile() ? MOBILE_PANE_RAIL_PX : PANE_RAIL_PX;
    if (this._isMobileSinglePane()) {
      const activeEntry = (this.activePaneId && this.panes.get(this.activePaneId)) || this.panes.values().next().value;
      const isRich = Boolean(activeEntry?.isRich);
      const chromeW = isRich ? 0 : PANE_PAD_X;
      const chromeH = railPx + (isRich ? 0 : PANE_PAD_Y);
      const usableW = Math.max(cell.width * 2, w - chromeW);
      const usableH = Math.max(cell.height * 2, h - chromeH);
      const targetCols = Math.max(2, Math.floor(usableW / cell.width));
      const targetRows = Math.max(2, Math.floor(usableH / cell.height));
      const paneW = activeEntry?.meta?.width;
      const paneH = activeEntry?.meta?.height;
      const envKey = this._fitEnvelopeKey(cell);
      const alreadyAttempted = this._resizeHistoryEnv === envKey && this._resizeHistory.size > 0;
      const solveAxis = (axis, target, winSize, paneSize, maxDim) => {
        if (Number.isInteger(paneSize) && Number.isInteger(winSize)) {
          if (paneSize === target) return winSize;
          if (alreadyAttempted && paneSize >= target - 1 && paneSize <= target) return winSize;
        }
        const info = this.layoutTree ? measureActivePaneAxis(this.layoutTree, activeEntry?.paneId, this.panes, axis) : null;
        if (info?.found && info.paneContent > 0 && info.totalContent > 0) {
          const share = Math.max(0.25, Math.min(1, info.paneContent / info.totalContent));
          return Math.max(2, Math.min(maxDim, Math.round(target / share) + info.fixed));
        }
        const ratio = (Number.isInteger(paneSize) && Number.isInteger(winSize) && winSize > 0)
          ? Math.max(0.25, Math.min(1, paneSize / winSize))
          : 1;
        return Math.max(2, Math.min(maxDim, Math.round(target / ratio)));
      };
      return {
        cols: solveAxis('row', targetCols, this.windowCols, paneW, 240),
        rows: solveAxis('col', targetRows, this.windowRows, paneH, 160),
      };
    }
    let netWidthPx;
    let netHeightPx;
    if (this.zoomed) {
      const activeEntry = (this.activePaneId && this.panes.get(this.activePaneId)) || this.panes.values().next().value;
      const isRich = Boolean(activeEntry?.isRich);
      const chromeW = isRich ? 0 : PANE_PAD_X;
      const chromeH = railPx + (isRich ? 0 : PANE_PAD_Y);
      const paneH = activeEntry?.meta?.height;
      const borderRows = (Number.isInteger(paneH) && Number.isInteger(this.windowRows) && this.windowRows > paneH)
        ? Math.min(2, this.windowRows - paneH) : 0;
      netWidthPx = chromeW;
      netHeightPx = chromeH - borderRows * cell.height;
    } else {
      ({ netWidthPx, netHeightPx } = measureLayoutMetrics(this.layoutTree, this.panes, cell, railPx));
    }
    const usableW = Math.max(cell.width * 2, w - netWidthPx);
    const usableH = Math.max(cell.height * 2, h - netHeightPx);
    return {
      cols: Math.max(2, Math.floor(usableW / cell.width)),
      rows: Math.max(2, Math.floor(usableH / cell.height)),
    };
  }

  _syncMobileViewportTransform(entry) {
    const el = entry?.term?.element;
    if (!el) return;
    if (!this._isMobile() || entry.isRich || !entry.body?.clientWidth) {
      entry.fitScale = 1;
      entry.userScale = 1;
      entry.panX = 0;
      entry.panY = 0;
      el.style.transform = '';
      el.style.transformOrigin = '';
      return;
    }
    const availW = Math.max(1, entry.body.clientWidth - PANE_PAD_X);
    const availH = Math.max(1, (entry.body.clientHeight || 200) - PANE_PAD_Y);
    const cell = this._cellMetrics();
    const contentW = Math.max(1, (entry.term.cols || 80) * cell.width);
    const contentH = Math.max(1, (entry.term.rows || 24) * cell.height);
    entry.fitScale = contentW > availW + 1 ? Math.max(0.45, Math.min(1, availW / contentW)) : 1;
    const userScale = Math.max(1, Math.min(3, entry.userScale || 1));
    entry.userScale = userScale;
    const totalScale = entry.fitScale * userScale;
    if (Math.abs(totalScale - 1) < 0.005 && !entry.panX && !entry.panY) {
      el.style.transform = '';
      el.style.transformOrigin = '';
      return;
    }
    const minPanX = Math.min(0, availW - contentW * totalScale);
    const minPanY = Math.min(0, availH - contentH * totalScale);
    entry.panX = Math.max(minPanX, Math.min(0, entry.panX || 0));
    entry.panY = Math.max(minPanY, Math.min(0, entry.panY || 0));
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate3d(${entry.panX.toFixed(1)}px, ${entry.panY.toFixed(1)}px, 0) scale(${totalScale.toFixed(4)})`;
  }

  fit() {
    if (this.disposed || this.parked || !this.visible || !this.treeHost.isConnected) {
      this._cancelResizeTimer();
      return;
    }
    if (this._isMobile()) {
      const active = (this.activePaneId && this.panes.get(this.activePaneId)) || this.panes.values().next().value;
      if (active) this._syncMobileViewportTransform(active);
    } else {
      for (const pane of this.panes.values()) this._syncMobileViewportTransform(pane);
    }
    if (this.sizeLease !== 'owner' || this._layoutSyncPending) {
      this._cancelResizeTimer();
      return;
    }
    if (!this._hasMeasuredCellMetrics()) {
      this._cancelResizeTimer();
      return;
    }
    const cell = this._cellMetrics();
    const { cols: idealCols, rows: idealRows } = this._measureWindowGrid();
    if (this.status !== 'live' || idealCols < 2 || idealRows < 2) {
      this._cancelResizeTimer();
      return;
    }
    const viewportEnv = this._viewportEnvelopeKey(cell);
    let cols = idealCols;
    let rows = idealRows;
    // Preserve an already-fitting tmux window within compressible padding on
    // initial mount/refresh and local splits unless a real viewport change occurs.
    if (!this._isMobileSinglePane() && !this.zoomed && this.layoutTree && (!this._settledViewportEnv || this._settledViewportEnv === viewportEnv)) {
      const metrics = measureLayoutMetrics(this.layoutTree, this.panes, cell, this._isMobile() ? MOBILE_PANE_RAIL_PX : PANE_RAIL_PX);
      const maxCols = Math.max(2, Math.floor(Math.max(cell.width * 2, this.treeHost.clientWidth - metrics.minNetWidthPx) / cell.width));
      const maxRows = Math.max(2, Math.floor(Math.max(cell.height * 2, this.treeHost.clientHeight - metrics.minNetHeightPx) / cell.height));
      if (Number.isInteger(this.windowCols) && this.windowCols <= maxCols && this.windowCols >= idealCols - 2) {
        cols = this.windowCols;
      }
      if (Number.isInteger(this.windowRows) && this.windowRows <= maxRows && this.windowRows >= idealRows - 2) {
        rows = this.windowRows;
      }
    }
    const key = cols + ':' + rows;
    if (cols === this.windowCols && rows === this.windowRows) {
      this._settledViewportEnv = viewportEnv;
      this._cancelResizeTimer();
      return;
    }
    if (key === this.lastRequestedSize) {
      this._cancelResizeTimer();
      return;
    }
    const envKey = this._fitEnvelopeKey(cell);
    if (envKey !== this._resizeHistoryEnv) {
      this._resizeHistoryEnv = envKey;
      this._resizeHistory.clear();
    }
    if (this._resizeHistory.has(key) || this._resizeHistory.size >= 3) {
      this._cancelResizeTimer();
      return;
    }
    this._cancelResizeTimer();
    this.resizeTimer = this.global.setTimeout(() => {
      this.resizeTimer = null;
      if (this.disposed || this.parked || !this.visible || this.status !== 'live' || this.sizeLease !== 'owner' || this._layoutSyncPending) return;
      if (this._send({ type: 'resize-window', cols, rows })) {
        this.lastRequestedSize = key;
        this._resizeHistory.add(key);
      }
    }, 80);
  }

  setParked(parked) {
    const next = Boolean(parked);
    if (this.disposed || this.parked === next) return;
    this.parked = next;
    if (next) {
      this._cancelResizeTimer();
      this._releaseWebglAddons();
      if (this.ws?.readyState === 1 && this.visible) {
        this._send({ type: 'visibility', visible: true, background: true });
      }
      return;
    }
    if (this.ws?.readyState === 1 && this.visible) {
      this._send({ type: 'visibility', visible: true, background: false });
    }
    for (const pane of this.panes.values()) {
      if (!pane.isRich && pane.term) {
        pane.term.refresh?.(0, Math.max(0, pane.term.rows - 1));
      }
    }
    this._scheduleWebglAddons();
    this.fit();
    this._emitPanesChanged();
    if (!this.ws && this.visible && this.rendererPrepared && !this.retryTimer && !['detached', 'exited', 'invalid'].includes(this.status)) {
      this._connect();
    }
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.ws?.readyState === 1) {
      this._send({ type: 'visibility', visible, ...(visible && this.parked ? { background: true } : {}) });
    }
    if (visible && !this.parked) {
      this.fit();
      if (!this.ws && this.rendererPrepared && !this.retryTimer) this._connect();
    }
  }

  focus(paneId = this.activePaneId) {
    if (this.disposed) return;
    const target = (paneId && this.panes.get(paneId)) || this.panes.values().next().value;
    if (!target?.term) return;
    if (this._isMobile()) {
      const doc = this.global.document;
      const ta = target.term.textarea;
      if (ta && doc?.activeElement === ta && !doc.documentElement?.classList?.contains('mobile-keyboard-open')) {
        ta.blur();
      }
    }
    target.term.focus();
  }

  setFontSize(size) {
    if (this.disposed) return;
    const mobile = !!this.global.MobileUI?.isMobile();
    const nextSize = Math.max(mobile ? 11 : 8, Math.min(22, Math.round(size)));
    const baseFont = this.global.Theme?.getTerminalTypography?.()?.fontSize || (mobile ? 13 : 14);
    this.fontDelta = Math.max(-8, Math.min(8, nextSize - baseFont));
    this.fontSize = nextSize;
    for (const pane of this.panes.values()) {
      if (!pane.term) continue;
      pane.term.options.fontSize = this.fontSize;
      pane.term.clearTextureAtlas?.();
    }
    this.onFontDelta(this.fontDelta);
    this.onFontSize(this.fontSize);
    this._resetResizeGuard();
    this.fit();
  }

  copy(text) {
    if (this.global._copyToClipboard) this.global._copyToClipboard(text);
    else this.global.navigator.clipboard?.writeText(text).catch(() => {});
  }

  _installCompositionGuard(entry) {
    const area = entry.term.textarea;
    if (!area) return;
    for (const [key, value] of Object.entries({ autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send' })) {
      area.setAttribute(key, value);
    }
    const onStart = () => { entry.composing = true; entry.imeSent = false; entry.imeText = ''; };
    const onEnd = (event) => {
      entry.composing = false;
      entry.imeText = event.data || '';
      entry.imeSent = false;
      entry.imeUntil = Date.now() + (/Android/i.test(this.global.navigator.userAgent) ? 300 : 150);
      this.global.clearTimeout(entry.imeTimer);
      entry.imeTimer = this.global.setTimeout(() => { if (!this.disposed) area.value = ''; }, 120);
    };
    const onKeyDown = (event) => {
      if (!(entry.composing || event.isComposing)) return;
      if (event.key === 'Enter' || event.keyCode === 13) { event.stopPropagation(); event.preventDefault(); }
      else if (event.key === 'Backspace' || event.keyCode === 8) event.stopPropagation();
    };
    area.addEventListener('compositionstart', onStart);
    area.addEventListener('compositionend', onEnd);
    area.addEventListener('keydown', onKeyDown, true);
    entry.cleanups.push(() => {
      this.global.clearTimeout(entry.imeTimer);
      area.removeEventListener('compositionstart', onStart);
      area.removeEventListener('compositionend', onEnd);
      area.removeEventListener('keydown', onKeyDown, true);
    });
  }

  _duplicateComposition(entry, data) {
    if (!(entry.imeUntil > Date.now())) return false;
    if (data === '\r') return true;
    if (entry.imeText && data === entry.imeText) {
      if (entry.imeSent) return true;
      entry.imeSent = true;
    }
    return false;
  }

  _installTouchSelection(entry) {
    const { body, term } = entry;
    let origin, lastTouch, anchor, selecting = false, scrolling = false, panning = false, pinch = null, suppressClick = false, copyButton;
    let moved = false, gestureBlocked = false, hadMultiTouch = false, suppressMouseUntil = 0;
    let accumPx = 0, velocity = 0, lastMoveTime = 0, momentumId = null, lastPoint = { x: 0, y: 0 }, lastTap = null;
    const clearHold = () => { this.global.clearTimeout(entry.holdTimer); entry.holdTimer = null; };
    const stopMomentum = () => {
      if (momentumId != null && this.global.cancelAnimationFrame) this.global.cancelAnimationFrame(momentumId);
      momentumId = null;
    };
    const expandWordAt = (line, col, cols) => {
      const isWordChar = (ch) => /[\p{L}\p{N}_./\\:~-]/u.test(ch || '');
      if (line && typeof this.global.Intl?.Segmenter === 'function' && typeof line.getCell === 'function') {
        const glyphs = [];
        for (let c = 0; c < cols;) {
          const cell = line.getCell(c);
          if (!cell?.getChars || !cell?.getWidth) break;
          const w = cell.getWidth();
          if (w <= 0) { c++; continue; }
          const ch = cell.getChars() || ' ';
          glyphs.push({ text: ch, start: c, end: c + w - 1 });
          c += w;
        }
        if (glyphs.length) {
          const map = [];
          let text = '';
          for (const g of glyphs) {
            for (let k = 0; k < g.text.length; k++) map.push(g);
            text += g.text;
          }
          const segmenter = new this.global.Intl.Segmenter(undefined, { granularity: 'grapheme' });
          const segs = Array.from(segmenter.segment(text), (s) => ({
            text: s.segment,
            start: map[s.index].start,
            end: map[s.index + s.segment.length - 1].end,
          }));
          const idx = segs.findIndex((s) => s.start <= col && col <= s.end);
          if (idx >= 0 && isWordChar(segs[idx].text)) {
            let leftIdx = idx, rightIdx = idx;
            while (leftIdx > 0 && isWordChar(segs[leftIdx - 1].text)) leftIdx--;
            while (rightIdx + 1 < segs.length && isWordChar(segs[rightIdx + 1].text)) rightIdx++;
            return { left: segs[leftIdx].start, right: segs[rightIdx].end };
          }
          if (idx >= 0) return { left: segs[idx].start, right: segs[idx].end };
        }
      }
      const word = (c) => isWordChar(line?.getCell?.(c)?.getChars());
      let left = col, right = col;
      if (word(left)) {
        while (left > 0 && word(left - 1)) left--;
        while (right < cols - 1 && word(right + 1)) right++;
      }
      return { left, right };
    };
    const scrollBottomBtn = this.global.document.createElement('button');
    scrollBottomBtn.type = 'button';
    scrollBottomBtn.className = 'wb-scroll-bottom';
    scrollBottomBtn.textContent = '↓ 底部';
    scrollBottomBtn.hidden = true;
    const syncScrollBottom = () => {
      const buf = term.buffer?.active;
      const scrolledUp = Boolean(
        this._isMobile()
        && buf
        && buf.type !== 'alternate'
        && Number(buf.baseY) > 0
        && Number(buf.viewportY) < Number(buf.baseY),
      );
      scrollBottomBtn.hidden = !scrolledUp;
    };
    scrollBottomBtn.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      stopMomentum();
      term.scrollToBottom?.();
      syncScrollBottom();
    });
    entry.el.append(scrollBottomBtn);
    const onScrollSub = term.onScroll?.(syncScrollBottom);
    const onParsedSub = term.onWriteParsed?.(syncScrollBottom);

    const position = (touch) => {
      const screen = term.element?.querySelector?.('.xterm-screen') || term.element;
      const rect = screen?.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height) return null;
      return {
        col: Math.max(0, Math.min(term.cols - 1, Math.floor((touch.clientX - rect.left) * term.cols / rect.width))),
        row: (term.buffer?.active?.viewportY || 0) + Math.max(0, Math.min(term.rows - 1, Math.floor((touch.clientY - rect.top) * term.rows / rect.height))),
      };
    };
    const applyScrollLines = (lines, clientX, clientY) => {
      if (!lines || this.disposed) return;
      const mouseMode = term.modes?.mouseTrackingMode;
      if (mouseMode && mouseMode !== 'none') {
        const pt = position({ clientX, clientY });
        const mx = Math.max(2, (pt ? pt.col : 1) + 1);
        const my = Math.max(2, (pt ? pt.row - (term.buffer?.active?.viewportY || 0) : 1) + 1);
        const btn = lines > 0 ? 65 : 64;
        const seq = '\x1b[<' + btn + ';' + mx + ';' + my + 'M';
        this._sendInput(entry.paneId, seq.repeat(Math.abs(lines)), false);
        return;
      }
      if (term.buffer?.active?.type === 'alternate') {
        const seq = lines > 0 ? '\x1b[B' : '\x1b[A';
        this._sendInput(entry.paneId, seq.repeat(Math.abs(lines)), false);
        return;
      }
      term.scrollLines?.(lines);
      syncScrollBottom();
    };
    const showCopy = () => {
      if (copyButton) return;
      copyButton = this.global.document.createElement('button');
      copyButton.type = 'button'; copyButton.className = 'wb-touch-copy'; copyButton.textContent = '复制选区';
      copyButton.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        const selection = term.getSelection?.();
        if (selection) this.copy(selection);
        term.clearSelection?.();
        copyButton?.remove(); copyButton = null;
        suppressClick = false; selecting = false;
      });
      entry.el.append(copyButton);
    };
    const onStart = (event) => {
      if (!this._isMobile() || event.target.closest?.('.wb-touch-copy, .wb-scroll-bottom, .wb-history-pill, .seam-pane-takeover')) return;
      if (event.touches.length >= 2) {
        hadMultiTouch = true;
        gestureBlocked = true;
        clearHold(); stopMomentum(); origin = null; scrolling = false; panning = false;
        if (event.touches.length === 2) {
          const [t1, t2] = event.touches;
          pinch = {
            startDist: Math.max(1, Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)),
            startScale: entry.userScale || 1,
          };
        }
        return;
      }
      if (event.touches.length !== 1) return;
      const wasMomentum = momentumId != null;
      pinch = null;
      clearHold(); stopMomentum();
      moved = false; selecting = false; scrolling = false; panning = false; accumPx = 0; velocity = 0;
      gestureBlocked = wasMomentum || hadMultiTouch;
      copyButton?.remove(); copyButton = null;
      const touch = event.touches[0];
      const now = Date.now();
      if (lastTap && now - lastTap.time < 280 && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 24) {
        lastTap = null;
        if ((entry.userScale || 1) > 1.02 || entry.panX || entry.panY) {
          gestureBlocked = true;
          entry.userScale = 1;
          entry.panX = 0;
          entry.panY = 0;
          this._syncMobileViewportTransform(entry);
        }
      } else {
        lastTap = { x: touch.clientX, y: touch.clientY, time: now };
      }
      origin = { x: touch.clientX, y: touch.clientY };
      lastTouch = { x: touch.clientX, y: touch.clientY };
      lastPoint = { x: touch.clientX, y: touch.clientY };
      lastMoveTime = now;
      anchor = position(touch);
      if (!anchor) return;
      entry.holdTimer = this.global.setTimeout(() => {
        if (this.disposed || !anchor || scrolling || panning || pinch || moved || gestureBlocked) return;
        selecting = true; suppressClick = true; gestureBlocked = true;
        this.global.navigator?.vibrate?.(20);
        const line = term.buffer.active.getLine(anchor.row);
        const { left, right } = expandWordAt(line, anchor.col, term.cols);
        anchor = { row: anchor.row, col: left };
        term.select?.(left, anchor.row, right - left + 1);
        showCopy();
      }, 450);
    };
    const onMove = (event) => {
      if (pinch && event.touches.length === 2) {
        gestureBlocked = true;
        clearHold();
        event.preventDefault();
        event.stopPropagation();
        const [t1, t2] = event.touches;
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        entry.userScale = Math.max(1, Math.min(3, pinch.startScale * (dist / pinch.startDist)));
        this._syncMobileViewportTransform(entry);
        return;
      }
      if (!origin || event.touches.length !== 1) {
        clearHold();
        if (event.touches.length > 1) {
          hadMultiTouch = true;
          gestureBlocked = true;
        }
        return;
      }
      const touch = event.touches[0];
      if (selecting) {
        event.preventDefault(); event.stopPropagation();
        const point = position(touch); if (!point) return;
        const first = anchor.row * term.cols + anchor.col;
        const last = point.row * term.cols + point.col;
        const start = Math.min(first, last);
        term.select?.(start % term.cols, Math.floor(start / term.cols), Math.abs(last - first) + 1);
        return;
      }
      const totalDx = touch.clientX - origin.x;
      const totalDy = touch.clientY - origin.y;
      if (panning) {
        event.preventDefault(); event.stopPropagation();
        entry.panX = (entry.panX || 0) + (touch.clientX - lastTouch.x);
        lastTouch = { x: touch.clientX, y: touch.clientY };
        this._syncMobileViewportTransform(entry);
        return;
      }
      if (!scrolling) {
        if (Math.hypot(totalDx, totalDy) <= 8) return;
        moved = true;
        gestureBlocked = true;
        clearHold();
        if (((entry.userScale || 1) > 1.02 || (entry.fitScale || 1) < 0.99) && Math.abs(totalDx) > Math.abs(totalDy)) {
          panning = true;
          entry.panX = (entry.panX || 0) + (touch.clientX - lastTouch.x);
          lastTouch = { x: touch.clientX, y: touch.clientY };
          event.preventDefault(); event.stopPropagation();
          this._syncMobileViewportTransform(entry);
          return;
        }
        if (Math.abs(totalDy) >= Math.abs(totalDx)) {
          scrolling = true;
        } else {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const dy = lastTouch.y - touch.clientY;
      const dt = Math.max(1, now - lastMoveTime);
      lastTouch = { x: touch.clientX, y: touch.clientY };
      lastPoint = { x: touch.clientX, y: touch.clientY };
      lastMoveTime = now;
      velocity = dy / dt;
      const cellH = Math.max(8, this._cellMetrics().height || 18);
      accumPx += dy;
      const lines = Math.trunc(accumPx / cellH);
      if (lines !== 0) {
        accumPx -= lines * cellH;
        applyScrollLines(lines, touch.clientX, touch.clientY);
      }
    };
    const onEnd = (event) => {
      clearHold(); origin = null; lastTouch = null;
      const remainingTouches = event.touches?.length || 0;
      const blocked = gestureBlocked || hadMultiTouch || Boolean(pinch) || panning || selecting || scrolling || moved;
      if (blocked) {
        suppressMouseUntil = Date.now() + 700;
        suppressClick = true;
      }
      if (pinch && remainingTouches < 2) {
        pinch = null;
        event.preventDefault?.(); event.stopPropagation?.();
      } else if (panning) {
        panning = false;
        event.preventDefault?.(); event.stopPropagation?.();
      } else if (selecting) {
        event.preventDefault?.(); event.stopPropagation?.();
      } else if (scrolling) {
        event.preventDefault?.(); event.stopPropagation?.();
        scrolling = false;
        if (Math.abs(velocity) > 0.25 && typeof this.global.requestAnimationFrame === 'function') {
          let v = velocity;
          let carry = 0;
          const cellH = Math.max(8, this._cellMetrics().height || 18);
          const step = () => {
            if (this.disposed || Math.abs(v) < 0.04) { momentumId = null; return; }
            carry += v * 16;
            const lines = Math.trunc(carry / cellH);
            if (lines !== 0) {
              carry -= lines * cellH;
              applyScrollLines(lines, lastPoint.x, lastPoint.y);
            }
            v *= 0.92;
            momentumId = this.global.requestAnimationFrame(step);
          };
          momentumId = this.global.requestAnimationFrame(step);
        }
      } else if (blocked) {
        event.preventDefault?.(); event.stopPropagation?.();
      } else if (this._isMobile() && event.type === 'touchend' && this._isPaneInputAllowed(entry.paneId)) {
        const doc = this.global.document;
        const ta = term.textarea;
        if (ta && doc?.activeElement === ta && !doc.documentElement?.classList?.contains('mobile-keyboard-open')) {
          ta.blur();
          ta.focus({ preventScroll: true });
        }
      }
      if (remainingTouches === 0) {
        hadMultiTouch = false;
        gestureBlocked = false;
        moved = false;
      }
    };
    const onCancel = () => {
      clearHold();
      origin = null;
      lastTouch = null;
      pinch = null;
      panning = false;
      scrolling = false;
      selecting = false;
      moved = false;
      hadMultiTouch = false;
      gestureBlocked = false;
      suppressMouseUntil = Date.now() + 700;
      suppressClick = true;
    };
    const onMouseDown = (event) => {
      if (!this._isMobile() || event.target.closest?.('.wb-touch-copy, .wb-scroll-bottom, .wb-history-pill, .seam-pane-takeover')) return;
      if (Date.now() < suppressMouseUntil || gestureBlocked || !this._isPaneInputAllowed(entry.paneId)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onClick = (event) => {
      if (event.target.closest?.('.wb-touch-copy, .wb-scroll-bottom, .wb-history-pill, .seam-pane-takeover')) return;
      if (suppressClick || (this._isMobile() && Date.now() < suppressMouseUntil)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      }
    };
    body.addEventListener('touchstart', onStart, { capture: true, passive: true });
    body.addEventListener('touchmove', onMove, { capture: true, passive: false });
    body.addEventListener('touchend', onEnd, { capture: true, passive: false });
    body.addEventListener('touchcancel', onCancel, { capture: true, passive: true });
    body.addEventListener('mousedown', onMouseDown, true);
    body.addEventListener('click', onClick, true);
    entry.cleanups.push(() => {
      clearHold(); stopMomentum(); copyButton?.remove(); scrollBottomBtn.remove();
      onScrollSub?.dispose?.(); onParsedSub?.dispose?.();
      body.removeEventListener('touchstart', onStart, { capture: true });
      body.removeEventListener('touchmove', onMove, { capture: true });
      body.removeEventListener('touchend', onEnd, { capture: true });
      body.removeEventListener('touchcancel', onCancel, { capture: true });
      body.removeEventListener('mousedown', onMouseDown, true);
      body.removeEventListener('click', onClick, true);
    });
  }

  _disposePane(paneId) {
    const entry = this.panes.get(paneId);
    if (!entry) return;
    this.panes.delete(paneId);
    this._teardownPaneRenderer(entry);
    entry.el.remove();
  }

  _disconnect() {
    this.epoch++;
    for (const key of ['connectTimer', 'resizeTimer', 'retryTimer', '_ackTimer']) {
      this.global.clearTimeout(this[key]);
      this[key] = null;
    }
    this._pendingAcks.clear();
    this._lastFocusSig = null;
    for (const pane of this.panes.values()) {
      pane.snapshotAssembly = null;
      pane.historyLoading = false;
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch { /* closed */ }
      this.ws = null;
    }
  }

  _drop(retryable, message) {
    this._disconnect();
    if (!retryable) { this._setStatus('invalid', message); return; }
    this._setStatus('disconnected', message);
    if (++this.attempt <= 10 && this.visible) {
      this.retryTimer = this.global.setTimeout(() => {
        this.retryTimer = null;
        this._connect();
      }, Math.min(1000 * 1.5 ** (this.attempt - 1), 15_000));
    }
  }

  _pause(reason) {
    this._disconnect();
    for (const pane of this.panes.values()) {
      pane.term?.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25l');
    }
    const detached = !reason || ['detached', 'taken_over', 'tmux_client_exit'].includes(reason);
    this._setStatus(
      detached ? 'detached' : 'exited',
      reason === 'detached' || reason === 'taken_over'
        ? '会话已被其他端接管，画面已暂停更新，终端任务继续运行。'
        : detached
          ? '终端连接已结束，画面已暂停更新，可手动重新连接。'
          : reason === 'window_closed'
            ? '窗口已关闭'
            : '会话已结束，已保留最后画面。',
      reason || null,
    );
  }

  refresh() {
    if (this.disposed || this.status === 'exited' || this.status === 'invalid') return;
    this._disconnect();
    this.attempt = 0;
    this._setStatus('connecting', '正在重新连接');
    this.fit();
    this._connect();
  }

  invalidate(message = '远端窗口已不存在') {
    this._disconnect();
    this._setStatus('invalid', message);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._cancelWebglAttach();
    this._activeDragCleanup?.(false);
    this._disconnect();
    this.global.clearTimeout(this.wheelTimer);
    this.resizeObserver?.disconnect();
    for (const cleanup of this.cleanups) {
      if (typeof cleanup === 'function') cleanup();
      else cleanup?.dispose?.();
    }
    this.cleanups = [];
    for (const paneId of [...this.panes.keys()]) this._disposePane(paneId);
    this.stage.remove();
    this._emitPanesChanged();
  }
}
