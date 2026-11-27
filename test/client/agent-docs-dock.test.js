import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

// Documents agents write go straight into the dock (FilePreview.openDocked),
// only for the window in view, without a modal and without taking the keyboard
// (files-commands.js), and get a bar with the agent's pane (agent-docs.js).

const INSTANCE = '1873:1700000000';
const previewSource = readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
const commandsSource = readFileSync('plugins/files/client/js/files-commands.js', 'utf8');
const barSource = readFileSync('plugins/agent-docs/client/js/agent-docs.js', 'utf8');

let dom;
afterEach(() => dom?.window.close());

function setup({ width = 1440, docInfo = null } = {}) {
  dom = new JSDOM('<div class="ms-app mode-terminal"><main class="ms-main"><div class="terminal-view">'
    + '<textarea class="xterm-helper-textarea"></textarea></div></main></div>', { url: 'https://panel.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width });
  const fetch = vi.fn(async (url) => {
    const parsed = new URL(url, window.location.href);
    const path = parsed.searchParams.get('path');
    if (parsed.pathname.endsWith('/info')) {
      return { status: 200, json: async () => ({ success: true, data: { absPath: path, isText: true, language: 'html', size: 10, mtimeMs: 1 } }) };
    }
    if (parsed.pathname.endsWith('/raw')) {
      return { ok: true, status: 200, text: async () => '<h1>' + path + '</h1>' };
    }
    if (parsed.pathname.endsWith('/content')) {
      return { status: 200, json: async () => ({ success: true, data: { content: '<h1>' + path + '</h1>', language: 'html' } }) };
    }
    throw new Error('Unexpected fetch: ' + url);
  });
  const toast = vi.fn();
  window.fetch = fetch;
  const sent = [];
  const openers = {};
  window.Api = { activeServerId: () => 'local', nodeUrl: (_serverId, path) => path };
  window.AppShell = { workspace: () => ({ provider: 'tmux', complete: true, instanceId: INSTANCE, sessions: [{ id: '$1', windows: [
    { id: '@0', panes: [{ id: '%1' }, { id: '%2' }] },
    { id: '@5', panes: [{ id: '%7' }] },
  ] }] }) };
  window.PanelSlots = { commands: { register() {} }, openers: { register(opener) { openers[opener.id] = opener; } } };
  window.BlockHost = {};
  window.eval(readFileSync('plugins/ui/client/js/blocks-kit.js', 'utf8'));
  var windowTarget = window.Blocks.ui.windowTarget;
  var revealWindow = window.Blocks.ui.revealWindow;
  window.Blocks = {
    icon: () => '',
    rendererFor: () => null,
    ui: {
      windowTarget,
      revealWindow,
      el: (tag) => window.document.createElement(tag), button: () => window.document.createElement('button'),
      iconButton: () => window.document.createElement('button'), errorText: String, toast,
      currentContext: () => ({ serverId: 'local', paneId: '%2', onTerminal: true }),
      selectedContext: () => ({ serverId: 'local', paneId: '%2' }),
      client: () => ({
        get: vi.fn(async (path, params) => path === '/api/workspace' ? window.AppShell.workspace() : ({ path: params.path, doc: docInfo })),
        send: vi.fn(async (method, path, body) => { sent.push([method, path, body]); return {}; }),
      }),
    },
  };
  new Function('window', 'document', 'fetch', 'Auth', previewSource)(window, window.document, fetch, undefined);
  const notices = vi.fn();
  window.NotificationPanel = { addDocument: notices, previewViewed: vi.fn() };
  window.eval(commandsSource);
  window.eval(barSource);
  window.FilePreview.switchDockContext('local', '@0', INSTANCE);
  const typing = window.document.querySelector('.xterm-helper-textarea');
  typing.focus();
  return { window, preview: window.FilePreview, openers, toast, notices, sent, typing, fetch };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const tabs = (window) => Array.from(window.document.querySelectorAll('.fp-dock .fp-dock-tab-item')).map((item) => ({
  name: item.querySelector('.fp-dock-tab-label').textContent,
  active: item.classList.contains('active'),
  unread: item.classList.contains('is-unread'),
}));
const modals = (window) => window.document.querySelectorAll('.fp-overlay:not(.fp-dock)').length;

describe('the source pane of a docked document', () => {
  const path = '/w/p/.anymux/docs/source.html';
  function sources() {
    const ctx = setup({ docInfo: { kind: 'draft', label: '草稿', owner: 'anymux', proposal: null } });
    ctx.window.AppShell.workspace = () => ({ complete: true, instanceId: INSTANCE, sessions: [{ id: '$1', windows: [
      { id: '@0', panes: [{ id: '%1', index: 1, command: 'codex' }, { id: '%4', index: 4, command: 'node' }] },
    ] }] });
    return ctx;
  }
  const discovered = { type: 'open-file', serverId: 'local', path, paneId: '%1', paneIds: ['%1', '%4'],
    placement: 'dock', activate: true, origin: 'agent-doc' };
  const explicit = { type: 'open-file', serverId: 'local', path, paneId: '%4', windowId: '@0', instanceId: INSTANCE,
    placement: 'dock', activate: true };

  it('does not name the first of several project panes as the author', async () => {
    const { window, openers } = sources();
    await openers['open-file'].run(discovered); await settle();
    expect(tabs(window)).toHaveLength(1);
    expect(window.document.querySelector('.ad-source')).toBeNull();
    expect([...window.document.querySelectorAll('.ad-bar button')].some(b => b.textContent === '回复…')).toBe(false);
  });

  it.each(['watcher-first', 'explicit-first'])('keeps the explicit source and Reply target with %s arrival order', async order => {
    const { window, openers, sent, notices } = sources();
    for (const event of order === 'watcher-first' ? [discovered, explicit] : [explicit, discovered]) {
      await openers['open-file'].run(event); await settle();
    }
    expect(tabs(window)).toHaveLength(1);
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
    expect(notices.mock.calls.at(-1)[0]).toMatchObject({ paneId: '%4', target: { paneId: '%4' } });
    [...window.document.querySelectorAll('.ad-bar button')].find(b => b.textContent === '回复…').click(); await settle();
    expect(sent.at(-1)[2].paneId).toBe('%4');
  });

  it('updates a reused tab from pane 1 to pane 4 without replacing its body or taking focus', async () => {
    const { window, preview, openers, typing } = sources();
    await preview.openDocked(path, '%1'); await settle();
    const body = window.document.querySelector('.fp-dock .fp-body'); body.scrollTop = 37;
    typing.focus();
    await openers['open-file'].run(explicit); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
    expect(window.document.querySelector('.fp-dock .fp-body')).toBe(body);
    expect(body.scrollTop).toBe(37); expect(window.document.activeElement).toBe(typing);
  });

  it('preserves the explicit source in a saved offscreen window when discovery follows', async () => {
    const { window, preview, openers } = sources();
    const workspace = window.AppShell.workspace(); workspace.sessions[0].windows[0].id = '@5';
    window.AppShell.workspace = () => workspace;
    await openers['open-file'].run({ ...explicit, windowId: '@5' });
    await openers['open-file'].run(discovered);
    await preview.switchDockContext('local', '@5', INSTANCE); await settle(); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
  });

  it('does not let an old pane metadata response put the Reply target back on pane 1', async () => {
    const { window, preview, openers, sent } = sources();
    let finishOld;
    const pending = new Promise(resolve => { finishOld = resolve; });
    const client = window.Blocks.ui.client;
    window.Blocks.ui.client = id => ({ ...client(id), get: (url, params) => url === '/api/agent-docs/info' && params.paneId === '%1'
      ? pending : client(id).get(url, params) });
    await preview.openDocked(path, '%1');
    await openers['open-file'].run(explicit); await settle();
    finishOld({ doc: { kind: 'draft', label: '草稿', owner: 'anymux', proposal: null } }); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
    [...window.document.querySelectorAll('.ad-bar button')].find(b => b.textContent === '回复…').click(); await settle();
    expect(sent.at(-1)[2].paneId).toBe('%4');
  });

  it('updates an inactive tab source without changing the current tab source', async () => {
    const { window, preview } = sources();
    await preview.openDocked(path, '%1');
    await preview.openDocked('/w/p/.anymux/docs/other.html', '%1'); await settle();
    await preview.openDocked(path, '%4', { activate: false }); await settle();
    expect(tabs(window).find(t => t.active).name).toBe('other.html');
    expect(window.document.querySelector('.fp-dock-panels .ad-source').textContent).toBe('来自1:codex');
    window.document.querySelectorAll('.fp-dock-tab')[0].click(); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
  });

  it('does not let a slower earlier open replace the newer notice Reply target', async () => {
    const { window, openers, fetch, notices } = sources();
    const original = fetch.getMockImplementation();
    let finishFetch;
    fetch.mockImplementationOnce((...args) => new Promise(resolve => { finishFetch = () => resolve(original(...args)); }));
    const older = openers['open-file'].run({ ...explicit, paneId: '%1' }); await settle();
    await openers['open-file'].run(explicit);
    finishFetch(); await older; await settle(); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
    expect(notices.mock.calls.at(-1)[0]).toMatchObject({ paneId: '%4', target: { paneId: '%4' } });
  });

  it('ignores an older source lookup that finishes after pane 4 has opened the file', async () => {
    const { window, openers, notices } = sources();
    const workspace = window.AppShell.workspace();
    let finishOld;
    const pending = new Promise(resolve => { finishOld = resolve; });
    const client = window.Blocks.ui.client;
    window.Blocks.ui.client = id => ({ ...client(id), get: (url, params) => url === '/api/workspace' ? pending : client(id).get(url, params) });
    window.AppShell.workspace = () => null;
    const older = openers['open-file'].run({ ...explicit, paneId: '%1' });
    window.AppShell.workspace = () => workspace;
    await openers['open-file'].run(explicit); await settle();
    finishOld(workspace); await older; await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
    expect(notices.mock.calls.at(-1)[0].target.paneId).toBe('%4');
  });

  it('reserves the newer explicit source before either workspace lookup finishes', async () => {
    const { window, preview, openers } = sources();
    await preview.openDocked(path, '%4'); await settle();
    const workspace = window.AppShell.workspace();
    const finish = [];
    const client = window.Blocks.ui.client;
    window.Blocks.ui.client = id => ({ ...client(id), get: (url, params) => url === '/api/workspace'
      ? new Promise(resolve => { finish.push(resolve); }) : client(id).get(url, params) });
    window.AppShell.workspace = () => null;
    const older = openers['open-file'].run({ ...explicit, paneId: '%1' });
    const newer = openers['open-file'].run(explicit);
    finish[0](workspace); await older; await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
    window.AppShell.workspace = () => workspace;
    finish[1](workspace); await newer; await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自4:node');
  });

  it('does not choose the current window when discovery candidates belong to different windows', async () => {
    const { window, openers, notices } = sources();
    const workspace = window.AppShell.workspace();
    workspace.sessions[0].windows[0].panes.pop();
    workspace.sessions[0].windows.push({ id: '@5', panes: [{ id: '%4', index: 4, command: 'node' }] });
    window.AppShell.workspace = () => workspace;
    await openers['open-file'].run(discovered); await settle();
    expect(tabs(window)).toEqual([]); expect(notices).not.toHaveBeenCalled();
  });
});

describe('opening a document straight into the dock', () => {
  it('waits for View before switching windows and opens mobile documents in their source window', async () => {
    const { window, openers, toast, notices } = setup({ width: 375 });
    const addDocument = vi.fn(); window.NotificationPanel = { addDocument };
    window.Router = { go: vi.fn((route) => window.setTimeout(() => window.FilePreview.switchDockContext('local', route.params.windowId, INSTANCE), 20)) };
    await openers['open-file'].run({ placement: 'dock', path: '/w/p/notice.html', paneId: '%7' });
    expect(window.Router.go).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    const open = addDocument.mock.calls[0][1];
    await open();
    expect(window.Router.go).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ windowId: '@5' }) }));
    expect(window.FilePreview.blockDock.context()).toBe(['local', INSTANCE, '@5'].join('\0'));
    expect(modals(window)).toBe(1);
  });

  it('makes a dock with the document, shows no modal and leaves the keyboard in the terminal', async () => {
    const { window, preview, typing } = setup();
    await expect(preview.openDocked('/w/p/.anymux/docs/plan.html', '%1')).resolves.toBe('activated');
    expect(tabs(window)).toEqual([{ name: 'plan.html', active: true, unread: false }]);
    expect(modals(window)).toBe(0);
    expect(window.document.querySelector('.fp-dock').classList.contains('fp-restoring')).toBe(false);
    expect(window.document.activeElement).toBe(typing);

    await expect(preview.openDocked('/w/p/.anymux/docs/plan.html', '%1')).resolves.toBe('activated');
    expect(tabs(window)).toHaveLength(1);
    await expect(preview.openDocked('/w/p/.anymux/docs/plan.html', '%1', { activate: false })).resolves.toBe('exists');
  });

  it('adds a background document behind the current tab with an unread mark, and never makes a dock for one', async () => {
    const { window, preview, typing } = setup();
    await expect(preview.openDocked('/w/p/.superpowers/sdd/x/progress.md', '%1', { activate: false })).resolves.toBe('skipped');
    expect(window.document.querySelector('.fp-dock')).toBeNull();
    await preview.openDocked('/w/p/docs/superpowers/plans/plan.html', '%1');
    await expect(preview.openDocked('/w/p/.superpowers/sdd/x/progress.html', '%1', { activate: false })).resolves.toBe('added');
    expect(tabs(window)).toEqual([
      { name: 'plan.html', active: true, unread: false },
      { name: 'progress.html', active: false, unread: true },
    ]);
    expect(window.document.activeElement).toBe(typing);
    window.document.querySelectorAll('.fp-dock-tab')[1].click();
    expect(tabs(window)[1]).toEqual({ name: 'progress.html', active: true, unread: false });
  });

  it('keeps a collapsed dock collapsed and marks its button instead', async () => {
    const { window, preview } = setup();
    await preview.openDocked('/w/p/a.html', '%1');
    window.document.querySelector('[aria-label="隐藏右侧预览"]').click();
    await expect(preview.openDocked('/w/p/b.html', '%1')).resolves.toBe('hidden');
    expect(window.document.querySelector('.fp-dock')).toBeNull();
    expect(window.document.body.classList.contains('fp-side-open')).toBe(false);
    const restore = window.document.querySelector('.fp-dock-restore');
    expect(restore.textContent).toContain('2');
    expect(restore.classList.contains('has-unread')).toBe(true);
    restore.click();
    expect(tabs(window).map((tab) => tab.name)).toEqual(['a.html', 'b.html']);
    expect(tabs(window)[1].unread).toBe(true);
  });

  it('puts a document that moved into the project where its draft was', async () => {
    const { window, preview } = setup();
    await preview.openDocked('/w/p/one.html', '%1');
    await preview.openDocked('/w/p/.anymux/docs/design.html', '%1');
    await preview.openDocked('/w/p/three.html', '%1');
    window.document.querySelectorAll('.fp-dock-tab')[1].click();
    await expect(preview.openDocked('/w/p/docs/design.html', '%1', { replaces: '/w/p/.anymux/docs/design.html' })).resolves.toBe('activated');
    expect(tabs(window)).toEqual([
      { name: 'one.html', active: false, unread: false },
      { name: 'design.html', active: true, unread: false },
      { name: 'three.html', active: false, unread: false },
    ]);
    expect(window.document.querySelector('.fp-dock-tab-item.active .fp-dock-tab').title).toBe('/w/p/docs/design.html');
  });

  it('stays out of the way of an open modal and of screens without room for a dock', async () => {
    const { preview } = setup();
    await preview.openFile('/w/p/reading.html', '%1');
    await expect(preview.openDocked('/w/p/plan.html', '%1')).resolves.toBe('busy');
    dom.window.close();
    const narrow = setup({ width: 600 });
    await expect(narrow.preview.openDocked('/w/p/plan.html', '%1')).resolves.toBe('unavailable');
    expect(modals(narrow.window)).toBe(0);
  });
});

