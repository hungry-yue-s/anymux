import { validateTarget, validateWindowTarget, newId } from './model.js';
import { TileRegistry, parseTilePayload } from './tile-registry.js';

const FONT_FAMILY = "'Anymux Mono', 'Maple Mono NF CN', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Symbols Nerd Font Mono', monospace";
const MAX_WEBGL_PANES = 6;
const MAX_RENDER_BACKLOG = 16 * 1024 * 1024;
const INPUT_CHUNK_BYTES = 32768;

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
  close: SVG_NS + '<path d="M18 6 6 18M6 6l12 12"/></svg>',
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
      historyTotal: view.getUint32(13, false),
      historyLines: view.getUint32(17, false),
      data: bytes.subarray(21),
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
const PANE_PAD_X = 16;
const PANE_PAD_Y = 10;
const DIVIDER_PX = 1;

function measureLayoutMetrics(node, panes, cell) {
  const fallback = {
    chromeW: PANE_PAD_X,
    chromeH: PANE_RAIL_PX + PANE_PAD_Y,
    contentCols: 1,
    contentRows: 1,
    netWidthPx: PANE_PAD_X,
    netHeightPx: PANE_RAIL_PX + PANE_PAD_Y,
  };
  if (!node) return fallback;
  if (node.type === 'pane') {
    const entry = panes?.get(node.paneId);
    const isRich = Boolean(entry?.isRich);
    const chromeW = isRich ? 0 : PANE_PAD_X;
    const chromeH = PANE_RAIL_PX + (isRich ? 0 : PANE_PAD_Y);
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
    };
  }
  const children = (node.children || []).filter((child) => child && (child.type !== 'pane' || !panes || panes.has(child.paneId)));
  if (!children.length) return fallback;
  const childMetrics = children.map((child) => measureLayoutMetrics(child, panes, cell));
  const dividerCount = Math.max(0, children.length - 1);
  if (node.dir === 'row') {
    return {
      chromeW: childMetrics.reduce((sum, item) => sum + item.chromeW, 0) + dividerCount * DIVIDER_PX,
      chromeH: Math.max(...childMetrics.map((item) => item.chromeH)),
      contentCols: Math.max(1, childMetrics.reduce((sum, item) => sum + item.contentCols, 0)),
      contentRows: Math.max(1, Math.min(...childMetrics.map((item) => item.contentRows))),
      netWidthPx: childMetrics.reduce((sum, item) => sum + item.netWidthPx, 0) + dividerCount * (DIVIDER_PX - cell.width),
      netHeightPx: Math.max(...childMetrics.map((item) => item.netHeightPx)),
    };
  }
  return {
    chromeH: childMetrics.reduce((sum, item) => sum + item.chromeH, 0) + dividerCount * DIVIDER_PX,
    chromeW: Math.max(...childMetrics.map((item) => item.chromeW)),
    contentRows: Math.max(1, childMetrics.reduce((sum, item) => sum + item.contentRows, 0)),
    contentCols: Math.max(1, Math.min(...childMetrics.map((item) => item.contentCols))),
    netHeightPx: childMetrics.reduce((sum, item) => sum + item.netHeightPx, 0) + dividerCount * (DIVIDER_PX - cell.height),
    netWidthPx: Math.max(...childMetrics.map((item) => item.netWidthPx)),
  };
}

