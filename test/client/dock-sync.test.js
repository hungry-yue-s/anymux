import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const INSTANCE = '1873:1700000000';
const apiSource = readFileSync('plugins/ui/client/js/api.js', 'utf8');
const dockSyncSource = readFileSync('plugins/dock/client/js/dock-sync.js', 'utf8');
const previewSource = readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
const hostSource = readFileSync('plugins/ui/client/js/block-host.js', 'utf8');
const notifSource = readFileSync('plugins/notifications/client/js/notifications.js', 'utf8');

const doms = [];
afterEach(() => {
  while (doms.length) doms.pop().window.close();
});

function createClient({ serverState = null, serverStatus = 200, storage = {}, context = ['local', '@0'] } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div class="ms-app mode-terminal"><main class="ms-main"><div class="terminal-view"></div></main></div>'
      + '<div class="tree-window-row" data-server-id="local" data-window="@5" data-window-index="5"><button class="tree-item">review</button></div></body>',
    { url: 'https://panel.test/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  doms.push(dom);
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: 1440, configurable: true });
  Object.entries(storage).forEach(([k, v]) => win.localStorage.setItem(k, v));

  const apiPosts = [];
  const fileFetches = [];
  const serverSnapshot = serverState || {
    version: 1,
    instanceId: INSTANCE,
    revision: 1,
    windows: {},
    serverBlocks: { revision: 0, activeKey: null, items: [] },
    notices: [],
  };

  win.fetch = vi.fn(async (url, init = {}) => {
    const parsed = new URL(String(url), 'https://panel.test/');
    const path = parsed.pathname;
    if (path.startsWith('/api/dock')) {
      if (serverStatus !== 200) {
        return {
          ok: false,
          status: serverStatus,
          json: async () => ({ success: false, data: null, error: 'HTTP ' + serverStatus }),
        };
      }
      if ((init.method || 'GET').toUpperCase() === 'POST') {
        const body = init.body ? JSON.parse(init.body) : {};
        apiPosts.push({ path, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { changed: true, revision: ++serverSnapshot.revision, ...serverSnapshot }, error: null }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: JSON.parse(JSON.stringify(serverSnapshot)), error: null }),
      };
    }
    if (path.startsWith('/api/files/')) {
      const filePath = parsed.searchParams.get('path') || '/tmp/a.md';
      if (path.endsWith('/info')) {
        fileFetches.push(filePath);
        if (filePath.includes('missing')) {
          return { status: 404, json: async () => ({ success: false, error: 'File not found' }) };
        }
        return { status: 200, json: async () => ({ success: true, data: { absPath: filePath, isText: true, language: 'markdown', size: 12, mtimeMs: 1 } }) };
      }
      if (path.endsWith('/content')) {
        return { status: 200, json: async () => ({ success: true, data: { content: '# ' + filePath, language: 'markdown' } }) };
      }
    }
    throw new Error('Unexpected fetch: ' + url);
  });

  win.AppShell = {
    workspace: () => ({
      provider: 'tmux',
      complete: true,
      instanceId: INSTANCE,
      sessions: [{ id: '$1', name: 'work', windows: [{ id: '@0', panes: [{ id: '%1' }] }, { id: '@5', panes: [{ id: '%7' }] }] }],
    }),
  };

  win.eval(apiSource);
  win.eval(dockSyncSource);
  win.eval(previewSource);
  win.eval(hostSource);
  win.eval(notifSource);

  win.BlockHost.register('git', {
    title: 'Git',
    icon: 'git',
    perWindow: true,
    key: (p) => (p.path && p.path !== '.' ? p.path : 'pane:' + (p.paneId || '')),
    create: (api) => {
      const el = win.document.createElement('div');
      el.textContent = 'git:' + (api.params.path || '.');
      return { el, update: (next) => { el.textContent = 'git:' + (next.path || '.'); } };
    },
  });

  if (context) win.FilePreview.switchDockContext(context[0], context[1], INSTANCE);
  return { win, doc: win.document, apiPosts, fileFetches, serverSnapshot };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('DockSync client integration', () => {
  it('syncs window changes to another browser without overwriting local hidden/width prefs or echoing ops', async () => {
    const a = createClient();
    const b = createClient();

    await a.win.DockSync.syncServer('local');
    await b.win.DockSync.syncServer('local');

    // Client B hides its own dock locally
    await b.win.FilePreview.openDocked('/tmp/shared.md', '%1');
    b.win.document.querySelector('[aria-label="隐藏右侧预览"]').click();
    await flush();
    expect(b.doc.querySelector('.fp-dock')).toBeNull();

    // Client A sends a dock-changed event (as relayed over WS from server)
    const beforeBPosts = b.apiPosts.length;
    b.win.DockSync.handleServerEvent({
      type: 'dock-changed',
      serverId: 'local',
      scope: 'window',
      windowId: '@0',
      instanceId: INSTANCE,
      revision: 2,
      originClientId: a.win.DockSync.clientId(),
      window: {
        revision: 2,
        activeKey: 'file:/tmp/second.md',
        order: ['file:/tmp/shared.md', 'file:/tmp/second.md'],
        items: [
          { type: 'file', key: 'file:/tmp/shared.md', path: '/tmp/shared.md', paneId: '%1' },
          { type: 'file', key: 'file:/tmp/second.md', path: '/tmp/second.md', paneId: '%1' },
        ],
      },
    });
    await flush();

    // B stays collapsed (local viewport pref preserved) and received both tabs without sending ops back
    expect(b.doc.querySelector('.fp-dock')).toBeNull();
    expect(b.doc.querySelector('.fp-dock-restore').textContent).toContain('2');
    expect(b.apiPosts.length).toBe(beforeBPosts);

    // Expanding B shows both tabs
    b.doc.querySelector('.fp-dock-restore').click();
    await flush();
    expect([...b.doc.querySelectorAll('.fp-dock-tab-label')].map((n) => n.textContent)).toEqual(['shared.md', 'second.md']);

    // Event from same originClientId is ignored cleanly
    b.win.DockSync.handleServerEvent({
      type: 'dock-changed',
      serverId: 'local',
      scope: 'window',
      windowId: '@0',
      instanceId: INSTANCE,
      revision: 3,
      originClientId: b.win.DockSync.clientId(),
      window: null,
    });
    expect(b.doc.querySelectorAll('.fp-dock-tab')).toHaveLength(2);
  });

  it('hydrates offline-delivered files, Git blocks, and preview notices upon connecting', async () => {
    const serverState = {
      version: 1,
      instanceId: INSTANCE,
      revision: 4,
      windows: {
        '@0': {
          revision: 1,
          activeKey: 'file:/tmp/offline.md',
          order: ['file:/tmp/offline.md', 'block:git:/repo'],
          items: [
            { type: 'file', key: 'file:/tmp/offline.md', path: '/tmp/offline.md', paneId: '%1', unread: true, automatic: true },
            { type: 'block', key: 'block:git:/repo', kind: 'git', persistKey: 'git:/repo', params: { path: '/repo' }, mode: 'dock' },
          ],
        },
      },
      serverBlocks: { revision: 0, activeKey: null, items: [] },
      notices: [
        {
          id: 'git-offline',
          type: 'git',
          path: '/repo',
          commit: 'WORKTREE',
          message: '工作区有 2 处待审阅变更',
          read: false,
          reminderSeen: false,
          timestamp: Date.now(),
          target: { instanceId: INSTANCE, windowId: '@5', sessionId: '$1', paneId: '%7' },
        },
      ],
    };

    const client = createClient({ serverState });
    await client.win.DockSync.syncServer('local');
    await flush();

    expect([...client.doc.querySelectorAll('.fp-dock-tab-label')].map((n) => n.textContent)).toEqual(['offline.md', 'Git']);
    expect(client.doc.querySelector('[data-window="@5"] .preview-window-notice')).not.toBeNull();
  });

  it('performs one-time cold import of localStorage data and degrades gracefully on 404/501', async () => {
    const key = 'tmux_file_preview_dock_v4:' + encodeURIComponent('local\u0000' + INSTANCE + '\u0000@0');
    const local = createClient({
      storage: {
        [key]: JSON.stringify({
          version: 1,
          tabs: [{ path: '/tmp/legacy.md', paneId: '%1' }],
          activePath: '/tmp/legacy.md',
          width: 460,
          hidden: false,
        }),
      },
    });
    await local.win.DockSync.syncServer('local');
    expect(local.apiPosts.some((p) => p.path === '/api/dock/import')).toBe(true);

    // 404 legacy Node marks unsupported and skips further dock ops
    const oldNode = createClient({ serverStatus: 404 });
    await oldNode.win.DockSync.syncServer('local');
    expect(oldNode.win.DockSync.isSupported('local')).toBe(false);
    await oldNode.win.FilePreview.openDocked('/tmp/local-only.md', '%1');
    expect(oldNode.apiPosts).toHaveLength(0);
  });

  it('lazy-loads only the active file tab on restore and fetches background tabs on demand', async () => {
    const key = 'tmux_file_preview_dock_v4:' + encodeURIComponent('local\u0000' + INSTANCE + '\u0000@0');
    const client = createClient({
      context: null,
      storage: {
        [key]: JSON.stringify({
          version: 1,
          tabs: [
            { path: '/tmp/one.md', paneId: '%1' },
            { path: '/tmp/two.md', paneId: '%1' },
            { path: '/tmp/three.md', paneId: '%1' },
          ],
          activePath: '/tmp/two.md',
          width: 500,
          hidden: false,
        }),
      },
    });

    await client.win.FilePreview.switchDockContext('local', '@0', INSTANCE);
    expect(client.fileFetches).toEqual(['/tmp/two.md']);
    expect([...client.doc.querySelectorAll('.fp-dock-tab')].map((n) => n.textContent)).toEqual(['one.md', 'two.md', 'three.md']);

    // Clicking a background tab hydrates it on demand
    client.doc.querySelectorAll('.fp-dock-tab')[2].click();
    await flush();
    expect(client.fileFetches).toEqual(['/tmp/two.md', '/tmp/three.md']);
  });

  it('persists hidden state for block-only docks and cleans up all server keys on forgetServer', async () => {
    const first = createClient();
    first.win.BlockHost.open('git', { path: '/repo' });
    await flush();
    first.win.FilePreview.blockDock.hide();
    const prefsRaw = first.win.localStorage.getItem('anymux_dock_prefs_v1');
    const blocksRaw = first.win.localStorage.getItem('anymux_window_blocks_v1:' + encodeURIComponent('local\u0000' + INSTANCE + '\u0000@0'));
    expect(prefsRaw).toBeTruthy();

    // Reload with block-only prefs saved as hidden
    const reloaded = createClient({
      storage: {
        anymux_dock_prefs_v1: prefsRaw,
        ['anymux_window_blocks_v1:' + encodeURIComponent('local\u0000' + INSTANCE + '\u0000@0')]: blocksRaw,
      },
    });
    reloaded.win.BlockHost.render();
    await flush();
    expect(reloaded.doc.querySelector('.fp-dock')).toBeNull();
    expect(reloaded.doc.querySelector('.fp-dock-restore')).not.toBeNull();

    // forgetServer clears all local keys for that server
    reloaded.win.FilePreview.forgetServer('local');
    reloaded.win.BlockHost.forgetServer('local');
    reloaded.win.DockSync.forgetServer('local');
    const remaining = Array.from({ length: reloaded.win.localStorage.length }, (_, i) => reloaded.win.localStorage.key(i));
    expect(remaining.filter((k) => k.includes('local') || k === 'anymux_dock_prefs_v1' && reloaded.win.localStorage.getItem(k) !== '{}')).toEqual([]);
  });
});