describe('documents announced by a pane', () => {
  it('clears the source reminder immediately when the real dock context switches to its window', async () => {
    const { window, preview } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    const row = window.document.createElement('div');
    row.className = 'tree-window-row'; row.dataset.serverId = 'local'; row.dataset.window = '@5';
    window.document.body.appendChild(row);
    window.NotificationPanel.addDocument({ id: 'context-switch', type: 'document', serverId: 'local', path: '/w/pending.html', read: false,
      target: { instanceId: INSTANCE, windowId: '@5' } });
    expect(row.querySelector('.preview-window-notice')).not.toBeNull();
    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(row.querySelector('.preview-window-notice')).toBeNull();
    expect(window.NotificationPanel.unreadCount()).toBe(1);
  });

  it('does not acknowledge a newer same-file notice when an older real preview finishes loading', async () => {
    const { window, preview, fetch } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    const row = window.document.createElement('div');
    row.className = 'tree-window-row'; row.dataset.serverId = 'local'; row.dataset.window = '@0';
    window.document.body.appendChild(row);
    const panel = window.NotificationPanel;
    const notice = { id: 'slow-file', type: 'document', serverId: 'local', path: '/w/slow.html', read: false,
      target: { instanceId: INSTANCE, windowId: '@0' } };
    const original = fetch.getMockImplementation();
    let finish, started;
    const contentStarted = new Promise(resolve => { started = resolve; });
    fetch.mockImplementation(url => String(url).includes('/raw')
      ? new Promise(resolve => { finish = () => resolve(original(url)); started(); }) : original(url));
    let opened;
    await preview.switchDockContext('local', '@5', INSTANCE);
    panel.addDocument(notice, () => {
      opened = preview.switchDockContext('local', '@0', INSTANCE).then(() => preview.openDocked(notice.path, '%1'));
      return opened;
    });
    row.querySelector('.preview-window-view').click();
    await contentStarted;
    panel.addDocument({ ...notice, fragment: 'new-section' }, async () => false);
    finish(); await opened; await settle();
    expect(tabs(window).map(tab => tab.name)).toEqual(['slow.html']);
    expect(panel.unreadCount()).toBe(1);
    window.document.querySelector('.fp-dock-tab').click();
    expect(panel.unreadCount()).toBe(1);
    expect(JSON.parse(window.localStorage.getItem('anymux_document_notifications_v1'))[0]).toMatchObject({ fragment: 'new-section', read: false });
    fetch.mockImplementation(url => String(url).includes('/raw')
      ? Promise.resolve({ ok: true, status: 200, text: async () => '<h1>latest content</h1>' }) : original(url));
    await preview._test.refreshCurrent(true);
    expect(window.document.querySelector('.fp-html-wrap iframe').srcdoc).toContain('latest content');
    expect(panel.unreadCount()).toBe(0);
  });

  it('acknowledges a notice registered after hidden preloading when fresh metadata confirms the visible file', async () => {
    const { window, preview } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    await preview.openDocked('/w/old.html', '%1');
    window.document.querySelector('[aria-label="隐藏右侧预览"]').click();
    await expect(preview.openDocked('/w/new.html', '%1')).resolves.toBe('hidden');
    window.NotificationPanel.addDocument({ id: 'preloaded', type: 'document', serverId: 'local', path: '/w/new.html', read: false,
      target: { instanceId: INSTANCE, windowId: '@0' } });
    window.document.querySelector('.fp-dock-restore').click();
    window.document.querySelectorAll('.fp-dock-tab')[1].click();
    expect(window.NotificationPanel.unreadCount()).toBe(1);
    await expect(preview._test.refreshCurrent(false)).resolves.toBe(false);
    expect(window.NotificationPanel.unreadCount()).toBe(0);
  });

  it('queues a validated window-only arrival without inventing a source pane', async () => {
    const { window, openers, preview, notices } = setup();
    await openers['open-file'].run({ placement: 'dock', path: '/w/window.html', paneId: null, windowId: '@5', instanceId: INSTANCE });
    expect(notices.mock.calls[0][0].target).toMatchObject({ windowId: '@5', paneId: null });
    expect(tabs(window)).toEqual([]);
    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(tabs(window).map(tab => tab.name)).toEqual(['window.html']);
    expect(window.document.querySelector('.agent-doc-bar')).toBeNull();
  });

  it('does not deliver a preview into a reused window after a tmux restart', async () => {
    const { openers, notices } = setup();
    await openers['open-file'].run({ placement: 'dock', path: '/w/old.html', paneId: '%7', windowId: '@5', instanceId: '1:1' });
    expect(notices.mock.calls[0][0].target).toBeNull();
  });

  it('acknowledges a queued document when its source window is visited and the preview is visible', async () => {
    const { window, openers, preview } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    await openers['open-file'].run({ placement: 'dock', path: '/w/p/viewed.html', paneId: '%7' });
    expect(window.NotificationPanel.unreadCount()).toBe(1);
    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(window.NotificationPanel.unreadCount()).toBe(0);
  });

  it('keeps a collapsed preview unread after visiting its window', async () => {
    const { window, openers, preview } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    const target = { serverId: 'local', instanceId: INSTANCE, windowId: '@5', paneId: '%7' };
    const key = 'tmux_file_preview_dock_v4:' + encodeURIComponent(['local', INSTANCE, '@5'].join('\0'));
    window.localStorage.setItem(key, JSON.stringify({ version: 1, hidden: true, activePath: '/w/p/unread.html', tabs: [{ path: '/w/p/unread.html', paneId: '%7' }] }));
    window.NotificationPanel.addDocument({ id: 'collapsed', type: 'document', path: '/w/p/unread.html', serverId: 'local', target });
    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(window.document.querySelector('.fp-dock')).toBeNull();
    expect(window.NotificationPanel.unreadCount()).toBe(1);
    window.document.querySelector('.fp-dock-restore').click();
    expect(window.NotificationPanel.unreadCount()).toBe(0);
  });

  it('acknowledges only the final visible tab when several queued documents restore', async () => {
    const { window, openers, preview } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    await openers['open-file'].run({ placement: 'dock', path: '/w/first.html', paneId: '%7' });
    await openers['open-file'].run({ placement: 'dock', path: '/w/second.html', paneId: '%7' });
    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(tabs(window).find(tab => tab.active).name).toBe('second.html');
    expect(window.NotificationPanel.unreadCount()).toBe(1);
  });

  it('does not acknowledge a restored file hidden behind the saved Git tab', async () => {
    const { window, preview } = setup();
    window.eval(readFileSync('plugins/notifications/client/js/notifications.js', 'utf8'));
    const frame = window.document.createElement('section'); frame.textContent = 'Git';
    preview.blockDock.sync([{ key: 'repo', persistKey: 'git:repo', element: frame, title: 'Git', active: true }]);
    const key = 'tmux_file_preview_dock_v4:' + encodeURIComponent(['local', INSTANCE, '@5'].join('\0'));
    window.localStorage.setItem(key, JSON.stringify({ version: 1, tabs: [{ path: '/w/note.html' }], activePath: '/w/note.html', activeBlock: 'git:repo', hidden: false }));
    window.NotificationPanel.addDocument({ id: 'behind-git', path: '/w/note.html', serverId: 'local', target: { instanceId: INSTANCE, windowId: '@5' } });
    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(window.document.querySelector('.fp-dock-tab-item.active').textContent).toContain('Git');
    expect(window.NotificationPanel.unreadCount()).toBe(1);
  });

  it('adds background progress to a dock that currently contains only a tool block', async () => {
    const { window, preview } = setup();
    const frame = window.document.createElement('section');
    preview.blockDock.sync([{ key: 'git', persistKey: 'git:project', element: frame, title: 'Git', active: true }]);
    await expect(preview.queueDocked('/w/progress.html', '%1', {
      serverId: 'local', windowId: '@0', instanceId: INSTANCE, activate: false,
    })).resolves.toBe('added');
    expect(tabs(window)).toEqual([
      { name: 'Git', active: true, unread: false },
      { name: 'progress.html', active: false, unread: true },
    ]);
  });

  it('allows an explicit notice click to replace a modal that automatic arrivals leave alone', async () => {
    const { window, preview, openers, toast, notices } = setup();
    await preview.openFile('/w/reading.html', '%1');
    await openers['open-file'].run({ placement: 'dock', path: '/w/requested.html', paneId: '%1' });
    expect(window.document.querySelector('.fp-title').textContent).toContain('reading.html');
    await notices.mock.calls[0][1]();
    expect(window.document.querySelector('.fp-title').textContent).toContain('requested.html');
    expect(modals(window)).toBe(1);
  });

  it('opens a notice in the mobile reader when the screen cannot show a dock', async () => {
    const { window, openers, toast, notices } = setup({ width: 600 });
    await openers['open-file'].run({ placement: 'dock', path: '/w/mobile.html', paneId: '%1' });
    await notices.mock.calls[0][1]();
    expect(modals(window)).toBe(1);
    expect(window.document.querySelector('.fp-title').textContent).toContain('mobile.html');
  });

  it('reveals the requested document after expanding a collapsed dock', async () => {
    const { window, preview, openers, toast, notices } = setup();
    await preview.openDocked('/w/old.html', '%1');
    window.document.querySelector('[aria-label="隐藏右侧预览"]').click();
    await openers['open-file'].run({ placement: 'dock', path: '/w/new.html', paneId: '%1' });
    await notices.mock.calls[0][1]();
    expect(tabs(window).find(t => t.active).name).toBe('new.html');
    expect(window.document.querySelector('.fp-dock')).not.toBeNull();
  });

  it('resolves a moved window again when a persisted notification is opened', async () => {
    const { window, openers, toast, notices } = setup();
    window.Router = { go: vi.fn(route => window.setTimeout(() => window.FilePreview.switchDockContext('local', route.params.windowId, INSTANCE), 20)) };
    await openers['open-file'].run({ placement: 'dock', path: '/w/moved.html', paneId: '%7' });
    const original = window.AppShell.workspace();
    window.AppShell.workspace = () => ({ ...original, sessions: [{ id: '$9', windows: [{ id: '@5', panes: [{ id: '%8' }] }] }] });
    await notices.mock.calls[0][1]();
    expect(window.Router.go).toHaveBeenCalledWith({ name: 'terminal', params: {
      serverId: 'local', sessionId: '$9', windowId: '@5', paneId: null,
    } });
  });

  it('preserves a newer activation received while the same saved path is being restored', async () => {
    const { window, preview, fetch, openers } = setup();
    await preview.openDocked('/w/a.html', '%1');
    await preview.openDocked('/w/b.html', '%1');
    await preview.switchDockContext('local', '@5', INSTANCE);
    const original = fetch.getMockImplementation();
    let release;
    fetch.mockImplementation(url => !release && String(url).includes('/info') && String(url).includes('a.html')
      ? new Promise(resolve => { release = () => resolve(original(url)); }) : original(url));
    const restored = preview.switchDockContext('local', '@0', INSTANCE);
    await settle();
    await openers['open-file'].run({ placement: 'dock', path: '/w/a.html', paneId: '%1', fragment: 'new-heading' });
    release();
    await restored;
    await settle(); await settle();
    expect(tabs(window).find(t => t.active).name).toBe('a.html');
    const saved = JSON.parse(window.localStorage.getItem(preview._test.dockStateKey('local', '@0', INSTANCE)));
    expect(saved.tabs.find(t => t.path === '/w/a.html').fragment).toBe('new-heading');
  });

  it('supports the current in-memory dock of an older Node without persisting an unknown instance', async () => {
    const { window, preview } = setup();
    await preview.switchDockContext('local', '@0', null);
    await preview.queueDocked('/w/current.html', '%1', { serverId: 'local', windowId: '@0', instanceId: null });
    expect(tabs(window).map(t => t.name)).toEqual(['current.html']);
    expect(preview._test.dockStateKey('local', '@0', null)).toBeNull();
  });

  it('does not lose a document when the user leaves while its content is loading', async () => {
    const { window, preview, fetch, openers } = setup();
    const original = fetch.getMockImplementation();
    let release;
    fetch.mockImplementation(url => !release && String(url).includes('/info') && String(url).includes('slow.html')
      ? new Promise(resolve => { release = () => resolve(original(url)); }) : original(url));
    const opened = openers['open-file'].run({ placement: 'dock', path: '/w/slow.html', paneId: '%1' });
    await settle();
    await preview.switchDockContext('local', '@5', INSTANCE);
    release();
    await opened;
    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(tabs(window).map(t => t.name)).toEqual(['slow.html']);
  });

  it('drains documents received while the preceding document is loading', async () => {
    const { window, fetch, openers } = setup();
    const original = fetch.getMockImplementation();
    let release;
    fetch.mockImplementation(url => !release && String(url).includes('/info') && String(url).includes('slow.html')
      ? new Promise(resolve => { release = () => resolve(original(url)); }) : original(url));
    const first = openers['open-file'].run({ placement: 'dock', path: '/w/slow.html', paneId: '%1' });
    await settle();
    await openers['open-file'].run({ placement: 'dock', path: '/w/second.html', paneId: '%1' });
    release();
    await first;
    expect(tabs(window).map(t => t.name)).toEqual(['slow.html', 'second.html']);
    expect(tabs(window)[1].active).toBe(true);
  });

  it('selects the document clicked in a notice before asynchronous navigation restores its window', async () => {
    const { window, preview, openers, toast, notices } = setup();
    window.Router = { go: vi.fn(route => window.setTimeout(() => window.FilePreview.switchDockContext('local', route.params.windowId, INSTANCE), 20)) };
    await openers['open-file'].run({ placement: 'dock', path: '/w/first.html', paneId: '%1' });
    const action = notices.mock.calls[0][1];
    await openers['open-file'].run({ placement: 'dock', path: '/w/second.html', paneId: '%1' });
    await preview.switchDockContext('local', '@5', INSTANCE);
    await action();
    expect(window.Router.go).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ windowId: '@0' }) }));
    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(tabs(window).find(t => t.active).name).toBe('first.html');
  });

  it('opens here with a notice, queues other windows, and restores their document on return', async () => {
    const { window, openers, toast, notices, preview } = setup();
    const run = (event) => openers['open-file'].run({ type: 'open-file', placement: 'dock', activate: true, ...event });
    const queued = vi.spyOn(preview, 'queueDocked');
    await run({ path: '/w/p/.anymux/docs/here.html', paneId: '%1', kind: 'draft' });
    await settle(); await settle();
    expect(queued).toHaveBeenCalledWith('/w/p/.anymux/docs/here.html', '%1', expect.objectContaining({ activate: true, windowId: '@0' }));
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('已打开') }), expect.any(Function));

    await run({ path: '/w/p/docs/superpowers/plans/there.md', paneId: '%7', paneIds: ['%7'], kind: 'plan' });
    expect(tabs(window).map(t => t.name)).toEqual(['here.html']);
    await settle();
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('已加入') }), expect.any(Function));
    await run({ path: '/w/p/docs/superpowers/plans/there.md', paneId: '%7', paneIds: ['%7'], kind: 'plan' });
    expect(notices).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();
    await run({ path: '/w/p/.superpowers/sdd/x/progress.md', paneId: '%7', activate: false, kind: 'progress' });
    expect(notices).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();

    await preview.switchDockContext('local', '@5', INSTANCE);
    expect(tabs(window)).toEqual([
      { name: 'there.md', active: true, unread: false },
      { name: 'progress.md', active: false, unread: true },
    ]);
    expect(window.document.querySelector('.fp-dock-tab-item.is-new .fp-dock-tab-new').textContent).toBe('新');
    await preview.switchDockContext('local', '@0', INSTANCE);

    // A watcher event names every pane in the project; one of them is in view.
    await run({ path: '/w/p/.anymux/docs/project.html', paneId: '%7', paneIds: ['%7', '%2'] });
    await settle(); await settle();
    expect(queued).toHaveBeenLastCalledWith('/w/p/.anymux/docs/project.html', '%2', expect.objectContaining({ windowId: '@0' }));
    expect(window.document.querySelectorAll('.fp-dock-tab-item')).toHaveLength(2);

    // Without placement it is the old modal.
    openers['open-file'].run({ type: 'open-file', path: '/w/p/plain.html', paneId: '%1' });
    await settle();
    expect(modals(window)).toBe(1);
  });

  it('persists background arrivals without touching the visible window, even across page reloads', async () => {
    const { window, preview, typing } = setup();
    await preview.openDocked('/w/p/current.html', '%1');
    await preview.queueDocked('/w/p/new.html', '%7', {
      serverId: 'local', windowId: '@5', instanceId: INSTANCE, activate: true,
    });
    await preview.queueDocked('/w/p/new.html', '%7', {
      serverId: 'local', windowId: '@5', instanceId: INSTANCE, activate: true,
    });
    expect(tabs(window).map(t => t.name)).toEqual(['current.html']);
    expect(window.document.activeElement).toBe(typing);
    // A reload reconstructs the document as well as its scripts.
    window.document.querySelector('.ms-main').innerHTML = '<div class="terminal-view"></div>';
    window.eval(previewSource);
    await window.FilePreview.switchDockContext('local', '@5', INSTANCE);
    expect(tabs(window).map(t => t.name)).toEqual(['new.html']);
    expect(window.document.querySelector('.fp-dock-tab-item').classList.contains('is-new')).toBe(true);
    await window.FilePreview.switchDockContext('local', '@5', 'different-instance');
    expect(tabs(window)).toEqual([]);
  });

  it('keeps a queued document when a modal is open and opens it when the modal closes', async () => {
    const { window, preview } = setup();
    await preview.openFile('/w/p/reading.html', '%1');
    await preview.queueDocked('/w/p/new.html', '%1', {
      serverId: 'local', windowId: '@0', instanceId: INSTANCE, activate: true,
    });
    expect(modals(window)).toBe(1);
    preview.close();
    await settle(); await settle();
    expect(tabs(window).map(t => t.name)).toEqual(['new.html']);
    expect(modals(window)).toBe(0);
  });
});

