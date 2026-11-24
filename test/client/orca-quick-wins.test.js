import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import express from 'express';
import request from 'supertest';
import { apply as applyAgentEvents } from '../../plugins/agent-events/index.js';

const source = (path) => readFileSync(path, 'utf8');
const windows = [];
afterEach(() => windows.splice(0).forEach((w) => w.close()));

function setupAppDom() {
  const dom = new JSDOM('<!doctype html><body><button id="ms-needs-you-pill" data-action="notifications" hidden></button><button class="workspace-notification"><span class="notification-bell-count">0</span></button><div id="tree"></div></body>', {
    url: 'https://panel.test/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  windows.push(w);
  w.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w.api = { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) };
  w.Api = { activeServerId: () => 'local', nodeUrl: (_id, p) => p };
  w.Auth = { headers: () => ({ Authorization: 'Bearer tok' }) };
  w.AppShell = { toast: vi.fn(), workspace: () => null };
  w.navigate = vi.fn();
  return w;
}

describe('Orca zero-wheel quick wins', () => {
  it('Quick Win 1: surfaces Needs-You queue, topbar pill, jump-to-pane, and prefills reply WITHOUT Enter', async () => {
    const w = setupAppDom();
    w.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    w.Workbench = { selectPane: vi.fn() };
    w.eval(source('plugins/notifications/client/js/notifications.js'));

    w.NotificationPanel.handleServerPush([
      { id: 'n1', type: 'agent-event', state: 'waiting_attention', source: 'claude', session: 'work', windowIndex: 0, windowName: 'dev', paneId: '%5', reason: 'Allow bash?', timestamp: Date.now(), read: false },
      { id: 'n2', type: 'agent-event', state: 'agent_stopped', source: 'codex', session: 'work', windowIndex: 1, windowName: 'done', paneId: '%6', timestamp: Date.now(), read: false },
    ]);

    expect(w.NotificationPanel.needsYou().map((n) => n.id)).toEqual(['n1']);
    const pill = w.document.getElementById('ms-needs-you-pill');
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toContain('1');

    // Open NotificationPanel and submit inline reply with accidental trailing newline -> stripped, NEVER Enter!
    w.NotificationPanel.render(null, w.document.querySelector('.workspace-notification'));
    const input = w.document.querySelector('.notification-reply-input');
    input.value = 'approve tool use\r\n';
    w.document.querySelector('.notification-reply-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledOnce());
    const [url, init] = w.fetch.mock.calls[0];
    expect(url).toBe('/api/agent-docs/reply');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ paneId: '%5', text: 'approve tool use' });
    expect(body.text).not.toMatch(/[\r\n]/);
    expect(w.Workbench.selectPane).toHaveBeenCalledWith('%5');
  });

  it('Quick Win 2: emits background WORKTREE open-git event on agent_stopped in dirty git repo without stealing focus', async () => {
    const emitted = [];
    const app = express();
    app.use(express.json());
    const ctx = {
      http: { mount: (prefix, router) => app.use(prefix, router) },
      inject: () => {},
      emit: (name, payload) => emitted.push({ name, payload }),
      provide: () => {},
    };
    applyAgentEvents(ctx, {
      inspectDirtyWorktree: async (cwd) => cwd === '/repo/dirty' ? { repoRoot: '/repo/dirty', dirtyCount: 3 } : null,
    });

    await request(app).post('/api/agent-events').send({
      event: 'Stop',
      source: 'claude',
      paneId: '%3',
      windowId: '@2',
      cwd: '/repo/dirty',
    }).expect(200);

    await vi.waitFor(() => expect(emitted.some((e) => e.name === 'status/event')).toBe(true));
    const gitEvt = emitted.find((e) => e.name === 'status/event').payload;
    expect(gitEvt).toEqual({
      type: 'open-git',
      path: '/repo/dirty',
      commit: 'WORKTREE',
      dirtyCount: 3,
      paneId: '%3',
      windowId: '@2',
      activate: false,
    });
  });

  it('Quick Win 3: groups sidebar windows by project cwd basename and toggles session/project view', () => {
    const w = setupAppDom();
    w.eval(source('plugins/ui/client/js/slots.js'));
    w.eval(source('plugins/ui/client/js/router.js'));
    w.eval(source('plugins/ui/client/js/store.js'));
    w.eval(source('plugins/ui/client/js/app-shell.js'));
    w.eval(source('plugins/ui/client/js/ms-app.js'));

    w.Store.setWorkspace('local', {
      provider: 'tmux',
      instanceId: '1:1',
      actions: {},
      sessions: [
        { id: '$1', name: 'main', windows: [{ id: '@1', index: 0, name: 'api', panes: [{ id: '%1', cwd: '/Users/dev/anymux', command: 'node' }] }] },
        { id: '$2', name: 'bg', windows: [{ id: '@2', index: 0, name: 'tests', panes: [{ id: '%2', cwd: '/Users/dev/anymux', command: 'vitest' }] }] },
      ],
    });

    const tree = w.document.getElementById('tree');
    tree.innerHTML = w.AppShell._renderTree('local', { name: 'terminal', params: { serverId: 'local' } });
    expect(tree.querySelectorAll('.tree-session-group')).toHaveLength(2);

    // Switch to project directory grouping mode
    w.Store.setUi({ sidebarGroupMode: 'project' });
    tree.innerHTML = w.AppShell._renderTree('local', { name: 'terminal', params: { serverId: 'local' } });
    const projectGroups = tree.querySelectorAll('.tree-project-group');
    expect(projectGroups).toHaveLength(1);
    expect(projectGroups[0].querySelector('.tree-project-head').textContent).toContain('anymux');
    expect(projectGroups[0].querySelectorAll('.tree-window-row')).toHaveLength(2);
  });
});