function firstLeafPaneId(node, side = 'start') {
  if (!node) return null;
  if (node.type === 'pane') return node.paneId || node.id || null;
  const children = node.children || [];
  if (!children.length) return null;
  return firstLeafPaneId(side === 'end' ? children[children.length - 1] : children[0], side);
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
    onContext = () => {},
    onAction = () => {},
    visible = true,
    fontSize,
  }) {
    this.global = global;
    this.container = container;
    this.target = validateWindowTarget(target);
    if (!this.target) throw new Error('无效的窗口目标');
    this.onFocus = onFocus;
    this.onState = onState;
    this.onTitle = onTitle;
    this.onFontSize = onFontSize;
    this.onContext = onContext;
    this.onAction = onAction;
    this.visible = visible;
    this.status = 'connecting';
    this.disposed = false;
    this.epoch = 0;
    this.attempt = 0;
    this.inputVersion = 0;
    this.sizeLease = 'owner';
    this.foreignClient = false;
    this.zoomed = false;
    this.activePaneId = null;
    this.windowCols = 80;
    this.windowRows = 24;
    this.layoutTree = null;
    this.layoutString = '';
    this.cleanups = [];
    this.panes = new Map();
    this.context = null;
    this.contextRequest = null;
    this._treeTopologyKey = null;
    this._draggingDivider = false;
    this._activeDragCleanup = null;

    const doc = global.document;
    const mobile = !!global.MobileUI?.isMobile();
    this.fontSize = Math.max(mobile ? 11 : 8, Math.min(22, fontSize || (mobile ? 13 : 14)));
    this.fontReady = false;

    this.stage = doc.createElement('div');
    this.stage.className = 'seam-stage';
    this.leaseBar = doc.createElement('div');
    this.leaseBar.className = 'seam-lease-bar';
    this.leaseBar.hidden = true;
    this.treeHost = doc.createElement('div');
    this.treeHost.className = 'seam-tree-host';
    this.stage.append(this.leaseBar, this.treeHost);
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
      for (const pane of this.panes.values()) {
        if (pane.term) pane.term.options.theme = theme;
      }
    };
    this._listen(doc, 'tmux-theme-change', themeSync);
    this._listen(doc, 'tmux-transparency-change', themeSync);

    this._bindStageMenus();

    if (global.ResizeObserver) {
      this.resizeObserver = new global.ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.treeHost);
    }
    this._listen(global, 'resize', () => this.fit());
    if (global.visualViewport) this._listen(global.visualViewport, 'resize', () => this.fit());

    this.ready = this._prepareFonts().then(() => {
      if (this.disposed || !container.isConnected) return;
      this.rendererPrepared = true;
      if (this.visible) this._connect();
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

  async _prepareFonts() {
    try {
      const loaded = await (this.global.TerminalFonts?.coreReady(1500) || Promise.resolve(false));
      if (this.disposed) return;
      if (loaded === true) this.fontReady = true;
      else if (loaded === null) {
        this.global.TerminalFonts.coreReady(0).then((late) => {
          if (late && !this.disposed) {
            this.fontReady = true;
            for (const pane of this.panes.values()) {
              if (!pane.term) continue;
              pane.term.options.fontFamily = FONT_FAMILY;
              pane.term.clearTextureAtlas?.();
            }
            this.fit();
          }
        }).catch(() => {});
      }
    } catch { /* fallback monospace */ }
  }

  _setStatus(status, message = '') {
    this.status = status;
    this.message = message;
    this._syncInputGates();
    if (!this.disposed) this.onState({ status, message, target: this.target });
  }

  _syncInputGates() {
    const windowLive = this.status === 'live';
    for (const pane of this.panes.values()) {
      if (!pane.term) continue;
      const enabled = windowLive && pane.hydrated && !pane.restoring;
      pane.term.options.disableStdin = !enabled;
      pane.term.options.cursorBlink = enabled && pane.paneId === this.activePaneId;
    }
  }

  _url() {
    const global = this.global;
    const { serverId, instanceId, sessionId, windowId, clientId } = this.target;
    const path = global.Api.nodeUrl(serverId, '/ws/window-stream/' + encodeURIComponent(windowId));
    const grid = this._measureWindowGrid();
    const query = new URLSearchParams({
      instanceId,
      sessionId,
      clientId,
      cols: String(grid.cols || this.windowCols || 80),
      rows: String(grid.rows || this.windowRows || 24),
      protocol: '1',
    });
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
    this.lastRequestedSize = null;
    for (const pane of this.panes.values()) {
      pane.hydrated = Boolean(pane.isRich);
      pane.restoring = false;
      pane.lastSeq = null;
      pane.pendingWrites = [];
      pane.pendingBytes = 0;
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
        } else if (message.type === 'exit') {
          this._pause(message.reason);
        } else if (message.type === 'error') {
          this._drop(message.retryable === true, message.message || '无法连接窗口');
        }
      } catch (error) {
        this._drop(false, error.message || '窗口流协议无效');
      }
    };
    ws.onclose = (event) => {
      if (!current()) return;
      if (event.code === 1000) this._pause();
      else this._drop(![1008, 1013].includes(event.code), '连接已断开');
    };
    ws.onerror = () => {};
  }

  _handleLeaseMessage(message) {
    if (message.protocol != null && message.protocol !== 1) throw new Error('窗口流协议版本不匹配');
    if (message.instanceId && message.instanceId !== this.target.instanceId) {
      throw new Error('tmux 实例已变化');
    }
    this.sizeLease = message.sizeLease || 'owner';
    this.foreignClient = Boolean(message.foreignClient);
    if (Number.isInteger(message.windowCols)) this.windowCols = message.windowCols;
    if (Number.isInteger(message.windowRows)) this.windowRows = message.windowRows;
    if (typeof message.zoomed === 'boolean') this.zoomed = message.zoomed;
    if (message.type === 'ready') this.serverReady = true;
    this._renderLeaseBar();
    this._becameReady();
  }

  _handleLayoutMessage(message) {
    this.layoutReceived = true;
    if (Number.isInteger(message.windowCols)) this.windowCols = message.windowCols;
    if (Number.isInteger(message.windowRows)) this.windowRows = message.windowRows;
    this.zoomed = Boolean(message.zoomed);
    this.layoutString = message.layoutString || '';
    this.layoutTree = message.tree || null;
    const panes = Array.isArray(message.panes) ? message.panes : [];
    const activeFromPanes = panes.find((item) => item.active)?.id;
    this.activePaneId = message.activePaneId || activeFromPanes || panes[0]?.id || null;

    const liveIds = new Set(panes.map((item) => item.id));
    for (const paneId of [...this.panes.keys()]) {
      if (!liveIds.has(paneId)) this._disposePane(paneId);
    }
    for (const meta of panes) {
      const entry = this._ensurePane(meta);
      this._updatePaneMeta(entry, meta);
    }

    this._renderTree();
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
    this._syncActivePaneState();
    this._publishContext();
    this._syncInputGates();
    this.syncAttention();
    this._becameReady();
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

    // Snapshot fence (`0x02`): always authoritative over an ordered WebSocket.
    entry.lastSeq = frame.seq;
    entry.historyTotal = frame.historyTotal;
    entry.historyLines = frame.historyLines;
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
      entry.restoring = false;
      const queued = entry.pendingWrites.splice(0);
      entry.pendingBytes = 0;
      for (const chunk of queued) this._queueLiveWrite(entry, chunk, epoch);
      this._syncInputGates();
      this._becameReady();
    };

    entry.term.reset();
    if (frame.cols >= 2 && frame.rows >= 2) {
      entry.term.resize(frame.cols, frame.rows);
    }
    if (frame.data.byteLength === 0) finishRestore();
    else entry.term.write(frame.data, finishRestore);
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
    const schedule = typeof this.global.requestAnimationFrame === 'function'
      ? (fn) => this.global.requestAnimationFrame(fn)
      : (fn) => this.global.queueMicrotask(fn);
    schedule(() => {
      entry.flushScheduled = false;
      if (this.disposed || epoch !== this.epoch || entry.restoring || !this.panes.has(entry.paneId)) return;
      if (!entry.liveChunks.length) return;
      const chunks = entry.liveChunks.splice(0);
      entry.liveBytes = 0;
      if (chunks.length === 1) {
        entry.term.write(chunks[0]);
      } else {
        let total = 0;
        for (const chunk of chunks) total += chunk.byteLength;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        entry.term.write(merged);
      }
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
    this._publishContext();
    this.fit();
  }

  _createTerminalInstance() {
    const mobile = !!this.global.MobileUI?.isMobile();
    const term = new this.global.Terminal({
      theme: this.global.Theme?.getTerminalTheme?.(),
      minimumContrastRatio: 4.5,
      allowTransparency: !!this.global.Theme?.supportsTransparency?.(),
      fontFamily: this.fontReady ? FONT_FAMILY : 'monospace',
      fontSize: this.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      overviewRuler: { width: 0 },
      rescaleOverlappingGlyphs: true,
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
    const closeBtn = makeBtn('close', '关闭窗格', PANE_ICONS.close, 'is-secondary is-close');
    actions.append(splitHBtn, splitVBtn, zoomBtn, closeBtn);

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

    rail.append(num, ico, identity, actions, confirmBox);

    const body = doc.createElement('div');
    body.className = 'pane-body';
    body.dataset.contextZone = 'pane-body';
    body.dataset.paneId = paneId;

    el.append(rail, body);

    entry = {
      paneId,
      meta: { ...meta },
      el,
      rail,
      body,
      num,
      ico,
      titleEl,
      cmdChip,
      ctxEl,
      statusBadge,
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
      restoring: false,
      lastSeq: null,
      pendingWrites: [],
      pendingBytes: 0,
      liveChunks: [],
      liveBytes: 0,
      flushScheduled: false,
      historyTotal: 0,
      historyLines: 0,
    };

    const focusThisPane = () => {
      if (this.disposed) return;
      if (this.activePaneId !== paneId) this.selectPane(paneId);
      else this.onFocus();
    };
    el.addEventListener('pointerdown', focusThisPane, true);
    rail.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-pane-action]');
      if (!btn) { focusThisPane(); entry.term?.focus(); return; }
      event.stopPropagation();
      const action = btn.dataset.paneAction;
      if (action === 'split-h') this.onAction('split', { paneId, direction: 'horizontal' });
      else if (action === 'split-v') this.onAction('split', { paneId, direction: 'vertical' });
      else if (action === 'zoom') this.zoomPane(paneId);
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
        global.queueMicrotask(() => { entry.pointerDispatch = false; });
      };
      body.addEventListener(type, handler, true);
      cleanups.push(() => body.removeEventListener(type, handler, true));
    }
    this._installCompositionGuard(entry);
    const onMouseUp = () => {
      if (!global.MobileUI?.isMobile()) {
        const selection = term.getSelection?.();
        if (selection) this.copy(selection);
      }
    };
    term.element?.addEventListener('mouseup', onMouseUp);
    cleanups.push(() => term.element?.removeEventListener('mouseup', onMouseUp));
    this._installTouchSelection(entry);

    if (global.WebglAddon && this.panes.size <= MAX_WEBGL_PANES) {
      try {
        const addon = new global.WebglAddon.WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); if (!this.disposed) term.refresh?.(0, term.rows - 1); });
        term.loadAddon(addon);
        entry.webglAddon = addon;
      } catch { /* canvas fallback */ }
    }
    term.clearTextureAtlas?.();
    this._attachPaneLinkProvider(entry);
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

  _updatePaneMeta(entry, meta) {
    const prevCwd = entry.meta?.cwd;
    entry.meta = { ...entry.meta, ...meta };
    const idx = Number.isInteger(entry.meta.index) ? entry.meta.index : Number(entry.paneId.slice(1)) || 0;
    const isRich = Boolean(entry.meta.kind && entry.meta.kind !== 'terminal');
    const kind = isRich ? entry.meta.kind : commandKind(entry.meta.command || entry.meta.label);
    entry.num.textContent = String(idx);
    entry.ico.className = 'pane-proc-ico is-' + kind;
    entry.ico.innerHTML = PANE_ICONS[kind] || (isRich ? PANE_ICONS.rich : PANE_ICONS.shell);
    const primaryTitle = entry.meta.label || (isRich ? '[' + kind + '] ' + (parseTilePayload(entry.meta.payload).url || parseTilePayload(entry.meta.payload).path || kind) : (entry.meta.title || entry.meta.command || ('窗格 ' + idx)));
    entry.titleEl.textContent = primaryTitle;
    const cmd = isRich ? '' : basenameOf(entry.meta.command);
    entry.cmdChip.textContent = cmd && cmd !== primaryTitle ? cmd : '';
    entry.cmdChip.hidden = !entry.cmdChip.textContent;
    const cwdShort = basenameOf(entry.meta.cwd);
    entry.ctxEl.textContent = cwdShort || '';
    entry.ctxEl.title = entry.meta.cwd || '';
    entry.ctxEl.hidden = !cwdShort;
    entry.zoomBtn.classList.toggle('is-zoomed', this.zoomed && entry.paneId === this.activePaneId);
    entry.zoomBtn.innerHTML = this.zoomed && entry.paneId === this.activePaneId ? PANE_ICONS.unzoom : PANE_ICONS.zoom;
    if (!isRich && entry.opened && prevCwd !== entry.meta.cwd) {
      this._attachPaneLinkProvider(entry);
    }
  }

  _syncActivePaneState() {
    for (const entry of this.panes.values()) {
      const isActive = entry.paneId === this.activePaneId;
      entry.el.classList.toggle('is-active', isActive);
      entry.zoomBtn.classList.toggle('is-zoomed', this.zoomed && isActive);
      entry.zoomBtn.innerHTML = this.zoomed && isActive ? PANE_ICONS.unzoom : PANE_ICONS.zoom;
    }
  }

  _renderLeaseBar() {
    const doc = this.global.document;
    this.leaseBar.replaceChildren();
    if (this.sizeLease === 'follow-foreign') {
      this.leaseBar.hidden = false;
      const text = doc.createElement('span');
      text.textContent = '其他客户端正在控制窗口尺寸（' + this.windowCols + '×' + this.windowRows + '），当前可继续输入';
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'seam-lease-btn';
      btn.textContent = '接管尺寸';
      btn.addEventListener('click', () => this.takeover());
      this.leaseBar.append(text, btn);
    } else if (this.sizeLease === 'owner' && this.foreignClient) {
      this.leaseBar.hidden = false;
      const text = doc.createElement('span');
      text.textContent = '已接管窗口尺寸（' + this.windowCols + '×' + this.windowRows + '）';
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'seam-lease-btn';
      btn.textContent = '恢复跟随';
      btn.addEventListener('click', () => this.releaseTakeover());
      this.leaseBar.append(text, btn);
    } else {
      this.leaseBar.hidden = true;
    }
  }

  _layoutTopologyKey() {
    if (this.zoomed && this.activePaneId && this.panes.has(this.activePaneId)) {
      return 'zoom:' + this.activePaneId;
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
    const metrics = measureLayoutMetrics(child, this.panes, this._cellMetrics());
    return dir === 'col'
      ? (metrics.contentRows + ' 1 ' + metrics.chromeH + 'px')
      : (metrics.contentCols + ' 1 ' + metrics.chromeW + 'px');
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
        const divider = dividers[idx];
        divider._seamNodes = { leftNode: child, rightNode: activeChildren[idx + 1] };
        const leftPane = firstLeafPaneId(child, 'end');
        const rightPane = firstLeafPaneId(activeChildren[idx + 1], 'start');
        if (leftPane) divider.dataset.leftPane = leftPane;
        else delete divider.dataset.leftPane;
        if (rightPane) divider.dataset.rightPane = rightPane;
        else delete divider.dataset.rightPane;
      }
    }
    return true;
  }

  _renderTree() {
    const doc = this.global.document;
    const host = this.treeHost;
    const nextKey = this._layoutTopologyKey();
    if (nextKey && nextKey === this._treeTopologyKey && host.childElementCount > 0) {
      if (this.zoomed || !this.layoutTree || this._syncTreeInPlace(this.layoutTree, host.firstElementChild)) {
        this._syncJunctions();
        return;
      }
    }
    this.lastRequestedSize = null;

    const hadFocus = Boolean(doc.activeElement && host.contains(doc.activeElement));
    host.replaceChildren();

    if (this.zoomed && this.activePaneId && this.panes.has(this.activePaneId)) {
      const entry = this.panes.get(this.activePaneId);
      const wrap = doc.createElement('div');
      wrap.className = 'seam-split is-row';
      wrap.append(entry.el);
      host.append(wrap);
      this._treeTopologyKey = nextKey;
      if (hadFocus && !entry.isRich) entry.term?.focus();
      return;
    }

    const buildNode = (node) => {
      if (!node) return null;
      if (node.type === 'pane') {
        const entry = this.panes.get(node.paneId);
        return entry ? entry.el : null;
      }
      const split = doc.createElement('div');
      split.className = 'seam-split ' + (node.dir === 'col' ? 'is-col' : 'is-row');
      const children = node.children || [];
      children.forEach((child, idx) => {
        const branchEl = buildNode(child);
        if (!branchEl) return;
        const branch = doc.createElement('div');
        branch.className = 'seam-branch';
        branch.style.flex = this._branchFlex(child, node.dir);
        branch.append(branchEl);
        split.append(branch);

        if (idx < children.length - 1) {
          const divider = doc.createElement('div');
          divider.className = 'seam-divider ' + (node.dir === 'col' ? 'is-h' : 'is-v');
          divider.setAttribute('role', 'separator');
          divider.setAttribute('aria-orientation', node.dir === 'col' ? 'horizontal' : 'vertical');
          divider.tabIndex = 0;
          divider.dataset.contextZone = 'divider';
          divider.dataset.splitDir = node.dir === 'col' ? 'col' : 'row';
          const leftPane = firstLeafPaneId(child, 'end');
          const rightPane = firstLeafPaneId(children[idx + 1], 'start');
          if (leftPane) divider.dataset.leftPane = leftPane;
          if (rightPane) divider.dataset.rightPane = rightPane;
          this._bindDivider(divider, node.dir === 'col' ? 'col' : 'row', child, children[idx + 1], branch);
          split.append(divider);
        }
      });
      return split;
    };

    const rootNode = this.layoutTree
      ? buildNode(this.layoutTree)
      : (this.panes.values().next().value?.el || null);
    if (rootNode) host.append(rootNode);
    this._treeTopologyKey = nextKey;
    this._syncJunctions();
    if (hadFocus && this.activePaneId) {
      const activeEntry = this.panes.get(this.activePaneId);
      if (activeEntry && !activeEntry.isRich) activeEntry.term?.focus();
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

  _bindDivider(divider, dir, leftNode, rightNode, leftBranch) {
    divider._seamNodes = { leftNode, rightNode };
    divider.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.onAction('equalize', { layout: dir === 'col' ? 'even-vertical' : 'even-horizontal' });
    });
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const cell = this._cellMetrics();
      const state = this._buildAxisDragState({ dir, divider, leftBranch, leftNode, rightNode }, cell);
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

  _bindStageMenus() {
    const doc = this.global.document;
    const openMenuForTarget = (targetEl, clientX, clientY) => {
      const ContextMenu = this.global.ContextMenu;
      if (!ContextMenu) return false;
      const rail = targetEl.closest?.('[data-context-zone="pane-rail"]');
      if (rail) {
        const paneId = rail.dataset.paneId;
        const entry = this.panes.get(paneId);
        ContextMenu.open({
          x: clientX,
          y: clientY,
          label: '窗格操作',
          items: [
            { id: 'split-h', label: '左右分窗', action: () => this.onAction('split', { paneId, direction: 'horizontal' }) },
            { id: 'split-v', label: '上下分窗', action: () => this.onAction('split', { paneId, direction: 'vertical' }) },
            { id: 'split-rich-browser', label: '拆分富窗格: 网页', action: () => this.onAction('split-rich', { paneId, direction: 'horizontal', kind: 'browser' }) },
            { id: 'split-rich-doc', label: '拆分富窗格: 文档', action: () => this.onAction('split-rich', { paneId, direction: 'horizontal', kind: 'doc' }) },
            { id: 'split-rich-diff', label: '拆分富窗格: Git 变更', action: () => this.onAction('split-rich', { paneId, direction: 'horizontal', kind: 'diff' }) },
            ...(entry?.isRich ? [{ id: 'to-terminal', label: '切换回终端', action: () => this.onAction('set-pane-kind', { paneId, kind: 'terminal' }) }] : []),
            { id: 'zoom', label: this.zoomed && this.activePaneId === paneId ? '还原窗格' : '最大化窗格', action: () => this.zoomPane(paneId) },
            { id: 'rename', label: '重命名窗格', action: () => this.startRenamePane(paneId) },
            { id: 'break', label: '拆分为独立窗口', disabled: this.panes.size <= 1, action: () => this.onAction('break-pane', { paneId }) },
            ...(!entry?.isRich ? [{ id: 'history', label: '滚动历史', action: () => this.onAction('history', { paneId }) }, { id: 'clear', label: '清屏', action: () => this.onAction('clear-pane', { paneId }) }] : []),
            { separator: true },
            { id: 'close', label: '关闭窗格', danger: true, action: () => (this.panes.size <= 1 ? this.onAction('close-window', { paneId }) : this.onAction('close-pane', { paneId })) },
          ],
          onClose: () => entry?.term?.focus(),
        });
        return true;
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
            { id: 'history', label: '滚动历史', action: () => this.onAction('history', { paneId }) },
            ...(cwd ? [{ id: 'copy-cwd', label: '复制工作目录', action: () => this.copy(cwd) }] : []),
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

  _sendInput(paneId, data, binary = false) {
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

  send(data, trackIntent = true, paneId = this.activePaneId) {
    const entry = paneId && this.panes.get(paneId);
    if (this.status !== 'live' || !entry?.term || !entry?.hydrated || entry.restoring || typeof data !== 'string') return false;
    if (trackIntent) this.inputVersion++;
    return this._sendInput(paneId, data, false);
  }

  paste(text, paneId = this.activePaneId) {
    const entry = paneId && this.panes.get(paneId);
    if (this.status !== 'live' || !entry?.term || !entry?.hydrated || entry.restoring) return false;
    if (entry.term.paste) entry.term.paste(text);
    else this.send(text, true, paneId);
    return true;
  }

  selectPane(paneId) {
    if (this.disposed || !this.panes.has(paneId)) return false;
    const prev = this.activePaneId;
    this.activePaneId = paneId;
    this._syncActivePaneState();
    this._syncInputGates();
    this._publishContext();
    this.panes.get(paneId)?.term?.focus();
    if (prev !== paneId && this.status === 'live') {
      this._send({ type: 'select-pane', paneId });
    }
    return true;
  }

  zoomPane(paneId = this.activePaneId, zoomed) {
    if (!paneId || !this.panes.has(paneId)) return false;
    return this._send({ type: 'zoom-pane', paneId, ...(typeof zoomed === 'boolean' ? { zoomed } : {}) });
  }

  takeover() {
    return this._send({ type: 'takeover' });
  }

  releaseTakeover() {
    return this._send({ type: 'release-takeover' });
  }

  _cellMetrics() {
    for (const entry of this.panes.values()) {
      if (!entry.term) continue;
      const dims = entry.term?._core?._renderService?.dimensions?.css?.cell;
      if (dims?.width > 2 && dims?.height > 4) return { width: dims.width, height: dims.height };
      const screen = entry.body?.querySelector?.('.xterm-screen');
      const rect = screen?.getBoundingClientRect?.();
      if (rect?.width > 0 && rect?.height > 0 && entry.term.cols > 0 && entry.term.rows > 0) {
        return { width: rect.width / entry.term.cols, height: rect.height / entry.term.rows };
      }
    }
    return { width: 8.4, height: Math.max(14, Math.round(this.fontSize * 1.35)) };
  }

  _measureWindowGrid() {
    const w = this.treeHost.clientWidth;
    const h = this.treeHost.clientHeight;
    if (!w || !h) return { cols: 0, rows: 0 };
    const cell = this._cellMetrics();
    let netWidthPx;
    let netHeightPx;
    if (this.zoomed) {
      const activeEntry = (this.activePaneId && this.panes.get(this.activePaneId)) || this.panes.values().next().value;
      const isRich = Boolean(activeEntry?.isRich);
      const chromeW = isRich ? 0 : PANE_PAD_X;
      const chromeH = PANE_RAIL_PX + (isRich ? 0 : PANE_PAD_Y);
      const paneH = activeEntry?.meta?.height;
      const borderRows = (Number.isInteger(paneH) && Number.isInteger(this.windowRows) && this.windowRows > paneH)
        ? Math.min(2, this.windowRows - paneH) : 0;
      netWidthPx = chromeW;
      netHeightPx = chromeH - borderRows * cell.height;
    } else {
      ({ netWidthPx, netHeightPx } = measureLayoutMetrics(this.layoutTree, this.panes, cell));
    }
    const usableW = Math.max(cell.width * 2, w - netWidthPx);
    const usableH = Math.max(cell.height * 2, h - netHeightPx);
    return {
      cols: Math.max(2, Math.floor(usableW / cell.width)),
      rows: Math.max(2, Math.floor(usableH / cell.height)),
    };
  }

  fit() {
    if (this.disposed || !this.visible || !this.treeHost.isConnected) return;
    if (this.sizeLease !== 'owner') return;
    const { cols, rows } = this._measureWindowGrid();
    if (this.status !== 'live' || cols < 2 || rows < 2) return;
    const key = cols + ':' + rows;
    if (key === this.lastRequestedSize || (cols === this.windowCols && rows === this.windowRows)) return;
    this.global.clearTimeout(this.resizeTimer);
    this.resizeTimer = this.global.setTimeout(() => {
      if (this.disposed || !this.visible || this.status !== 'live' || this.sizeLease !== 'owner') return;
      if (this._send({ type: 'resize-window', cols, rows })) {
        this.lastRequestedSize = key;
      }
    }, 80);
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.ws?.readyState === 1) {
      this._send({ type: 'visibility', visible });
    }
    if (visible) {
      this.fit();
      if (!this.ws && this.rendererPrepared && !this.retryTimer) this._connect();
    }
  }

  focus(paneId = this.activePaneId) {
    if (this.disposed) return;
    const target = (paneId && this.panes.get(paneId)) || this.panes.values().next().value;
    target?.term?.focus();
  }

  setFontSize(size) {
    if (this.disposed) return;
    this.fontSize = Math.max(this.global.MobileUI?.isMobile() ? 11 : 8, Math.min(22, size));
    for (const pane of this.panes.values()) {
      if (!pane.term) continue;
      pane.term.options.fontSize = this.fontSize;
      pane.term.clearTextureAtlas?.();
    }
    this.onFontSize(this.fontSize);
    this.lastRequestedSize = null;
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
    let origin, anchor, selecting = false, suppressClick = false, copyButton;
    const clearHold = () => { this.global.clearTimeout(entry.holdTimer); entry.holdTimer = null; };
    const position = (touch) => {
      const screen = term.element?.querySelector?.('.xterm-screen') || term.element;
      const rect = screen?.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height) return null;
      return {
        col: Math.max(0, Math.min(term.cols - 1, Math.floor((touch.clientX - rect.left) * term.cols / rect.width))),
        row: term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, Math.floor((touch.clientY - rect.top) * term.rows / rect.height))),
      };
    };
    const showCopy = () => {
      if (copyButton) return;
      copyButton = this.global.document.createElement('button');
      copyButton.type = 'button'; copyButton.className = 'wb-touch-copy'; copyButton.textContent = '复制选区';
      copyButton.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        const selection = term.getSelection?.();
        if (selection) this.copy(selection);
        copyButton?.remove(); copyButton = null;
        suppressClick = false; selecting = false;
      });
      entry.el.append(copyButton);
    };
    const onStart = (event) => {
      if (!this.global.MobileUI?.isMobile() || event.touches.length !== 1 || event.target.closest?.('.wb-touch-copy')) return;
      clearHold(); selecting = false; copyButton?.remove(); copyButton = null;
      const touch = event.touches[0]; origin = { x: touch.clientX, y: touch.clientY }; anchor = position(touch);
      if (!anchor) return;
      entry.holdTimer = this.global.setTimeout(() => {
        if (this.disposed || !anchor) return;
        selecting = true; suppressClick = true;
        const line = term.buffer.active.getLine(anchor.row);
        const word = (col) => /[\p{L}\p{N}_./\\:~-]/u.test(line?.getCell?.(col)?.getChars() || '');
        let left = anchor.col, right = anchor.col;
        if (word(left)) { while (left > 0 && word(left - 1)) left--; while (right < term.cols - 1 && word(right + 1)) right++; }
        anchor = { row: anchor.row, col: left };
        term.select?.(left, anchor.row, right - left + 1);
        showCopy();
      }, 450);
    };
    const onMove = (event) => {
      if (!origin || event.touches.length !== 1) { clearHold(); return; }
      const touch = event.touches[0];
      if (!selecting) { if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 10) clearHold(); return; }
      event.preventDefault(); event.stopPropagation();
      const point = position(touch); if (!point) return;
      const first = anchor.row * term.cols + anchor.col;
      const last = point.row * term.cols + point.col;
      const start = Math.min(first, last);
      term.select?.(start % term.cols, Math.floor(start / term.cols), Math.abs(last - first) + 1);
    };
    const onEnd = (event) => { clearHold(); origin = null; if (selecting) { event.preventDefault(); event.stopPropagation(); } };
    const onClick = (event) => {
      if (event.target.closest?.('.wb-touch-copy')) return;
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    };
    body.addEventListener('touchstart', onStart, { capture: true, passive: true });
    body.addEventListener('touchmove', onMove, { capture: true, passive: false });
    body.addEventListener('touchend', onEnd, { capture: true, passive: false });
    body.addEventListener('touchcancel', clearHold, { passive: true });
    body.addEventListener('click', onClick, true);
    entry.cleanups.push(() => {
      clearHold(); copyButton?.remove();
      body.removeEventListener('touchstart', onStart, { capture: true });
      body.removeEventListener('touchmove', onMove, { capture: true });
      body.removeEventListener('touchend', onEnd, { capture: true });
      body.removeEventListener('touchcancel', clearHold);
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
    for (const key of ['connectTimer', 'resizeTimer', 'retryTimer']) {
      this.global.clearTimeout(this[key]);
      this[key] = null;
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
          : '会话已结束，已保留最后画面。',
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
  }
}
