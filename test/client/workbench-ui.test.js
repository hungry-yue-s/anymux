import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createWorkbench } from '../../plugins/workbench/client/index.js';

const remote = { instanceId: '42:123', sessionId: '$1', windowId: '@1', paneId: '%1' };
function fixture({ copiedTab, legacyTab, locks } = {}) {
  const dom = new JSDOM('<main id="host"></main><nav class="mobile-dock"></nav>', { url: 'https://panel.test' });
  const win = dom.window; const sessions = [];
  if (copiedTab) win.sessionStorage.setItem(legacyTab ? 'twp_native_tab' : 'anymux_native_tab', copiedTab);
  if (locks) Object.defineProperty(win.navigator, 'locks', { value: locks });
  win.Api = { nodeUrl: (server, path) => '/n/' + server + path, workspaceUrl: (server, path) => '/n/' + server + '/api/workspace' + path,
    get: vi.fn(async () => ({ available: true, protocol: 1 })), post: vi.fn(async (_url, body) => ({ ...remote, requestId: body.requestId })), del: vi.fn() };
  win.Router = { go: vi.fn() }; win.MobileUI = { isMobile: () => false };
  class Session {
    constructor(global, options) {
      this.options = options; this.target = options.target; this.status = 'live';
      this.context = { ...options.target, paneId: '%1' };
      this.term = { options: { fontSize: 14 }, textarea: global.document.createElement('textarea'), getSelection: () => '' };
      this.term.textarea.className = 'xterm-helper-textarea'; options.container.append(this.term.textarea);
      this.ready = Promise.resolve(); sessions.push(this);
    }
    requestContext() { return Promise.resolve(this.context); }
    requestResync = vi.fn(() => true);
    getPaneMeta = vi.fn(() => ({ cwd: '/srv/repo' }));
    fit() {} setVisible() {} send = vi.fn(() => true); paste = vi.fn(() => true);
    focus() { this.term.textarea.focus(); } dispose() { this.disposed = true; } refresh() {} setFontSize() {} copy() {}
    invalidate() { this.status = 'invalid'; this.options.onState({ status: 'invalid' }); }
  }
  const api = createWorkbench(win, { storageScope: 'test', Session });
  return { win, api, sessions, host: win.document.getElementById('host'), close() { api.unmount(); win.close(); } };
}