describe('the bar above an agent document', () => {
  it('uses the real tmux index, custom label and command instead of the internal pane id', async () => {
    const { window, preview, toast } = setup({ docInfo: { kind: 'draft', label: '草稿', owner: 'anymux', proposal: null } });
    window.AppShell.server = () => ({ name: '本机' });
    window.AppShell.workspace = () => ({ sessions: [{ name: '开发', windows: [{ name: '面板', panes: [
      { id: '%1', index: 3, label: '优化预览', command: 'codex' },
    ] }] }] });
    await preview.openDocked('/w/p/.anymux/docs/design.html', '%1'); await settle();
    const bar = window.document.querySelector('.ad-bar');
    expect(bar.querySelector('.ad-source').textContent).toBe('来自 本机 / 开发 / 面板 / [优化预览] 3:codex');
    [...bar.querySelectorAll('button')].find(b => b.textContent === '回复…').click(); await settle();
    expect(toast).toHaveBeenCalledWith('已填入 [优化预览] 3:codex，在终端里补充后按回车发送', { error: false });
  });

  it('shows index zero without a label and resolves it on the source server', async () => {
    const { window, preview } = setup();
    window.AppShell.server = () => ({ name: '开发机' });
    window.AppShell.workspace = id => id === 'remote' ? { sessions: [{ name: '开发', windows: [{ name: '任务', panes: [
      { id: '%7', index: 0, label: null, command: 'fish' },
    ] }] }] } : null;
    await preview.openFile('/remote/notes.html', '%7', { source: { serverId: 'remote', paneId: '%7' } }); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自 开发机 / 开发 / 任务 / 0:fish');
  });

  it('shows kind and pane, and types replies into the pane without sending them', async () => {
    const proposal = { status: 'proposed', target: 'docs/design.md', reason: '同类都在 docs/', alternatives: ['docs/d/x.md'], also: null };
    const { window, preview, sent, toast } = setup({ docInfo: { kind: 'draft', label: '草稿', owner: 'anymux', proposal } });
    await preview.openDocked('/w/p/.anymux/docs/design.html', '%1');
    await settle();
    const bar = window.document.querySelector('.fp-dock .ad-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.nextElementSibling.classList.contains('fp-body')).toBe(true);
    expect(bar.querySelector('.ad-chip').textContent).toBe('草稿');
    expect(bar.querySelector('.ad-source').textContent).toBe('来自窗格');
    expect(bar.querySelector('.ad-proposal-text').textContent).toBe('建议放进项目：docs/design.md · 同类都在 docs/');
    const buttons = Array.from(bar.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['回复…', '确认', '改位置…', '保持草稿']);
    buttons[0].click();
    buttons[1].click();
    buttons[2].click();
    await settle();
    expect(sent).toEqual([
      ['POST', '/api/agent-docs/reply', { paneId: '%1', text: '关于 design.html：' }],
      ['POST', '/api/agent-docs/reply', { paneId: '%1', text: '确认：把 design.html 放到 docs/design.md' }],
      ['POST', '/api/agent-docs/reply', { paneId: '%1', text: '把 design.html 放到 ' }],
    ]);
    expect(toast).toHaveBeenCalledWith('已填入窗格，在终端里补充后按回车发送', { error: false });
  });

  it('shows the source of an ordinary file without agent actions', async () => {
    const { window, preview } = setup();
    window.AppShell.server = () => ({ name: '本机' });
    window.AppShell.workspace = () => ({ sessions: [{ name: '开发', windows: [{ name: '面板', panes: [{ id: '%1' }] }] }] });
    await preview.openFile('/w/p/README.html', '%1');
    await settle();
    const bar = window.document.querySelector('.ad-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.ad-source').textContent).toBe('来自 本机 / 开发 / 面板 / 窗格');
    expect(bar.querySelector('.ad-chip')).toBeNull();
    expect(bar.querySelector('button')).toBeNull();
    preview._test.dockCurrent();
    expect(window.document.querySelector('.fp-dock .ad-source').textContent).toContain('窗格');
  });

  it('keeps a source bar when agent document metadata is unavailable and uses the source server', async () => {
    const { window, preview } = setup();
    window.AppShell.server = id => ({ name: id === 'remote' ? '开发机' : '本机' });
    window.AppShell.workspace = id => id === 'remote'
      ? { sessions: [{ name: '采集', windows: [{ name: '任务', panes: [{ id: '%7' }] }] }] } : null;
    window.Blocks.ui.client = () => ({ get: async () => { throw new Error('not installed'); } });
    await preview.openFile('/remote/notes.html', '%7', { source: { serverId: 'remote', paneId: '%7' } });
    await settle();
    const bar = window.document.querySelector('.ad-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.ad-source').textContent).toBe('来自 开发机 / 采集 / 任务 / 窗格');
  });

  it('does not choose a session for a linked window with several owners', async () => {
    const { window, preview } = setup();
    window.AppShell.server = () => ({ name: '本机' });
    window.AppShell.workspace = () => ({ sessions: ['开发', '检查'].map(name => ({ name, windows: [{ name: '面板', panes: [{ id: '%1' }] }] })) });
    await preview.openFile('/w/p/README.html', '%1'); await settle();
    expect(window.document.querySelector('.ad-source').textContent).toBe('来自 本机 / 面板 / 窗格');
  });

  it('shows the source of a directory clicked in a pane', async () => {
    const { window, preview, fetch } = setup();
    fetch.mockImplementation(async url => ({ status: 200, json: async () => ({ success: true, data: String(url).includes('/info')
      ? { absPath: '/w', isDirectory: true, mtimeMs: 1 } : { absPath: '/w', parent: '/', entries: [], truncated: false } }) }));
    await preview.openFile('/w', '%1'); await settle();
    expect(window.document.querySelector('.ad-source')?.textContent).toBe('来自窗格');
  });

  it('keeps the bar hidden when an ordinary file has no source pane', async () => {
    const { window, preview } = setup();
    await preview.openFile('/w/p/README.html', null, { source: { serverId: 'local', paneId: null } });
    await settle();
    expect(window.document.querySelector('.ad-bar').hidden).toBe(true);
  });

  it('retains the ordinary source bar when opened directly in the dock', async () => {
    const { window, preview } = setup();
    await preview.openDocked('/w/p/README.html', '%1');
    await settle();
    expect(window.document.querySelector('.fp-dock .ad-bar').hidden).toBe(false);
    expect(window.document.querySelector('.fp-dock .ad-source').textContent).toBe('来自窗格');
  });
});
