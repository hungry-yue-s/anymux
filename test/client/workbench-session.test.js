import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { SeamWindowSession, decodeWindowBinaryFrame } from '../../plugins/workbench/client/seam-window-session.js';

const target = { serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@1', clientId: 'c-test' };

function encodeSnapshotBinary({ paneId, seq, cols, rows, text, historyTotal = 0, historyLines = 0 }) {
  const payload = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(21 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, 0x02);
  view.setUint32(1, Number(String(paneId).replace('%', '')), false);
  view.setUint32(5, seq, false);
  view.setUint16(9, cols, false);
  view.setUint16(11, rows, false);
  view.setUint32(13, historyLines, false);
  view.setUint32(17, historyTotal, false);
  new Uint8Array(buf, 21).set(payload);
  return buf;
}

function encodeOutputBinary({ paneId, seq, text }) {
  const payload = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(9 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, 0x01);
  view.setUint32(1, Number(String(paneId).replace('%', '')), false);
  view.setUint32(5, seq, false);
  new Uint8Array(buf, 9).set(payload);
  return buf;
}

function sendLayout(socket, { windowCols = 120, windowRows = 36, zoomed = false, activePaneId = '%1', panes = null, tree = null } = {}) {
  const defaultPanes = panes || [
    { id: '%1', index: 0, active: activePaneId === '%1', width: 60, height: 36, cwd: '/srv/app-one', command: 'claude' },
    { id: '%2', index: 1, active: activePaneId === '%2', width: 59, height: 36, cwd: '/srv/app-two', command: 'bash' },
  ];
  const defaultTree = tree || {
    type: 'split',
    dir: 'row',
    width: 120,
    height: 36,
    children: [
      { type: 'pane', paneId: '%1', width: 60, height: 36 },
      { type: 'pane', paneId: '%2', width: 59, height: 36 },
    ],
  };
  socket.onmessage({ data: JSON.stringify({
    type: 'layout',
    windowId: '@1',
    windowCols,
    windowRows,
    zoomed,
    activePaneId,
    layoutString: 'mock',
    tree: defaultTree,
    panes: defaultPanes,
  }) });
}

function hydrateWindow(socket, { sizeLease = 'owner', foreignClient = false, activePaneId = '%1' } = {}) {
  socket.readyState = 1;
  socket.onopen?.();
  socket.onmessage({ data: JSON.stringify({
    type: 'ready',
    protocol: 1,
    instanceId: '42:123',
    sessionId: '$1',
    windowId: '@1',
    windowCols: 120,
    windowRows: 36,
    zoomed: false,
    sizeLease,
    inputAllowed: true,
    foreignClient,
  }) });
  sendLayout(socket, { activePaneId });
  socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 0, cols: 60, rows: 36, text: 'pane1' }) });
  socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%2', seq: 0, cols: 59, rows: 36, text: 'pane2' }) });
}

export function fixture({ runScripts = false } = {}) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://panel.test', ...(runScripts ? { runScripts: 'outside-only' } : {}) });
  const win = dom.window;
  const sockets = [];
  const terminals = [];
  class Terminal {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      this.resets = 0;
      this.listeners = {};
      this.parser = { registerOscHandler: () => ({ dispose() {} }) };
      this._core = {
        coreService: { triggerDataEvent: (data) => this.listeners.data?.(data) },
        _renderService: { dimensions: { css: { cell: { width: 8, height: 18 } } } },
      };
      this.buffer = { active: { viewportY: 0, baseY: 0, type: 'normal', getLine: () => null } };
      this.modes = { mouseTrackingMode: 'none' };
      this.scrolledLines = [];
      this.scrolledToBottom = 0;
      terminals.push(this);
    }
    open(host) {
      this.element = win.document.createElement('div');
      this.element.className = 'xterm';
      const screen = win.document.createElement('div');
      screen.className = 'xterm-screen';
      screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 360 });
      this.element.append(screen);
      this.textarea = win.document.createElement('textarea');
      this.textarea.className = 'xterm-helper-textarea';
      this.element.append(this.textarea);
      host.append(this.element);
    }
    loadAddon() {}
    onData(fn) { this.listeners.data = fn; return { dispose() {} }; }
    onBinary(fn) { this.listeners.binary = fn; return { dispose() {} }; }
    onTitleChange(fn) { this.listeners.title = fn; return { dispose() {} }; }
    onWriteParsed(fn) { this.listeners.writeParsed = fn; return { dispose() {} }; }
    onScroll(fn) { this.listeners.scroll = fn; return { dispose() {} }; }
    scrollLines(n) { this.scrolledLines.push(n); }
    scrollToBottom() { this.scrolledToBottom += 1; this.buffer.active.viewportY = this.buffer.active.baseY; this.listeners.scroll?.(); }
    clearSelection() {}
    write(data, done) { this.writes.push(data); done?.(); }
    reset() { this.resets += 1; }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    focus() { this.textarea.focus(); }
    dispose() { this.disposed = true; this.element?.remove(); }
    refresh() {}
    clearTextureAtlas() {}
    getSelection() { return 'selected-text'; }
  }
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  win.Terminal = Terminal;
  win.WebSocket = Socket;
  win.FitAddon = { FitAddon: class { fit() {} } };
  win.ResizeObserver = class { constructor(fn) { this.callback = fn; } observe() {} disconnect() { this.disconnected = true; } };
  win.TerminalFonts = { coreReady: () => Promise.resolve(true), ensure: () => Promise.resolve(false) };
  win.Theme = { getTerminalTheme: () => ({ background: '#000' }), supportsTransparency: () => true };
  win.Auth = { wsTokenParam: () => 'token=secret' };
  win.Api = { nodeUrl: (server, path) => '/n/' + server + path };
  win.MobileUI = { isMobile: () => false };
  const host = win.document.getElementById('host');
  Object.defineProperties(host, { clientWidth: { configurable: true, value: 961 }, clientHeight: { configurable: true, value: 680 } });
  return { win, host, sockets, terminals, close: () => dom.window.close() };
}

afterEach(() => vi.useRealTimers());

