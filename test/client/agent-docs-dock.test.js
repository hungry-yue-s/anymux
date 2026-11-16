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
    + '<textarea class="xterm-helper-textarea"></textarea></div></main></div>', { url: 'https://panel.test/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width });
  const fetch = vi.fn(async (url) => {
    const parsed = new URL(url, window.location.href);
    const path = parsed.searchParams.get('path');
    if (parsed.pathname.endsWith('/info')) {
      return { status: 200, json: async () => ({ success: true, data: { absPath: path, isText: true, language: 'html', size: 10, mtimeMs: 1 } }) };
    }
    if (parsed.pathname.endsWith('/content')) {
      return { status: 200, json: async () => ({ success: true, data: { content: '<h1>' + path + '</h1>', language: 'html' } }) };
    }
    throw new Error('Unexpected fetch: ' + url);
  });
  const toast = vi.fn();
  const sent = [];
  const openers = {};
  window.Api = { activeServerId: () => 'local', nodeUrl: (_serverId, path) => path };
  window.AppShell = { workspace: () => ({ sessions: [{ id: '$1', windows: [
    { id: '@0', panes: [{ id: '%1' }, { id: '%2' }] },
    { id: '@5', panes: [{ id: '%7' }] },
  ] }] }) };
  window.PanelSlots = { commands: { register() {} }, openers: { register(opener) { openers[opener.id] = opener; } } };
  window.BlockHost = {};
  window.Blocks = {
    icon: () => '',
    rendererFor: () => null,
    ui: {
      el: (tag) => window.document.createElement(tag), button: () => window.document.createElement('button'),
      iconButton: () => window.document.createElement('button'), errorText: String, toast,
      currentContext: () => ({ serverId: 'local', paneId: '%2', onTerminal: true }),
      selectedContext: () => ({ serverId: 'local', paneId: '%2' }),
      client: () => ({
        get: vi.fn(async (path, params) => ({ path: params.path, doc: docInfo })),
        send: vi.fn(async (method, path, body) => { sent.push([method, path, body]); return {}; }),
      }),
    },
  };
  new Function('window', 'document', 'fetch', 'Auth', previewSource)(window, window.document, fetch, undefined);
  window.eval(commandsSource);
  window.eval(barSource);
  window.FilePreview.switchDockContext('local', '@0', INSTANCE);
  const typing = window.document.querySelector('.xterm-helper-textarea');
  typing.focus();
  return { window, preview: window.FilePreview, openers, toast, sent, typing, fetch };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const tabs = (window) => Array.from(window.document.querySelectorAll('.fp-dock .fp-dock-tab-item')).map((item) => ({
  name: item.querySelector('.fp-dock-tab-label').textContent,
  active: item.classList.contains('active'),
  unread: item.classList.contains('is-unread'),
}));
const modals = (window) => window.document.querySelectorAll('.fp-overlay:not(.fp-dock)').length;

describe('opening a document straight into the dock', () => {
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
  it('dock only for the window in view; elsewhere a notice opens them on request', async () => {
    const { window, openers, toast, preview } = setup();
    const run = (event) => openers['open-file'].run({ type: 'open-file', placement: 'dock', activate: true, ...event });
    const docked = vi.spyOn(preview, 'openDocked');
    run({ path: '/w/p/.anymux/docs/here.html', paneId: '%1', kind: 'draft' });
    await settle(); await settle();
    expect(docked).toHaveBeenCalledWith('/w/p/.anymux/docs/here.html', '%1', expect.objectContaining({ activate: true }));
    expect(toast).not.toHaveBeenCalled();

    run({ path: '/w/p/docs/superpowers/plans/there.md', paneId: '%7', paneIds: ['%7'], kind: 'plan' });
    expect(docked).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('计划：there.md', expect.objectContaining({ action: expect.objectContaining({ label: '打开' }) }));
    run({ path: '/w/p/docs/superpowers/plans/there.md', paneId: '%7', paneIds: ['%7'], kind: 'plan' });
    expect(toast).toHaveBeenCalledTimes(1);
    run({ path: '/w/p/.superpowers/sdd/x/progress.md', paneId: '%7', activate: false, kind: 'progress' });
    expect(toast).toHaveBeenCalledTimes(1);

    // A watcher event names every pane in the project; one of them is in view.
    run({ path: '/w/p/.anymux/docs/project.html', paneId: '%7', paneIds: ['%7', '%2'] });
    await settle(); await settle();
    expect(docked).toHaveBeenCalledTimes(2);
    expect(window.document.querySelectorAll('.fp-dock-tab-item')).toHaveLength(2);

    // Without placement it is the old modal.
    openers['open-file'].run({ type: 'open-file', path: '/w/p/plain.html', paneId: '%1' });
    await settle();
    expect(modals(window)).toBe(1);
  });
});

describe('the bar above an agent document', () => {
  it('shows kind and pane, and types replies into the pane without sending them', async () => {
    const proposal = { status: 'proposed', target: 'docs/design.md', reason: '同类都在 docs/', alternatives: ['docs/d/x.md'], also: null };
    const { window, preview, sent, toast } = setup({ docInfo: { kind: 'draft', label: '草稿', owner: 'anymux', proposal } });
    await preview.openDocked('/w/p/.anymux/docs/design.html', '%1');
    await settle();
    const bar = window.document.querySelector('.fp-dock .ad-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.nextElementSibling.classList.contains('fp-body')).toBe(true);
    expect(bar.querySelector('.ad-chip').textContent).toBe('草稿');
    expect(bar.querySelector('.ad-source').textContent).toBe('来自窗格 %1');
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
    expect(toast).toHaveBeenCalledWith('已填入窗格 %1，在终端里补充后按回车发送', { error: false });
  });

  it('stays hidden for files that are not agent documents', async () => {
    const { window, preview } = setup();
    await preview.openDocked('/w/p/README.html', '%1');
    await settle();
    expect(window.document.querySelector('.fp-dock .ad-bar').hidden).toBe(true);
  });
});
