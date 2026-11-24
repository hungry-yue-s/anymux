import { afterEach, describe, expect, it, vi } from 'vitest';
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
  view.setUint32(13, historyTotal, false);
  view.setUint32(17, historyLines, false);
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

export function fixture() {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://panel.test' });
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
      this.buffer = { active: { viewportY: 0, getLine: () => null } };
      terminals.push(this);
    }
    open(host) {
      this.element = win.document.createElement('div');
      this.element.className = 'xterm';
      this.textarea = win.document.createElement('textarea');
      this.textarea.className = 'xterm-helper-textarea';
      this.element.append(this.textarea);
      host.append(this.element);
    }
    loadAddon() {}
    onData(fn) { this.listeners.data = fn; return { dispose() {} }; }
    onBinary(fn) { this.listeners.binary = fn; return { dispose() {} }; }
    onTitleChange(fn) { this.listeners.title = fn; return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
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
});