describe('native workbench UI', () => {
  it.each([false, true])('can collapse the prominent pause card without reconnecting (mobile=%s)', async mobile => {
    const f = fixture(); f.win.MobileUI.isMobile = () => mobile;
    const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    const session = f.sessions[0]; session.refresh = vi.fn(); session.status = 'detached';
    session.options.onState({ status: 'detached', message: '会话已被其他端接管，画面已暂停更新。' });
    const notice = f.host.querySelector('.terminal-status-notice');
    expect(notice.querySelector('.terminal-status-card')).not.toBeNull();
    notice.querySelector('.terminal-status-secondary').click();
    expect(notice.classList.contains('is-collapsed')).toBe(true);
    expect(session.refresh).not.toHaveBeenCalled();
    notice.querySelector('.terminal-status-copy strong').click();
    expect(notice.classList.contains('is-collapsed')).toBe(false);
    notice.querySelector('.terminal-status-primary').click();
    expect(session.refresh).toHaveBeenCalledOnce(); f.close();
  });
  it('sends a pasted image to this window\'s machine and pastes into this session only', async () => {
    const f = fixture(); const cleanup = vi.fn();
    f.win.TerminalUpload = { install: vi.fn(() => cleanup) };
    const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const session = f.sessions[0];
    expect(f.win.TerminalUpload.install).toHaveBeenCalledOnce();
    const options = f.win.TerminalUpload.install.mock.calls[0][1];
    expect(options.serverId()).toBe('dev');
    expect(options.isCurrent()).toBe(true);
    expect(options.paste('C:/u/1_paste.png')).toBe(true);
    expect(session.paste).toHaveBeenCalledWith('C:/u/1_paste.png');
    f.win.PanelSlots = { hasPlugin: (id) => id !== 'upload' };
    expect(options.serverId()).toBeNull();
    f.api.unmount();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(options.isCurrent()).toBe(false);
    f.close();
  });
  it('offers a guarded reconnect action in the persistent detached notice', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const session = f.sessions[0]; session.refresh = vi.fn(); session.status = 'detached';
    session.options.onState({ status: 'detached', message: '会话已被其他端接管，画面已暂停更新。' });
    const notice = f.host.querySelector('.wb-window-message');
    expect(notice.hidden).toBe(false);
    const action = notice.querySelector('button'); expect(action).not.toBeNull();
    action.click(); expect(session.refresh).toHaveBeenCalledOnce();
    f.api.unmount(); action.click(); expect(session.refresh).toHaveBeenCalledOnce(); f.close();
  });
  it.each(['unavailable', 'rejected'])('keeps copied browser tabs on independent clients when Web Locks are %s', async mode => {
    const options = { copiedTab: 'copied-tab', ...(mode === 'rejected' ? { locks: { request: () => Promise.reject(new Error('unavailable')) } } : {}) };
    const first = fixture(options), second = fixture(options);
    for (const f of [first, second]) {
      const view = await f.api.create({ serverId: 'dev', ...remote, clientId: 'shared-client' });
      await f.api.render('dev', view.id, { container: f.host });
    }
    expect(first.sessions[0].target.clientId).not.toBe(second.sessions[0].target.clientId);
    first.close(); second.close();
  });

  it('keeps the id a tab saved before the rename, unless a tab still on the old code holds it', async () => {
    // Web Locks of one browser: names held by other tabs, and what this tab asks for.
    const browser = (held) => ({ requests: [], request(name, _options, callback) {
      this.requests.push(name);
      const lock = held.has(name) ? null : { name };
      if (callback(lock) && lock) held.add(name);
      return Promise.resolve();
    } });
    const tabId = async (f) => {
      const view = await f.api.create({ serverId: 'dev', ...remote, clientId: 'shared-client' });
      await f.api.render('dev', view.id, { container: f.host });
      return f.sessions[0].target.clientId;
    };

    const reloaded = fixture({ copiedTab: 'old-tab', legacyTab: true, locks: browser(new Set()) });
    expect(await tabId(reloaded)).toBe('shared-client-old-tab');
    expect(reloaded.win.navigator.locks.requests).toEqual(['twp_native_old-tab', 'anymux_native_old-tab']);
    expect(reloaded.win.sessionStorage.getItem('anymux_native_tab')).toBe('old-tab');
    expect(reloaded.win.sessionStorage.getItem('twp_native_tab')).toBeNull();
    reloaded.close();

    const copied = fixture({ copiedTab: 'old-tab', legacyTab: true, locks: browser(new Set(['twp_native_old-tab'])) });
    expect(await tabId(copied)).not.toBe('shared-client-old-tab');
    copied.close();
  });

  it('splits the freshly confirmed native window and never writes when focus is unknown', async () => {
    const f = fixture();
    const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    f.sessions[0].requestContext = async () => {
      f.sessions[0].context = { ...f.sessions[0].context, windowId: '@9', paneId: '%8' };
    };
    await f.api.split('horizontal');
    expect(f.win.Api.post).toHaveBeenLastCalledWith('/n/dev/api/workspace/windows/%409/panes', { paneId: '%8', direction: 'horizontal' });
    f.win.Api.post.mockClear();
    f.sessions[0].requestContext = async () => { throw new Error('native focus unknown'); };
    await expect(f.api.split('vertical')).rejects.toThrow('native focus unknown');
    expect(f.win.Api.post).not.toHaveBeenCalled(); f.close();
  });
  it('omits the disabled keypad and rejects its unavailable upload action', async () => {
    const f = fixture();
    f.win.PanelSlots = { hasPlugin: id => !['keypad', 'upload'].includes(id) };
    f.win.MobileUI.isMobile = () => true;
    f.win.FabDrawer = { mount: () => { throw new Error('disabled keypad must not mount'); } };
    const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.host.querySelector('.fab-tool')).toBeNull();
    expect(f.host.querySelector('.mobile-terminal-keyboard')).not.toBeNull();
    f.close();
  });
  it('does not request native APIs when that server disabled the native backend', async () => {
    const f = fixture(); f.win.PanelSlots = { hasPlugin: id => id !== 'control-terminal' };
    await expect(f.api.create({ serverId: 'dev', ...remote })).rejects.toThrow('原生终端插件');
    expect(f.win.Api.get).not.toHaveBeenCalled(); f.close();
  });
  it('opens any existing window without creating/moving panes and restores the same client on remount', async () => {
    const f = fixture();
    const view = await f.api.create({ serverId: 'dev', ...remote, title: '任务' });
    expect(f.win.Api.post).not.toHaveBeenCalled();
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.host.querySelectorAll('.wb-window-terminal')).toHaveLength(1);
    expect(f.host.querySelector('.wb-pane-header,.wb-separator,.wb-pane-tabs')).toBeNull();
    expect(f.api.currentContext().paneId).toBe('%1');
    const first = f.sessions[0]; const terminal = f.host.querySelector('.wb-window-terminal');
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.sessions).toHaveLength(1); expect(f.host.querySelector('.wb-window-terminal')).toBe(terminal);
    f.api.unmount(); expect(first.disposed).toBe(true);
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.sessions[1].target.clientId).toBe(first.target.clientId);
    f.api.closeView(view.id); expect(f.win.Api.del).not.toHaveBeenCalled(); f.close();
  });
  it('takes tool context only from confirmed native focus and keeps same metadata updates stable', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const old = f.api.currentContext();
    f.sessions[0].options.onState({ status: 'live' }); expect(f.api.currentContext().key).toBe(old.key);
    f.sessions[0].context = { ...f.sessions[0].target, paneId: '%2' };
    f.sessions[0].options.onContext(f.sessions[0].context);
    expect(f.api.currentContext().paneId).toBe('%2'); expect(f.api.currentContext().key).not.toBe(old.key);
    expect(old.source.paneId).toBe('%1');
    f.sessions[0].status = 'connecting'; f.sessions[0].options.onState({ status: 'connecting' });
    expect(f.api.currentContext().paneId).toBeNull(); f.close();
  });
  it('splits the actual remote pane and leaves layout/status rendering to tmux', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host }); await f.api.split('vertical');
    expect(f.win.Api.post).toHaveBeenLastCalledWith('/n/dev/api/workspace/windows/%401/panes', { paneId: '%1', direction: 'vertical' });
    expect(f.sessions).toHaveLength(1); expect(f.api.get(view.id).windowId).toBe('@1'); f.close();
  });
  it('creates only one window using a persisted idempotency key and does not retry after restore', async () => {
    const f = fixture(); f.win.Api.post.mockRejectedValueOnce(new Error('network lost'));
    const view = await f.api.create({ serverId: 'dev', instanceId: remote.instanceId, sessionId: remote.sessionId });
    expect(view.windowId).toBeNull(); await f.api.render('dev', view.id, { container: f.host });
    expect(f.win.Api.post.mock.calls[0][1].requestId).toBe(f.win.Api.post.mock.calls[1][1].requestId);
    f.api.unmount(); await f.api.render('dev', view.id, { container: f.host });
    expect(f.win.Api.post).toHaveBeenCalledTimes(2); f.close();
  });
  it('keeps native input drawer and iOS keyboard focus exclusive', async () => {
    const f = fixture(); f.win.MobileUI.isMobile = () => true; let drawer;
    f.win.FabDrawer = { mount: (_node, options) => { drawer = options; return { setScene() {}, destroy() {} }; } };
    const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    f.host.querySelector('.fab-tool').click(); drawer.sendKey('\x02');
    expect(f.sessions[0].send).toHaveBeenCalledWith('\x02');
    expect(f.host.querySelector('.fab-drawer-mount').classList.contains('open')).toBe(true);
    f.host.querySelector('.mobile-terminal-keyboard').click();
    expect(f.win.document.activeElement).toBe(f.sessions[0].term.textarea);
    expect(f.host.querySelector('.fab-drawer-mount').classList.contains('open')).toBe(false); f.close();
  });
  it('does not mount after navigation or rebind a missing instance', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote }); let finish;
    f.win.Api.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const render = f.api.render('dev', view.id, { container: f.host }); f.api.unmount(); finish({ available: true, protocol: 1 }); await render;
    expect(f.sessions).toHaveLength(0); await f.api.render('dev', view.id, { container: f.host });
    f.api.reconcileWorkspace('dev', { complete: false, instanceId: 'new', sessions: [] }); expect(f.sessions[0].status).toBe('live');
    f.api.reconcileWorkspace('dev', { complete: true, instanceId: 'new', sessions: [] }); expect(f.sessions[0].status).toBe('invalid');
    expect(f.api.get(view.id).windowId).toBe('@1'); expect(f.win.Api.post).not.toHaveBeenCalled(); f.close();
  });  it('does not let a disposed mobile drawer send keys or focus a newer view', async () => {
    const f = fixture(); f.win.MobileUI.isMobile = () => true; const drawers = [];
    f.win.FabDrawer = { mount: (_node, options) => { drawers.push(options); return { setScene() {}, destroy() {} }; } };
    const first = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', first.id, { container: f.host });
    f.host.querySelector('.fab-tool').click();
    const second = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', second.id, { container: f.host });
    drawers[0].sendKey('stale input'); drawers[0].onKeyboard();
    expect(f.sessions[1].send).not.toHaveBeenCalled();
    expect(f.win.document.activeElement).not.toBe(f.sessions[1].term.textarea); f.close();
  });
  it('freshly verifies the native source and discards a reply after its view was left', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    const initial = f.api.currentContext();
    f.sessions[0].requestContext = async () => { f.sessions[0].context = { ...f.sessions[0].context, paneId: '%8' }; f.sessions[0].options.onContext(f.sessions[0].context); return f.sessions[0].context; };
    const fresh = await f.api.focusedContext(); expect(fresh.paneId).toBe('%8'); expect(fresh.focusRequestKey).toBe(initial.key);
    let finish; f.sessions[0].requestContext = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.api.focusedContext(); const rejected = expect(pending).rejects.toThrow('工作台');
    f.api.unmount(); finish({ paneId: '%8' }); await rejected; f.close();
  });
  it('shares the existing desktop and mobile header without a second terminal toolbar or remount', async () => {
    const f = fixture();
    f.win.document.body.insertAdjacentHTML('afterbegin', '<header id="ms-topbar"><div id="ms-top-actions"></div></header><header class="mobile-header" id="ms-native-mobile-header"><div id="ms-mobile-tools" aria-hidden="true"></div></header>');
    const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    const actions = f.win.document.querySelector('.wb-toolbar-actions'); expect(actions.parentNode.id).toBe('ms-top-actions');
    f.win.MobileUI.isMobile = () => true; f.win.dispatchEvent(new f.win.Event('resize'));
    expect(actions.parentNode.id).toBe('ms-native-mobile-header'); expect(f.host.querySelector('.wb-toolbar').hidden).toBe(true);
    expect(f.sessions).toHaveLength(1); f.api.unmount(); expect(actions.isConnected).toBe(false); f.close();
  });

  it('respawns panes with resync and opens Git preview in sidebar, replace, split-down, and split-right modes', async () => {
    const f = fixture();
    f.win.Api.patch = vi.fn(async () => ({ ok: true }));
    f.win.Api.get = vi.fn(async (url) => {
      if (url.includes('/api/workbench/window-capability')) return { available: true, protocol: 1 };
      if (url.includes('/api/git/status')) return { root: '/srv/my-repo', files: [] };
      return {};
    });
    f.win.BlockHost = { open: vi.fn() };

    const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const session = f.sessions[0];

    await f.api.respawnPane('%1');
    expect(f.win.Api.post).toHaveBeenCalledWith('/n/dev/api/workspace/panes/%251/respawn', {});
    expect(session.requestResync).toHaveBeenCalledWith('%1', true);

    await f.api.openGitPreview({ paneId: '%1', mode: 'sidebar' });
    expect(f.win.BlockHost.open).toHaveBeenCalledWith('git', { path: '/srv/my-repo' });

    await f.api.openGitPreview({ paneId: '%1', mode: 'replace' });
    expect(f.win.Api.patch).toHaveBeenCalledWith('/n/dev/api/workspace/panes/%251', { kind: 'diff', payload: { path: '/srv/my-repo' } });
    expect(session.requestResync).toHaveBeenCalledWith('%1', false);

    await f.api.openGitPreview({ paneId: '%1', mode: 'split-down' });
    expect(f.win.Api.post).toHaveBeenLastCalledWith('/n/dev/api/workspace/windows/%401/panes', {
      paneId: '%1', direction: 'vertical', kind: 'diff', payload: { path: '/srv/my-repo' },
    });

    await f.api.openGitPreview({ paneId: '%1', mode: 'split-right' });
    expect(f.win.Api.post).toHaveBeenLastCalledWith('/n/dev/api/workspace/windows/%401/panes', {
      paneId: '%1', direction: 'horizontal', kind: 'diff', payload: { path: '/srv/my-repo' },
    });

    f.close();
  });

  it('provides extended mobile quick keys with paste, Git menu shortcut, and visualViewport refit', async () => {
    const f = fixture();
    f.win.MobileUI.isMobile = () => true;
    const vvListeners = {};
    f.win.visualViewport = {
      addEventListener: vi.fn((name, fn) => { vvListeners[name] = fn; }),
      removeEventListener: vi.fn((name, fn) => { if (vvListeners[name] === fn) delete vvListeners[name]; }),
    };
    Object.defineProperty(f.win.navigator, 'clipboard', {
      value: { readText: vi.fn(async () => 'git status') },
      configurable: true,
    });

    const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const session = f.sessions[0];
    session.fit = vi.fn();

    const quickBtns = [...f.host.querySelectorAll('.mobile-terminal-quick-keys button')].map((b) => b.dataset.wbKey);
    expect(quickBtns).toEqual(['esc', 'tab', 'ctrl', 'up', 'down', 'paste']);

    f.host.querySelector('[data-wb-key="up"]').click();
    expect(session.send).toHaveBeenCalledWith('\x1b[A');

    f.host.querySelector('[data-wb-key="paste"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(session.paste).toHaveBeenCalledWith('git status');

    const menuLabels = [...f.win.document.querySelectorAll('.wb-command-menu .wb-menu-item')].map((b) => b.textContent);
    expect(menuLabels).toContain('打开 Git 预览');

    vvListeners.resize?.();
    expect(session.fit).toHaveBeenCalled();

    f.api.unmount();
    expect(f.win.visualViewport.removeEventListener).toHaveBeenCalled();
    f.close();
  });

  it('debounces visibilitychange hiding for 10s so quick tab switches avoid re-snapshotting', async () => {
    const f = fixture();
    let hidden = false;
    Object.defineProperty(f.win.document, 'hidden', { configurable: true, get: () => hidden });
    const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const session = f.sessions[0];
    session.setVisible = vi.fn();

    vi.useFakeTimers();
    try {
      hidden = true;
      f.win.document.dispatchEvent(new f.win.Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(session.setVisible).not.toHaveBeenCalledWith(false);

      // Returning before 10s cancels pending hide.
      hidden = false;
      f.win.document.dispatchEvent(new f.win.Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(15000);
      expect(session.setVisible).not.toHaveBeenCalledWith(false);
      expect(session.setVisible).toHaveBeenCalledWith(true);

      // Staying hidden >= 10s notifies session.setVisible(false).
      session.setVisible.mockClear();
      hidden = true;
      f.win.document.dispatchEvent(new f.win.Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10000);
      expect(session.setVisible).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
      f.close();
    }
  });

  it('skips capability HTTP check when AppShell health already reports windowStream, and warm-caches switched windows with LRU eviction', async () => {
    const f = fixture();
    f.win.AppShell = {
      health: (sid) => sid === 'dev' ? { capabilities: { windowStream: { available: true, protocol: 1 } } } : null,
    };
    const addParkedSpy = (s) => { s.setParked = vi.fn(); };
    const v1 = await f.api.create({ serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@1', paneId: '%1' });
    const v2 = await f.api.create({ serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@2', paneId: '%2' });
    // supported() fast path skipped /api/workbench/window-capability
    expect(f.win.Api.get).not.toHaveBeenCalled();

    await f.api.render('dev', v1.id, { container: f.host });
    addParkedSpy(f.sessions[0]);
    expect(f.win.Api.get).not.toHaveBeenCalled();

    // Switch to @2 -> @1 is parked (not disposed!)
    await f.api.render('dev', v2.id, { container: f.host });
    addParkedSpy(f.sessions[1]);
    expect(f.sessions[0].setParked).toHaveBeenCalledWith(true);
    expect(f.sessions[0].disposed).not.toBe(true);
    expect(f.sessions).toHaveLength(2);

    // Switch back to @1 -> reuses exact same Session instance with 0 new Session constructions!
    await f.api.render('dev', v1.id, { container: f.host });
    expect(f.sessions).toHaveLength(2);
    expect(f.sessions[0].setParked).toHaveBeenLastCalledWith(false);
    expect(f.sessions[1].setParked).toHaveBeenCalledWith(true);

    // Closing or unmounting disposes both active and parked views cleanly.
    f.api.closeView(v2.id);
    expect(f.sessions[1].disposed).toBe(true);
    f.api.unmount();
    expect(f.sessions[0].disposed).toBe(true);
    f.close();
  });

});