describe('SeamWindowSession multi-pane workbench session', () => {
  it('decodes big-endian 0x01 output and 0x02 snapshot binary frames', () => {
    const out = decodeWindowBinaryFrame(encodeOutputBinary({ paneId: '%12', seq: 42, text: 'hello' }));
    expect(out.kind).toBe('output');
    expect(out.paneId).toBe('%12');
    expect(out.seq).toBe(42);
    expect(new TextDecoder().decode(out.data)).toBe('hello');

    const snap = decodeWindowBinaryFrame(encodeSnapshotBinary({
      paneId: '%7', seq: 3, cols: 110, rows: 32, historyTotal: 900, historyLines: 250, text: 'snap!',
    }));
    expect(snap).toMatchObject({ kind: 'snapshot', paneId: '%7', seq: 3, cols: 110, rows: 32, historyTotal: 900, historyLines: 250 });
    expect(new TextDecoder().decode(snap.data)).toBe('snap!');
    expect(() => decodeWindowBinaryFrame(new Uint8Array([0x09, 0]))).toThrow();
  });

  it('connects to /ws/window-stream, renders split layout, reuses xterms across layout updates, and ignores stale seq', async () => {
    const f = fixture();
    const contexts = [];
    const session = new SeamWindowSession(f.win, {
      container: f.host,
      target: { ...target },
      onContext: (ctx) => contexts.push(ctx),
    });
    await session.ready;
    const socket = f.sockets[0];
    expect(socket.url).toContain('/n/dev/ws/window-stream/%401');
    expect(socket.binaryType).toBe('arraybuffer');

    hydrateWindow(socket);
    expect(session.status).toBe('live');
    expect(f.host.querySelectorAll('.seam-pane')).toHaveLength(2);
    expect(f.host.querySelectorAll('.seam-divider.is-v')).toHaveLength(1);
    expect(f.terminals).toHaveLength(2);

    // Output coalescing and duplicate-seq deduplication.
    socket.onmessage({ data: encodeOutputBinary({ paneId: '%1', seq: 1, text: 'abc' }) });
    socket.onmessage({ data: encodeOutputBinary({ paneId: '%1', seq: 1, text: 'dup' }) });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.terminals[0].writes.map((b) => new TextDecoder().decode(b))).toEqual(['pane1', 'abc']);

    // Layout focus change reuses the exact same Terminal instances without reset!
    const resetsBefore = f.terminals[0].resets;
    sendLayout(socket, { activePaneId: '%2' });
    expect(f.terminals).toHaveLength(2);
    expect(f.terminals[0].resets).toBe(resetsBefore);
    expect(f.host.querySelector('.seam-pane[data-pane-id="%2"]').classList.contains('is-active')).toBe(true);
    expect(contexts.at(-1).paneId).toBe('%2');

    // Zoom renders active pane only without destroying other xterm state; unzoom brings both back.
    sendLayout(socket, { zoomed: true, activePaneId: '%2' });
    expect(f.host.querySelectorAll('.seam-pane')).toHaveLength(1);
    expect(f.host.querySelector('.seam-pane').dataset.paneId).toBe('%2');
    sendLayout(socket, { zoomed: false, activePaneId: '%2' });
    expect(f.host.querySelectorAll('.seam-pane')).toHaveLength(2);

    session.dispose();
    f.close();
  });

  it('shows follow-foreign lease banner with takeover & release controls while keeping input enabled', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket, { sizeLease: 'follow-foreign', foreignClient: true });

    expect(session.leaseBar.hidden).toBe(false);
    expect(session.leaseBar.textContent).toContain('接管尺寸');
    // Crucial: typing must stay allowed even while following another client's size!
    expect(session.send('ls\r')).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: 'input', paneId: '%1', data: 'ls\r' });

    f.host.querySelector('.seam-lease-btn').click();
    expect(socket.sent.at(-1)).toEqual({ type: 'takeover' });

    socket.onmessage({ data: JSON.stringify({ type: 'size-lease', protocol: 1, sizeLease: 'owner', foreignClient: true, windowCols: 120, windowRows: 36 }) });
    expect(f.host.querySelector('.seam-lease-btn').textContent).toBe('恢复跟随');
    f.host.querySelector('.seam-lease-btn').click();
    expect(socket.sent.at(-1)).toEqual({ type: 'release-takeover' });

    session.dispose();
    f.close();
  });

  it('supports inline close confirmation, inline rename, divider drag resize, and Shift+Right-Click passthrough', async () => {
    const f = fixture();
    const actions = [];
    const openMenu = vi.fn();
    f.win.ContextMenu = { open: openMenu, installLongPress: () => () => {} };
    const session = new SeamWindowSession(f.win, {
      container: f.host,
      target,
      onAction: (action, detail) => actions.push({ action, detail }),
    });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    // Inline close confirm (never window.confirm)
    const pane1 = f.host.querySelector('.seam-pane[data-pane-id="%1"]');
    pane1.querySelector('[data-pane-action="close"]').click();
    expect(pane1.classList.contains('is-confirming')).toBe(true);
    pane1.querySelector('.pane-confirm .is-danger').click();
    expect(actions).toContainEqual({ action: 'close-pane', detail: { paneId: '%1' } });

    // Inline double-click rename
    pane1.querySelector('.pane-title').dispatchEvent(new f.win.MouseEvent('dblclick', { bubbles: true }));
    const renameInput = pane1.querySelector('.pane-rename-input');
    renameInput.value = 'API Worker';
    renameInput.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions).toContainEqual({ action: 'rename-pane', detail: { paneId: '%1', label: 'API Worker' } });

    // Divider drag resize & double-click equalize
    const divider = f.host.querySelector('.seam-divider');
    divider.dispatchEvent(new f.win.MouseEvent('dblclick', { bubbles: true }));
    expect(actions).toContainEqual({ action: 'equalize', detail: { layout: 'even-horizontal' } });

    divider.dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 400, bubbles: true }));
    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 480, bubbles: true }));
    expect(socket.sent.some((msg) => msg.type === 'resize-pane-size' && msg.paneId === '%1' && msg.cols === 70)).toBe(true);

    // Zone 2 Shift+Right-Click passthrough: ContextMenu must NOT open and default must NOT be prevented
    const body = pane1.querySelector('.pane-body');
    const shiftEvt = new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true, clientX: 100, clientY: 100 });
    body.dispatchEvent(shiftEvt);
    expect(shiftEvt.defaultPrevented).toBe(false);
    expect(openMenu).not.toHaveBeenCalled();

    // Plain Right-Click opens ContextMenu and prevents default
    const normalEvt = new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: false, clientX: 100, clientY: 100 });
    body.dispatchEvent(normalEvt);
    expect(normalEvt.defaultPrevented).toBe(true);
    expect(openMenu).toHaveBeenCalledOnce();

    session.dispose();
    f.close();
  });

  it('pauses cleanly on detach and only reconnects when refresh() is called', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);
    socket.onmessage({ data: JSON.stringify({ type: 'exit', reason: 'detached' }) });
    expect(session.status).toBe('detached');
    expect(session.send('blocked')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets).toHaveLength(1);
    session.refresh();
    expect(f.sockets).toHaveLength(2);
    session.dispose();
    f.close();
  });

  it('never freezes output or input after resize resync snapshots with monotonic or reset seq', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    for (let s = 1; s <= 10; s++) {
      socket.onmessage({ data: encodeOutputBinary({ paneId: '%1', seq: s, text: `o${s}` }) });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Case A: Monotonic server resync snapshot (seq = 11) + subsequent live output (seq = 12)
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 11, cols: 72, rows: 36, text: 'resync-a' }) });
    socket.onmessage({ data: encodeOutputBinary({ paneId: '%1', seq: 12, text: 'live-after-a' }) });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.terminals[0].writes.slice(-2).map((b) => new TextDecoder().decode(b))).toEqual(['resync-a', 'live-after-a']);
    expect(session.send('pwd\r')).toBe(true);

    // Case B: Older server snapshot reset (seq = 0) + restarted live output (seq = 1)
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 0, cols: 80, rows: 36, text: 'resync-b' }) });
    socket.onmessage({ data: encodeOutputBinary({ paneId: '%1', seq: 1, text: 'live-after-b' }) });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.terminals[0].writes.slice(-2).map((b) => new TextDecoder().decode(b))).toEqual(['resync-b', 'live-after-b']);
    expect(session.send('ls\r')).toBe(true);

    session.dispose();
    f.close();
  });

  it('previews divider drag smoothly without mid-drag commands, preserves DOM in place, and computes nested split leaf widths', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    const pane1El = f.host.querySelector('.seam-pane[data-pane-id="%1"]');
    const divider = f.host.querySelector('.seam-divider');
    const [leftBranch, rightBranch] = f.host.querySelectorAll('.seam-branch');

    // pointerdown -> pointermove previews flex without sending resize-pane-size mid-drag
    divider.dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 400, bubbles: true }));
    expect(session.stage.classList.contains('is-dragging-divider')).toBe(true);
    f.win.dispatchEvent(new f.win.MouseEvent('pointermove', { clientX: 480, bubbles: true }));
    expect(leftBranch.style.flex).toBe('70 1 16px');
    expect(rightBranch.style.flex).toBe('49 1 16px');
    expect(socket.sent.filter((m) => m.type === 'resize-pane-size')).toHaveLength(0);

    // pointerup commits exactly one resize-pane-size and clears drag state
    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 480, bubbles: true }));
    expect(session.stage.classList.contains('is-dragging-divider')).toBe(false);
    expect(socket.sent.filter((m) => m.type === 'resize-pane-size')).toEqual([
      { type: 'resize-pane-size', paneId: '%1', cols: 70 },
    ]);

    // Updated layout message with same topology updates flex weights in place without detaching panes
    sendLayout(socket, {
      panes: [
        { id: '%1', index: 0, active: true, width: 70, height: 36, cwd: '/srv/app-one', command: 'claude' },
        { id: '%2', index: 1, active: false, width: 49, height: 36, cwd: '/srv/app-two', command: 'bash' },
      ],
      tree: {
        type: 'split',
        dir: 'row',
        width: 120,
        height: 36,
        children: [
          { type: 'pane', paneId: '%1', width: 70, height: 36 },
          { type: 'pane', paneId: '%2', width: 49, height: 36 },
        ],
      },
    });
    expect(f.host.querySelector('.seam-pane[data-pane-id="%1"]')).toBe(pane1El);
    expect(leftBranch.style.flex).toBe('70 1 16px');
    expect(rightBranch.style.flex).toBe('49 1 16px');

    // Nested split on the left side: composite left branch width=80, rightmost leaf %2 width=40.
    sendLayout(socket, {
      panes: [
        { id: '%1', index: 0, active: true, width: 39, height: 36, command: 'bash' },
        { id: '%2', index: 1, active: false, width: 40, height: 36, command: 'claude' },
        { id: '%3', index: 2, active: false, width: 39, height: 36, command: 'zsh' },
      ],
      tree: {
        type: 'split',
        dir: 'row',
        width: 120,
        height: 36,
        children: [
          {
            type: 'split',
            dir: 'row',
            width: 80,
            height: 36,
            children: [
              { type: 'pane', paneId: '%1', width: 39, height: 36 },
              { type: 'pane', paneId: '%2', width: 40, height: 36 },
            ],
          },
          { type: 'pane', paneId: '%3', width: 39, height: 36 },
        ],
      },
    });
    socket.sent.length = 0;
    const outerDivider = f.host.querySelector('.seam-divider[data-left-pane="%2"][data-right-pane="%3"]');
    expect(outerDivider).not.toBeNull();
    outerDivider.dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 500, bubbles: true }));
    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 580, bubbles: true }));
    // delta = +10 cols -> targetPaneUnits = leaf width (40) + 10 = 50, NOT composite width (80) + 10 = 90
    expect(socket.sent.filter((m) => m.type === 'resize-pane-size')).toEqual([
      { type: 'resize-pane-size', paneId: '%2', cols: 50 },
    ]);

    session.dispose();
    f.close();
  });

  it('accounts for pane padding, tmux dividers, and pane-border-status rows in _measureWindowGrid and branch flex', async () => {
    const f = fixture();
    const dims = { w: 227 * 8 + 50, h: 86 * 18 + 77 }; // 227 cols * 8px + 50px chrome; 86 rows * 18px + 77px chrome
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    Object.defineProperties(session.treeHost, {
      clientWidth: { configurable: true, get: () => dims.w },
      clientHeight: { configurable: true, get: () => dims.h },
    });
    await session.ready;
    const socket = f.sockets[0];
    socket.readyState = 1;
    socket.onopen?.();
    socket.onmessage({ data: JSON.stringify({
      type: 'ready',
      protocol: 1,
      instanceId: '42:123',
      sessionId: '$1',
      windowId: '@1',
      windowCols: 229,
      windowRows: 88,
      zoomed: false,
      sizeLease: 'owner',
      inputAllowed: true,
      foreignClient: false,
    }) });

    const panes = [
      { id: '%14', index: 0, active: false, width: 100, height: 87, command: 'fish' },
      { id: '%15', index: 1, active: true, width: 128, height: 46, command: 'lazygit' },
      { id: '%16', index: 2, active: false, width: 55, height: 40, command: 'fish' },
      { id: '%17', index: 3, active: false, width: 72, height: 40, command: 'fish' },
    ];
    const tree = {
      type: 'split',
      dir: 'row',
      width: 229,
      height: 88,
      children: [
        { type: 'pane', paneId: '%14', width: 100, height: 88 },
        {
          type: 'split',
          dir: 'col',
          width: 128,
          height: 88,
          children: [
            { type: 'pane', paneId: '%15', width: 128, height: 47 },
            {
              type: 'split',
              dir: 'row',
              width: 128,
              height: 40,
              children: [
                { type: 'pane', paneId: '%16', width: 55, height: 40 },
                { type: 'pane', paneId: '%17', width: 72, height: 40 },
              ],
            },
          ],
        },
      ],
    };
    sendLayout(socket, { windowCols: 229, windowRows: 88, activePaneId: '%15', panes, tree });
    for (const p of panes) {
      socket.onmessage({ data: encodeSnapshotBinary({ paneId: p.id, seq: 0, cols: p.width, rows: p.height, text: p.id }) });
    }

    // Branch flex uses content rows + fixed chrome basis (46 vs 40, never 47 vs 40)
    const rightColBranches = f.host.querySelectorAll('.seam-split.is-col > .seam-branch');
    expect(rightColBranches).toHaveLength(2);
    expect(rightColBranches[0].style.flex).toBe('46 1 38px');
    expect(rightColBranches[1].style.flex).toBe('40 1 38px');

    // Exact 1:1 grid measurement: 229x88 converges with zero extra clipped cols or blank bottom rows
    expect(session._measureWindowGrid()).toEqual({ cols: 229, rows: 88 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);

    // Zoomed pane with pane-border-status top (87 content rows inside 88 window rows) also compensates cleanly
    dims.w = 229 * 8 + 16;
    dims.h = 87 * 18 + 38;
    sendLayout(socket, {
      windowCols: 229,
      windowRows: 88,
      zoomed: true,
      activePaneId: '%15',
      panes: panes.map((p) => (p.id === '%15' ? { ...p, width: 229, height: 87 } : p)),
      tree,
    });
    expect(session._measureWindowGrid()).toEqual({ cols: 229, rows: 88 });

    session.dispose();
    f.close();
  });

  it('supports 3-way T-junction 2D dragging without firing parent divider 1D drag', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    const panes = [
      { id: '%14', index: 0, active: false, width: 100, height: 87, command: 'fish' },
      { id: '%15', index: 1, active: true, width: 128, height: 46, command: 'lazygit' },
      { id: '%16', index: 2, active: false, width: 55, height: 40, command: 'fish' },
      { id: '%17', index: 3, active: false, width: 72, height: 40, command: 'fish' },
    ];
    const tree = {
      type: 'split', dir: 'row', width: 229, height: 88, x: 0, y: 0,
      children: [
        { type: 'pane', paneId: '%14', width: 100, height: 88, x: 0, y: 0 },
        {
          type: 'split', dir: 'col', width: 128, height: 88, x: 101, y: 0,
          children: [
            { type: 'pane', paneId: '%15', width: 128, height: 47, x: 101, y: 0 },
            {
              type: 'split', dir: 'row', width: 128, height: 40, x: 101, y: 48,
              children: [
                { type: 'pane', paneId: '%16', width: 55, height: 40, x: 101, y: 48 },
                { type: 'pane', paneId: '%17', width: 72, height: 40, x: 157, y: 48 },
              ],
            },
          ],
        },
      ],
    };
    sendLayout(socket, { windowCols: 229, windowRows: 88, activePaneId: '%15', panes, tree });

    const junctions = [...f.host.querySelectorAll('.seam-junction')];
    expect(junctions).toHaveLength(2);
    expect(junctions.every((el) => el.dataset.junctionKind === 't')).toBe(true);

    // Outer T-junction at (x=100, y=47) between %14 (left) and %15 / [%16,%17] (right)
    const outerT = junctions.find((el) => el.dataset.junctionX === '100' && el.dataset.junctionY === '47');
    expect(outerT).toBeTruthy();

    // Hovering lights up BOTH intersecting dividers
    outerT.dispatchEvent(new f.win.MouseEvent('pointerenter', { bubbles: false }));
    expect(f.host.querySelectorAll('.seam-divider.is-junction-hover')).toHaveLength(2);

    // Drag +10 cols (+80px) and -4 rows (-72px) simultaneously
    socket.sent.length = 0;
    outerT.dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 500, clientY: 500, bubbles: true }));
    expect(session.stage.classList.contains('is-dragging-xy')).toBe(true);
    f.win.dispatchEvent(new f.win.MouseEvent('pointermove', { clientX: 580, clientY: 428, bubbles: true }));
    expect(socket.sent.filter((m) => m.type === 'resize-pane-size' || m.type === 'resize-pane-batch')).toHaveLength(0);

    const outerRowBranches = f.host.querySelectorAll('.seam-tree-host > .seam-split.is-row > .seam-branch');
    const rightColBranches = f.host.querySelectorAll('.seam-split.is-col > .seam-branch');
    expect(outerRowBranches[0].style.flex).toBe('110 1 16px');
    expect(outerRowBranches[1].style.flex).toBe('117 1 33px');
    expect(rightColBranches[0].style.flex).toBe('42 1 38px');
    expect(rightColBranches[1].style.flex).toBe('44 1 38px');

    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 580, clientY: 428, bubbles: true }));
    expect(session.stage.classList.contains('is-dragging-xy')).toBe(false);
    // Exactly ONE atomic batch resize; parent 1D divider resize must NOT fire
    expect(socket.sent.filter((m) => m.type === 'resize-pane-size')).toHaveLength(0);
    expect(socket.sent.filter((m) => m.type === 'resize-pane-batch')).toEqual([
      {
        type: 'resize-pane-batch',
        resizes: [
          { paneId: '%14', cols: 110 },
          { paneId: '%15', rows: 42 },
        ],
      },
    ]);

    session.dispose();
    f.close();
  });

  it('supports 4-way +-junction 2D dragging for both col[row,row] and row[col,col] 2x2 grids', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    // Case 1: col[row(%1,%2), row(%3,%4)]
    const panes = [
      { id: '%1', index: 0, active: true, width: 60, height: 18, command: 'fish' },
      { id: '%2', index: 1, active: false, width: 59, height: 18, command: 'fish' },
      { id: '%3', index: 2, active: false, width: 60, height: 17, command: 'fish' },
      { id: '%4', index: 3, active: false, width: 59, height: 17, command: 'fish' },
    ];
    sendLayout(socket, {
      windowCols: 120,
      windowRows: 36,
      activePaneId: '%1',
      panes,
      tree: {
        type: 'split', dir: 'col', width: 120, height: 36, x: 0, y: 0,
        children: [
          {
            type: 'split', dir: 'row', width: 120, height: 18, x: 0, y: 0,
            children: [
              { type: 'pane', paneId: '%1', width: 60, height: 18, x: 0, y: 0 },
              { type: 'pane', paneId: '%2', width: 59, height: 18, x: 61, y: 0 },
            ],
          },
          {
            type: 'split', dir: 'row', width: 120, height: 17, x: 0, y: 19,
            children: [
              { type: 'pane', paneId: '%3', width: 60, height: 17, x: 0, y: 19 },
              { type: 'pane', paneId: '%4', width: 59, height: 17, x: 61, y: 19 },
            ],
          },
        ],
      },
    });

    const cross1 = f.host.querySelectorAll('.seam-junction');
    expect(cross1).toHaveLength(1);
    expect(cross1[0].dataset.junctionKind).toBe('cross');

    socket.sent.length = 0;
    cross1[0].dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300, bubbles: true }));
    f.win.dispatchEvent(new f.win.MouseEvent('pointermove', { clientX: 440, clientY: 336, bubbles: true })); // +5 cols, +2 rows
    const rowSplits1 = f.host.querySelectorAll('.seam-split.is-row');
    expect(rowSplits1[0].children[0].style.flex).toBe('65 1 16px');
    expect(rowSplits1[1].children[0].style.flex).toBe('65 1 16px');
    const colBranches1 = f.host.querySelectorAll('.seam-tree-host > .seam-split.is-col > .seam-branch');
    expect(colBranches1[0].style.flex).toBe('20 1 38px');
    expect(colBranches1[1].style.flex).toBe('15 1 38px');

    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 440, clientY: 336, bubbles: true }));
    expect(socket.sent.filter((m) => m.type === 'resize-pane-batch')).toEqual([
      {
        type: 'resize-pane-batch',
        resizes: [
          { paneId: '%1', cols: 65 },
          { paneId: '%3', cols: 65 },
          { paneId: '%2', rows: 20 },
        ],
      },
    ]);

    // Case 2: row[col(%1,%3), col(%2,%4)]
    sendLayout(socket, {
      windowCols: 120,
      windowRows: 36,
      activePaneId: '%1',
      panes,
      tree: {
        type: 'split', dir: 'row', width: 120, height: 36, x: 0, y: 0,
        children: [
          {
            type: 'split', dir: 'col', width: 60, height: 36, x: 0, y: 0,
            children: [
              { type: 'pane', paneId: '%1', width: 60, height: 18, x: 0, y: 0 },
              { type: 'pane', paneId: '%3', width: 60, height: 17, x: 0, y: 19 },
            ],
          },
          {
            type: 'split', dir: 'col', width: 59, height: 36, x: 61, y: 0,
            children: [
              { type: 'pane', paneId: '%2', width: 59, height: 18, x: 61, y: 0 },
              { type: 'pane', paneId: '%4', width: 59, height: 17, x: 61, y: 19 },
            ],
          },
        ],
      },
    });

    const cross2 = f.host.querySelectorAll('.seam-junction');
    expect(cross2).toHaveLength(1);
    expect(cross2[0].dataset.junctionKind).toBe('cross');

    socket.sent.length = 0;
    cross2[0].dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300, bubbles: true }));
    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 360, clientY: 264, bubbles: true })); // -5 cols, -2 rows
    expect(socket.sent.filter((m) => m.type === 'resize-pane-batch')).toEqual([
      {
        type: 'resize-pane-batch',
        resizes: [
          { paneId: '%3', cols: 55 },
          { paneId: '%1', rows: 16 },
          { paneId: '%2', rows: 16 },
        ],
      },
    ]);

    session.dispose();
    f.close();
  });

  it('marks the session exited with window_closed instead of detached when window-exit arrives', async () => {
    const f = fixture();
    const states = [];
    const session = new SeamWindowSession(f.win, {
      container: f.host,
      target,
      onState: (state) => states.push(state),
    });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    socket.onmessage({ data: JSON.stringify({ type: 'window-exit', windowId: '@1', reason: 'window_closed' }) });
    expect(session.status).toBe('exited');
    expect(session.reason).toBe('window_closed');
    expect(states.at(-1)).toMatchObject({
      status: 'exited',
      reason: 'window_closed',
      message: '窗口已关闭',
    });

    session.dispose();
    f.close();
  });

  it('exposes 更多历史, 重置窗格, and 4-mode 打开 Git 预览 submenu in rail and body context menus plus requestResync', async () => {
    const f = fixture();
    const actions = [];
    const menus = [];
    f.win.ContextMenu = { open: (spec) => menus.push(spec), installLongPress: () => () => {} };
    const session = new SeamWindowSession(f.win, {
      container: f.host,
      target,
      onAction: (action, detail) => actions.push({ action, detail }),
    });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    const rail = f.host.querySelector('.seam-pane[data-pane-id="%1"] .seam-rail');
    rail.dispatchEvent(new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    const railMenu = menus.at(-1);
    expect(railMenu.items.find((i) => i.id === 'history')?.label).toBe('更多历史');
    expect(railMenu.items.find((i) => i.id === 'respawn')).toMatchObject({ label: '重置窗格', danger: true });
    const railGit = railMenu.items.find((i) => i.id === 'open-git-preview');
    expect(railGit.children.map((c) => c.label)).toEqual(['侧边栏', '覆盖当前窗格', '向下分窗展示', '向右分窗展示']);
    railGit.children[2].action();
    railMenu.items.find((i) => i.id === 'respawn').action();
    expect(actions).toEqual([
      { action: 'open-git-preview', detail: { paneId: '%1', mode: 'split-down' } },
      { action: 'respawn-pane', detail: { paneId: '%1' } },
    ]);

    const body = f.host.querySelector('.seam-pane[data-pane-id="%1"] .pane-body');
    body.dispatchEvent(new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    const bodyMenu = menus.at(-1);
    expect(bodyMenu.items.find((i) => i.id === 'history')?.label).toBe('更多历史');
    expect(bodyMenu.items.find((i) => i.id === 'respawn')).toMatchObject({ label: '重置窗格', danger: true });
    expect(bodyMenu.items.find((i) => i.id === 'open-git-preview')?.children?.map((c) => c.id)).toEqual([
      'git-preview-sidebar',
      'git-preview-replace',
      'git-preview-down',
      'git-preview-right',
    ]);

    socket.sent.length = 0;
    expect(session.requestResync('%1', true)).toBe(true);
    expect(socket.sent).toEqual([{ type: 'resync', paneId: '%1', forceSnapshot: true }]);

    session.dispose();
    f.close();
  });

  it('defaults mobile multi-pane windows to single-pane focus switcher with split toggle, rail menu button, touch scroll, and scroll-to-bottom pill', async () => {
    const f = fixture();
    f.win.MobileUI = { isMobile: () => true };
    const menus = [];
    f.win.ContextMenu = { open: (spec) => menus.push(spec), installLongPress: () => () => {} };

    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    // Multi-pane on mobile shows 1 focused pane + mobile pane switcher tabs
    expect(session.mobilePaneBar.hidden).toBe(false);
    expect(f.host.querySelectorAll('.seam-mobile-pane-tab')).toHaveLength(2);
    expect(f.host.querySelectorAll('.seam-pane')).toHaveLength(1);
    expect(f.host.querySelector('.seam-pane').dataset.paneId).toBe('%1');

    // Switch active pane via mobile tab bar
    f.host.querySelectorAll('.seam-mobile-pane-tab')[1].click();
    expect(session.activePaneId).toBe('%2');
    expect(f.host.querySelector('.seam-pane').dataset.paneId).toBe('%2');

    // Toggle split view on mobile -> shows both panes side by side
    f.host.querySelector('.seam-mobile-split-toggle').click();
    expect(f.host.querySelector('.seam-mobile-split-toggle').textContent).toBe('单窗');
    expect(f.host.querySelectorAll('.seam-pane')).toHaveLength(2);
    f.host.querySelector('.seam-mobile-split-toggle').click();
    expect(f.host.querySelectorAll('.seam-pane')).toHaveLength(1);

    // Clicking visible rail menu button opens pane-rail ContextMenu items anchored to button
    const menuBtn = f.host.querySelector('[data-pane-action="menu"]');
    menuBtn.click();
    expect(menus.at(-1).anchor).toBe(menuBtn);
    expect(menus.at(-1).items.some((i) => i.id === 'open-git-preview')).toBe(true);
    expect(menus.at(-1).items.some((i) => i.id === 'respawn')).toBe(true);

    // Touch swipe scrolls normal scrollback via term.scrollLines and toggles ↓ 底部 pill
    const term2 = f.terminals[1];
    const body2 = f.host.querySelector('.seam-pane[data-pane-id="%2"] .pane-body');
    const dispatchTouch = (type, x, y) => {
      const ev = new f.win.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'touches', { value: [{ clientX: x, clientY: y }] });
      body2.dispatchEvent(ev);
    };
    dispatchTouch('touchstart', 100, 300);
    dispatchTouch('touchmove', 100, 240); // swipe up -> +60px -> scrollLines(+3)
    dispatchTouch('touchend', 100, 240);
    expect(term2.scrolledLines.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);

    // Scrolled up normal buffer exposes ↓ 底部 pill which returns to bottom on click
    term2.buffer.active.baseY = 50;
    term2.buffer.active.viewportY = 20;
    term2.listeners.scroll?.();
    const bottomBtn = f.host.querySelector('.seam-pane[data-pane-id="%2"] .wb-scroll-bottom');
    expect(bottomBtn.hidden).toBe(false);
    bottomBtn.click();
    expect(term2.scrolledToBottom).toBe(1);
    expect(bottomBtn.hidden).toBe(true);

    // Mouse-tracking TUI apps receive SGR wheel sequences on touch swipe
    socket.sent.length = 0;
    term2.modes.mouseTrackingMode = 'sgr';
    dispatchTouch('touchstart', 100, 200);
    dispatchTouch('touchmove', 100, 254); // swipe down -> wheel up \x1b[<64;...M
    dispatchTouch('touchend', 100, 254);
    expect(socket.sent.some((m) => m.type === 'input' && m.paneId === '%2' && m.data.includes('\x1b[<64;'))).toBe(true);

    session.dispose();
    f.close();
  });

  it('cancels stale resize timers across ready-before-layout updates and prevents mobile single-pane resize loops', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.win.MobileUI = { isMobile: () => true };
    const dims = { w: 390, h: 621 };
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    Object.defineProperties(session.treeHost, {
      clientWidth: { configurable: true, get: () => dims.w },
      clientHeight: { configurable: true, get: () => dims.h },
    });
    await session.ready;

    const socket = f.sockets[0];
    socket.readyState = 1;
    socket.onopen?.();
    // Initial uneven 2-pane horizontal split (202x90, pane-border-status top => layout height 90, content 89)
    const initialPanes = [
      { id: '%1', index: 0, active: false, width: 96, height: 89, command: 'fish' },
      { id: '%2', index: 1, active: true, width: 105, height: 89, command: 'bash' },
    ];
    const initialTree = {
      type: 'split', dir: 'row', width: 202, height: 90,
      children: [
        { type: 'pane', paneId: '%1', width: 96, height: 90 },
        { type: 'pane', paneId: '%2', width: 105, height: 90 },
      ],
    };
    socket.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 202, windowRows: 90, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });
    sendLayout(socket, { windowCols: 202, windowRows: 90, activePaneId: '%2', panes: initialPanes, tree: initialTree });
    for (const t of f.terminals) {
      t._core._renderService.dimensions.css.cell = { width: 7.66, height: 17 };
    }
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 0, cols: 96, rows: 89, text: 'p1' }) });
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%2', seq: 0, cols: 105, rows: 89, text: 'p2' }) });

    // Wait 80ms -> computes fixed-overhead mobile target (targetCols=48, share=105/201 -> 93x34)
    socket.sent.length = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toEqual([
      { type: 'resize-window', cols: 93, rows: 34 },
    ]);

    // Case A: ready(88x34) arrives BEFORE layout(88x34, %2=48x33).
    // Even if delayed >80ms or immediately followed by layout, no bogus resize against stale %2=105x89 is scheduled/fired.
    socket.sent.length = 0;
    socket.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 88, windowRows: 34, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);

    // Matching layout confirms %2 is already exact (48x33) -> zero further resizes
    sendLayout(socket, {
      windowCols: 88, windowRows: 34, activePaneId: '%2',
      panes: [
        { id: '%1', index: 0, active: false, width: 39, height: 33, command: 'fish' },
        { id: '%2', index: 1, active: true, width: 48, height: 33, command: 'bash' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 88, height: 34,
        children: [
          { type: 'pane', paneId: '%1', width: 39, height: 34 },
          { type: 'pane', paneId: '%2', width: 48, height: 34 },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);

    // Case B: If a resize timer IS armed and a subsequent fit() converges (cols === windowCols && rows === windowRows), cancel timer
    sendLayout(socket, {
      windowCols: 92, windowRows: 34, activePaneId: '%2',
      panes: [
        { id: '%1', index: 0, active: false, width: 41, height: 33, command: 'fish' },
        { id: '%2', index: 1, active: true, width: 50, height: 33, command: 'bash' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 92, height: 34,
        children: [
          { type: 'pane', paneId: '%1', width: 41, height: 34 },
          { type: 'pane', paneId: '%2', width: 50, height: 34 },
        ],
      },
    });
    expect(session.resizeTimer).not.toBeNull();
    // Before 80ms elapses, tmux settles at 88x34 (%2=48x33) -> must cancel the pending resizeTimer
    socket.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 88, windowRows: 34, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });
    sendLayout(socket, {
      windowCols: 88, windowRows: 34, activePaneId: '%2',
      panes: [
        { id: '%1', index: 0, active: false, width: 39, height: 33, command: 'fish' },
        { id: '%2', index: 1, active: true, width: 48, height: 33, command: 'bash' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 88, height: 34,
        children: [
          { type: 'pane', paneId: '%1', width: 39, height: 34 },
          { type: 'pane', paneId: '%2', width: 48, height: 34 },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);

    // Case C: Cycle guard prevents A -> B -> A oscillation even on adversarial rounding, while pane switch unlocks fresh resize
    socket.sent.length = 0;
    // Switch active pane to %1 (smaller share 39 vs 48) -> triggers fresh resize for %1
    f.host.querySelectorAll('.seam-mobile-pane-tab')[0].click();
    await vi.advanceTimersByTimeAsync(100);
    const afterSwitchResizes = socket.sent.filter((m) => m.type === 'resize-window');
    expect(afterSwitchResizes).toHaveLength(1);
    const req1 = afterSwitchResizes[0];
    // Feed back a layout where tmux rounds back & forth; max 3 unique requests per envelope, never repeating req1
    for (let step = 0; step < 6; step++) {
      const cols = step % 2 === 0 ? 102 : req1.cols - 4;
      sendLayout(socket, {
        windowCols: cols, windowRows: 34, activePaneId: '%1',
        panes: [
          { id: '%1', index: 0, active: true, width: Math.floor(cols * 0.44), height: 33, command: 'fish' },
          { id: '%2', index: 1, active: false, width: cols - 1 - Math.floor(cols * 0.44), height: 33, command: 'bash' },
        ],
        tree: {
          type: 'split', dir: 'row', width: cols, height: 34,
          children: [
            { type: 'pane', paneId: '%1', width: Math.floor(cols * 0.44), height: 34 },
            { type: 'pane', paneId: '%2', width: cols - 1 - Math.floor(cols * 0.44), height: 34 },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(100);
    }
    const cycleResizes = socket.sent.filter((m) => m.type === 'resize-window').map((m) => `${m.cols}:${m.rows}`);
    expect(cycleResizes.length).toBeLessThanOrEqual(3);
    expect(new Set(cycleResizes).size).toBe(cycleResizes.length);

    session.dispose();
    f.close();
  });

  it('renders Orca-style takeover overlay card & collapsible corner chip on observer lease and reclaims ownership', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket, { sizeLease: 'observer', foreignClient: false });
    socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1', windowCols: 48, windowRows: 33, zoomed: false, sizeLease: 'observer', inputAllowed: false, foreignClient: false }) });

    // Non-blocking centered floating overlay card
    expect(session.leaseBar.hidden).toBe(false);
    expect(session.leaseBar.classList.contains('is-overlay')).toBe(true);
    expect(session.leaseBar.classList.contains('is-driving')).toBe(true);
    expect(session.leaseBar.textContent).toContain('其他端正在控制此窗口');
    expect(f.terminals[0].options.disableStdin).toBe(true);
    expect(session.send('ls\r')).toBe(false);

    // Minimize into top-right corner chip, then expand back
    session.leaseBar.querySelector('.seam-takeover-min').click();
    expect(session.leaseBar.classList.contains('is-chip')).toBe(true);
    expect(session.leaseBar.textContent).toContain('其他端控制中');
    session.leaseBar.querySelector('.seam-chip-expand').click();
    expect(session.leaseBar.classList.contains('is-overlay')).toBe(true);

    // Click Take back -> sends takeover and enters pending state
    socket.sent.length = 0;
    const btn = session.leaseBar.querySelector('.seam-lease-btn');
    btn.click();
    expect(socket.sent.at(-1)).toEqual({ type: 'takeover' });
    expect(session.leaseBar.querySelector('.seam-lease-btn').disabled).toBe(true);
    expect(session.leaseBar.querySelector('.seam-lease-btn').textContent).toBe('正在接管…');

    // Ownership restored -> overlay hides, input enabled, collapsed state reset for future takeovers
    socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1', windowCols: 120, windowRows: 36, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false }) });
    expect(session.leaseBar.hidden).toBe(true);
    expect(session.send('pwd\r')).toBe(true);

    // Collapse then lose control again -> card re-surfaces expanded
    socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1', windowCols: 48, windowRows: 33, zoomed: false, sizeLease: 'observer', inputAllowed: false, foreignClient: false }) });
    session.leaseBar.querySelector('.seam-takeover-min').click();
    expect(session.leaseBar.classList.contains('is-chip')).toBe(true);
    socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1', windowCols: 120, windowRows: 36, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false }) });
    socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1', windowCols: 48, windowRows: 33, zoomed: false, sizeLease: 'observer', inputAllowed: false, foreignClient: false }) });
    expect(session.leaseBar.classList.contains('is-overlay')).toBe(true);

    session.dispose();
    f.close();
  });

  it('reconciles split/close DOM in place without detaching unchanged sibling panes and preserves reused dividers', async () => {
    const f = fixture();
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    const pane1 = f.host.querySelector('.seam-pane[data-pane-id="%1"]');
    const branch1 = pane1.closest('.seam-branch');
    let pane1Removals = 0;
    const observer = new f.win.MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node === pane1 || node === branch1 || node.contains?.(pane1)) pane1Removals++;
        }
      }
    });
    observer.observe(session.treeHost, { childList: true, subtree: true });

    const resetsBefore = f.terminals[0].resets;

    // 1. Split %2 vertically -> R(%1, C(%2, %3))
    sendLayout(socket, {
      windowCols: 120, windowRows: 36, activePaneId: '%3',
      panes: [
        { id: '%1', index: 0, active: false, width: 60, height: 36, command: 'claude' },
        { id: '%2', index: 1, active: false, width: 59, height: 18, command: 'bash' },
        { id: '%3', index: 2, active: true, width: 59, height: 17, command: 'zsh' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 120, height: 36,
        children: [
          { type: 'pane', paneId: '%1', width: 60, height: 36 },
          {
            type: 'split', dir: 'col', width: 59, height: 36,
            children: [
              { type: 'pane', paneId: '%2', width: 59, height: 18 },
              { type: 'pane', paneId: '%3', width: 59, height: 17 },
            ],
          },
        ],
      },
    });
    expect(pane1Removals).toBe(0);
    expect(f.host.querySelector('.seam-pane[data-pane-id="%1"]')).toBe(pane1);
    expect(pane1.closest('.seam-branch')).toBe(branch1);
    expect(f.terminals[0].resets).toBe(resetsBefore);

    const pane2 = f.host.querySelector('.seam-pane[data-pane-id="%2"]');
    const branch2 = pane2.closest('.seam-branch');
    let pane2Removals = 0;
    const observer2 = new f.win.MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node === pane2 || node === branch2 || node.contains?.(pane2)) pane2Removals++;
        }
      }
    });
    observer2.observe(session.treeHost, { childList: true, subtree: true });

    // 2. Split %3 horizontally -> R(%1, C(%2, R(%3, %4)))
    sendLayout(socket, {
      windowCols: 120, windowRows: 36, activePaneId: '%4',
      panes: [
        { id: '%1', index: 0, active: false, width: 60, height: 36, command: 'claude' },
        { id: '%2', index: 1, active: false, width: 59, height: 18, command: 'bash' },
        { id: '%3', index: 2, active: false, width: 29, height: 17, command: 'zsh' },
        { id: '%4', index: 3, active: true, width: 29, height: 17, command: 'fish' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 120, height: 36,
        children: [
          { type: 'pane', paneId: '%1', width: 60, height: 36 },
          {
            type: 'split', dir: 'col', width: 59, height: 36,
            children: [
              { type: 'pane', paneId: '%2', width: 59, height: 18 },
              {
                type: 'split', dir: 'row', width: 59, height: 17,
                children: [
                  { type: 'pane', paneId: '%3', width: 29, height: 17 },
                  { type: 'pane', paneId: '%4', width: 29, height: 17 },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(pane1Removals).toBe(0);
    expect(pane2Removals).toBe(0);
    expect(f.host.querySelector('.seam-pane[data-pane-id="%1"]')).toBe(pane1);
    expect(f.host.querySelector('.seam-pane[data-pane-id="%2"]')).toBe(pane2);

    // 3. Close %4 -> back to R(%1, C(%2, %3)), unchanged siblings remain undisturbed
    sendLayout(socket, {
      windowCols: 120, windowRows: 36, activePaneId: '%3',
      panes: [
        { id: '%1', index: 0, active: false, width: 60, height: 36, command: 'claude' },
        { id: '%2', index: 1, active: false, width: 59, height: 18, command: 'bash' },
        { id: '%3', index: 2, active: true, width: 59, height: 17, command: 'zsh' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 120, height: 36,
        children: [
          { type: 'pane', paneId: '%1', width: 60, height: 36 },
          {
            type: 'split', dir: 'col', width: 59, height: 36,
            children: [
              { type: 'pane', paneId: '%2', width: 59, height: 18 },
              { type: 'pane', paneId: '%3', width: 59, height: 17 },
            ],
          },
        ],
      },
    });
    expect(pane1Removals).toBe(0);
    expect(pane2Removals).toBe(0);

    // Reused outer divider still drags and sends accurate resize-pane-size against live branches/nodes
    socket.sent.length = 0;
    const outerDivider = f.host.querySelector('.seam-divider[data-left-pane="%1"]');
    expect(outerDivider).not.toBeNull();
    outerDivider.dispatchEvent(new f.win.MouseEvent('pointerdown', { button: 0, clientX: 400, bubbles: true }));
    f.win.dispatchEvent(new f.win.MouseEvent('pointerup', { button: 0, clientX: 440, bubbles: true }));
    expect(socket.sent.filter((m) => m.type === 'resize-pane-size')).toEqual([
      { type: 'resize-pane-size', paneId: '%1', cols: 65 },
    ]);

    // 4. Parallel middle insertion R(%1, %2) -> R(%1, %3, %2) keeps both %1 and %2 in place
    sendLayout(socket, {
      windowCols: 120, windowRows: 36, activePaneId: '%1',
      panes: [
        { id: '%1', index: 0, active: true, width: 60, height: 36, command: 'claude' },
        { id: '%2', index: 1, active: false, width: 59, height: 36, command: 'bash' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 120, height: 36,
        children: [
          { type: 'pane', paneId: '%1', width: 60, height: 36 },
          { type: 'pane', paneId: '%2', width: 59, height: 36 },
        ],
      },
    });
    pane1Removals = 0;
    pane2Removals = 0;
    sendLayout(socket, {
      windowCols: 120, windowRows: 36, activePaneId: '%1',
      panes: [
        { id: '%1', index: 0, active: true, width: 40, height: 36, command: 'claude' },
        { id: '%3', index: 1, active: false, width: 39, height: 36, command: 'zsh' },
        { id: '%2', index: 2, active: false, width: 39, height: 36, command: 'bash' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 120, height: 36,
        children: [
          { type: 'pane', paneId: '%1', width: 40, height: 36 },
          { type: 'pane', paneId: '%3', width: 39, height: 36 },
          { type: 'pane', paneId: '%2', width: 39, height: 36 },
        ],
      },
    });
    expect(pane1Removals).toBe(0);
    expect(pane2Removals).toBe(0);

    observer.disconnect();
    observer2.disconnect();
    session.dispose();
    f.close();
  });

  it('avoids gratuitous resize-window when splitting on a settled PC viewport unless text would clip or viewport resizes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    // Exact fit for 2-pane horizontal split (200x40 with pane-border-status top => layoutH = 40, contentH = 39)
    // w = 199*8 + 32 = 1624 -> netW = 16+16+(1-8) = 25 -> floor((1624-25)/8) = 199 cols (with border=0 -> 200 cols? Let's match exact px: 200*8 + 25 = 1625)
    // h = 39*18 + (28+10) = 740 -> netH = 38 - 18 = 20 -> floor((740-20)/18) = 40 rows
    const dims = { w: 200 * 8 + 25, h: 39 * 18 + 38 };
    const session = new SeamWindowSession(f.win, { container: f.host, target });
    Object.defineProperties(session.treeHost, {
      clientWidth: { configurable: true, get: () => dims.w },
      clientHeight: { configurable: true, get: () => dims.h },
    });
    await session.ready;
    const socket = f.sockets[0];
    socket.readyState = 1;
    socket.onopen?.();
    socket.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 200, windowRows: 40, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });
    sendLayout(socket, {
      windowCols: 200, windowRows: 40, activePaneId: '%2',
      panes: [
        { id: '%1', index: 0, active: false, width: 100, height: 39, command: 'fish' },
        { id: '%2', index: 1, active: true, width: 99, height: 39, command: 'bash' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 200, height: 40,
        children: [
          { type: 'pane', paneId: '%1', width: 100, height: 40 },
          { type: 'pane', paneId: '%2', width: 99, height: 40 },
        ],
      },
    });
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 0, cols: 100, rows: 39, text: 'p1' }) });
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%2', seq: 0, cols: 99, rows: 39, text: 'p2' }) });
    await vi.advanceTimersByTimeAsync(120);
    socket.sent.length = 0;

    // Split %2 vertically (R(%1, C(%2, %3))) with pane-border-status top -> idealRows drops 40->39 due to padding,
    // but compressible breathing padding (minNetHeightPx) still fits all 40 window rows cleanly -> NO resize-window!
    sendLayout(socket, {
      windowCols: 200, windowRows: 40, activePaneId: '%3',
      panes: [
        { id: '%1', index: 0, active: false, width: 100, height: 39, command: 'fish' },
        { id: '%2', index: 1, active: false, width: 99, height: 19, command: 'bash' },
        { id: '%3', index: 2, active: true, width: 99, height: 18, command: 'zsh' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 200, height: 40,
        children: [
          { type: 'pane', paneId: '%1', width: 100, height: 40 },
          {
            type: 'split', dir: 'col', width: 99, height: 40,
            children: [
              { type: 'pane', paneId: '%2', width: 99, height: 20 },
              { type: 'pane', paneId: '%3', width: 99, height: 19 },
            ],
          },
        ],
      },
    });
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%3', seq: 0, cols: 99, rows: 18, text: 'p3' }) });
    await vi.advanceTimersByTimeAsync(150);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);

    // Split %3 horizontally (R(%1, C(%2, R(%3, %4)))) -> idealCols drops 200->199 due to padding,
    // still fits minNetWidthPx cleanly -> STILL NO resize-window!
    sendLayout(socket, {
      windowCols: 200, windowRows: 40, activePaneId: '%4',
      panes: [
        { id: '%1', index: 0, active: false, width: 100, height: 39, command: 'fish' },
        { id: '%2', index: 1, active: false, width: 99, height: 19, command: 'bash' },
        { id: '%3', index: 2, active: false, width: 49, height: 18, command: 'zsh' },
        { id: '%4', index: 3, active: true, width: 49, height: 18, command: 'fish' },
      ],
      tree: {
        type: 'split', dir: 'row', width: 200, height: 40,
        children: [
          { type: 'pane', paneId: '%1', width: 100, height: 40 },
          {
            type: 'split', dir: 'col', width: 99, height: 40,
            children: [
              { type: 'pane', paneId: '%2', width: 99, height: 20 },
              {
                type: 'split', dir: 'row', width: 99, height: 19,
                children: [
                  { type: 'pane', paneId: '%3', width: 49, height: 19 },
                  { type: 'pane', paneId: '%4', width: 49, height: 19 },
                ],
              },
            ],
          },
        ],
      },
    });
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%4', seq: 0, cols: 49, rows: 18, text: 'p4' }) });
    await vi.advanceTimersByTimeAsync(150);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);

    // Actual browser viewport resize invalidates _settledViewportEnv -> resize-window IS sent
    dims.w = 180 * 8 + 34;
    session.fit();
    await vi.advanceTimersByTimeAsync(120);
    expect(socket.sent.filter((m) => m.type === 'resize-window')).toEqual([
      { type: 'resize-window', cols: 180, rows: 39 },
    ]);

    // Deep vertical stack with border=off exceeding minNetHeightPx -> resize-window IS sent to prevent clipping
    dims.w = 200 * 8 + 16;
    dims.h = 40 * 18 + 38;
    socket.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 200, windowRows: 40, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });
    sendLayout(socket, {
      windowCols: 200, windowRows: 40, activePaneId: '%1',
      panes: [{ id: '%1', index: 0, active: true, width: 200, height: 40, command: 'fish' }],
      tree: { type: 'pane', paneId: '%1', width: 200, height: 40 },
    });
    await vi.advanceTimersByTimeAsync(120);
    socket.sent.length = 0;

    // 4 stacked panes with border=off (layoutH === pane.height) -> minNetHeightPx adds 3*(32-17) = 45px+ > 1 row slack
    sendLayout(socket, {
      windowCols: 200, windowRows: 40, activePaneId: '%4',
      panes: [
        { id: '%1', index: 0, active: false, width: 200, height: 10, command: 'fish' },
        { id: '%2', index: 1, active: false, width: 200, height: 9, command: 'bash' },
        { id: '%3', index: 2, active: false, width: 200, height: 9, command: 'zsh' },
        { id: '%4', index: 3, active: true, width: 200, height: 9, command: 'sh' },
      ],
      tree: {
        type: 'split', dir: 'col', width: 200, height: 40,
        children: [
          { type: 'pane', paneId: '%1', width: 200, height: 10 },
          { type: 'pane', paneId: '%2', width: 200, height: 9 },
          { type: 'pane', paneId: '%3', width: 200, height: 9 },
          { type: 'pane', paneId: '%4', width: 200, height: 9 },
        ],
      },
    });
    for (const id of ['%2', '%3', '%4']) {
      socket.onmessage({ data: encodeSnapshotBinary({ paneId: id, seq: 0, cols: 200, rows: 9, text: id }) });
    }
    await vi.advanceTimersByTimeAsync(120);
    const clipResizes = socket.sent.filter((m) => m.type === 'resize-window');
    expect(clipResizes).toHaveLength(1);
    expect(clipResizes[0].rows).toBeLessThan(40);

    session.dispose();
    f.close();
  });

  it('places DEC 2026 sync update after RIS, skips term.reset() for RIS, skips initial refresh SIGWINCH within padding tolerance, and binds allowTransparency to non-zero transparency', async () => {
    const f = fixture();
    let transparency = 0;
    f.win.Theme.getTransparency = () => transparency;
    const session = new SeamWindowSession(f.win, { container: f.host, target: { ...target } });
    await session.ready;
    const socket = f.sockets[0];
    hydrateWindow(socket);

    expect(f.terminals[0].options.allowTransparency).toBe(false);
    const resetsBefore = f.terminals[0].resets;
    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 1, cols: 60, rows: 36, historyLines: 20, historyTotal: 90, text: '\x1bcUPDATED' }) });
    expect(f.terminals[0].resets).toBe(resetsBefore);
    expect(session.panes.get('%1').historyLines).toBe(20);
    expect(session.panes.get('%1').historyTotal).toBe(90);
    const risWrite = new TextDecoder().decode(f.terminals[0].writes.at(-1));
    expect(risWrite).toBe('\x1bc\x1b[?2026hUPDATED\x1b[?2026l');

    socket.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 2, cols: 60, rows: 36, text: 'PLAIN' }) });
    expect(f.terminals[0].resets).toBe(resetsBefore + 1);
    const plainWrite = new TextDecoder().decode(f.terminals[0].writes.at(-1));
    expect(plainWrite).toBe('PLAIN');

    transparency = 0.25;
    f.win.document.dispatchEvent(new f.win.Event('tmux-theme-change'));
    expect(f.terminals[0].options.allowTransparency).toBe(true);
    session.dispose();
    f.close();

    // Fresh page load / refresh where windowCols=200 fits [idealCols(199) - 2, maxCols(200)]: ZERO resize-window sent!
    vi.useFakeTimers();
    const fRefresh = fixture();
    Object.defineProperties(fRefresh.host, { clientWidth: { configurable: true, value: 200 * 8 + 10 }, clientHeight: { configurable: true, value: 40 * 18 + 38 } });
    const sRefresh = new SeamWindowSession(fRefresh.win, { container: fRefresh.host, target: { ...target } });
    await sRefresh.ready;
    const sockRefresh = fRefresh.sockets[0];
    sockRefresh.readyState = 1;
    sockRefresh.onopen?.();
    sockRefresh.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 200, windowRows: 40, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });
    sendLayout(sockRefresh, {
      windowCols: 200, windowRows: 40, activePaneId: '%1',
      panes: [
        { id: '%1', index: 0, active: true, width: 100, height: 39, command: 'agy' },
        { id: '%2', index: 1, active: false, width: 99, height: 39, command: 'zsh' },
      ],
      tree: { type: 'split', dir: 'row', width: 200, height: 40, children: [{ type: 'pane', paneId: '%1', width: 100, height: 40 }, { type: 'pane', paneId: '%2', width: 99, height: 40 }] },
    });
    sockRefresh.onmessage({ data: encodeSnapshotBinary({ paneId: '%1', seq: 0, cols: 100, rows: 39, text: '\x1bcA' }) });
    sockRefresh.onmessage({ data: encodeSnapshotBinary({ paneId: '%2', seq: 0, cols: 99, rows: 39, text: '\x1bcB' }) });
    await vi.advanceTimersByTimeAsync(150);
    expect(sockRefresh.sent.filter((m) => m.type === 'resize-window')).toHaveLength(0);
    sRefresh.dispose();
    fRefresh.close();
    vi.useRealTimers();

    const f2 = fixture();
    f2.win.Theme.getTransparency = () => 0.3;
    const s2 = new SeamWindowSession(f2.win, { container: f2.host, target: { ...target } });
    await s2.ready;
    hydrateWindow(f2.sockets[0]);
    expect(f2.terminals[0].options.allowTransparency).toBe(true);
    s2.dispose();
    f2.close();
  });

  it('syncs Orca AgentIcons, live agent status indicator, and stripped titles onto pane top bars', async () => {
    const f = fixture({ runScripts: true });
    f.win.eval(readFileSync('plugins/ui/client/js/agent-icons-data.js', 'utf8'));
    f.win.eval(readFileSync('plugins/ui/client/js/agent-status.js', 'utf8'));

    const session = new SeamWindowSession(f.win, { container: f.host, target: { ...target } });
    await session.ready;
    const socket = f.sockets[0];
    socket.readyState = 1;
    socket.onopen?.();
    socket.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 120, windowRows: 36, zoomed: false, sizeLease: 'owner', inputAllowed: true,
    }) });
    sendLayout(socket, {
      panes: [
        { id: '%1', index: 0, active: true, width: 60, height: 36, cwd: '/srv/repo', command: 'node', title: '⠐ 🐋 解释 MAS 的 HWID' },
        { id: '%2', index: 1, active: false, width: 59, height: 36, cwd: '/srv/repo', command: 'agy', label: '自更新', title: 'agy ~/srv/repo' },
      ],
    });

    const pane1 = f.host.querySelector('.seam-pane[data-pane-id="%1"]');
    const pane2 = f.host.querySelector('.seam-pane[data-pane-id="%2"]');
    expect(pane2.querySelector('.pane-proc-ico .agent-app-icon.is-kind-antigravity img.agent-app-img')).not.toBeNull();
    expect(pane2.querySelector('.pane-title').textContent).toBe('自更新');
    expect(pane2.querySelector('.pane-agent-state').hidden).toBe(true);

    // Inject backend snapshot classifying %1 as dsh (working)
    f.win.AgentStatus.setSnapshot('dev', {
      hasAgents: true,
      panes: {
        '%1': { paneId: '%1', agentType: 'dsh', appKind: 'dsh', status: 'working', unread: false },
      },
      windows: {},
      sessions: {},
    });

    expect(pane1.querySelector('.pane-proc-ico .agent-app-icon.is-kind-dsh img.agent-app-img')).not.toBeNull();
    expect(pane1.querySelector('.pane-agent-state').hidden).toBe(false);
    expect(pane1.querySelector('.pane-agent-state .agent-state-ico.is-working')).not.toBeNull();
    expect(pane1.querySelector('.pane-title').textContent).toBe('🐋 解释 MAS 的 HWID');
    expect(pane1.querySelector('.pane-cmd-chip').textContent).toBe('DeepSeek Harness');

    session.dispose();
    f.close();
  });
});
