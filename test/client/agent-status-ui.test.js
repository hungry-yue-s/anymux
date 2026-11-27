import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (p) => readFileSync(p, 'utf8');
const doms = [];

afterEach(() => {
  while (doms.length) doms.pop().window.close();
});

function bootSidebarDom({ extraScripts = [] } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<button id="ms-needs-you-pill" hidden></button>'
    + '<button class="workspace-notification"><span class="notification-bell-count">0</span></button>'
    + '<div id="tree"></div>'
    + '</body></html>',
    { url: 'https://panel.test/', runScripts: 'outside-only' },
  );
  doms.push(dom);
  const w = dom.window;
  w.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w.api = { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) };
  w.Api = { activeServerId: () => 'local', nodeUrl: (_id, p) => p, get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) };

  w.eval(read('plugins/ui/client/js/slots.js'));
  w.eval(read('plugins/ui/client/js/router.js'));
  w.eval(read('plugins/ui/client/js/store.js'));
  w.eval(read('plugins/ui/client/js/agent-icons-data.js'));
  w.eval(read('plugins/ui/client/js/agent-status.js'));
  w.eval(read('plugins/ui/client/js/app-shell.js'));
  for (const s of extraScripts) w.eval(read(s));
  return w;
}

describe('AgentIcons & AgentStatus UI integration', () => {
  it('renders local inline SVGs and zero-textContent fallback icons without altering window text prefix', () => {
    const w = bootSidebarDom();
    w.Store.setWorkspace('local', {
      provider: 'tmux',
      instanceId: '1:1',
      actions: {},
      sessions: [
        {
          id: '$1',
          name: 'work',
          windows: [
            { id: '@1', index: 0, name: 'dev', panes: [{ id: '%1', command: 'claude', title: '⠹ Fixing UI', active: true }] },
            { id: '@2', index: 1, name: 'docs', panes: [{ id: '%2', command: 'unknowncmd', active: true }] },
            { id: '@3', index: 2, name: 'agy', panes: [{ id: '%3', command: 'agy', active: true }] },
          ],
        },
      ],
    });

    const tree = w.document.getElementById('tree');
    tree.innerHTML = w.AppShell._renderTree('local', { name: 'terminal', params: { serverId: 'local', sessionId: '$1', windowId: '@1' } });

    const rows = tree.querySelectorAll('.tree-window-row');
    expect(rows).toHaveLength(3);
    // Keep textContent invariant expected by app-shell tests
    expect(rows[0].querySelector('.tree-item').textContent.startsWith('dev')).toBe(true);
    expect(rows[1].querySelector('.tree-item').textContent.startsWith('docs')).toBe(true);

    // Expanded window row keeps rolled-up status icon and suppresses redundant parent app icon
    expect(rows[0].querySelector('.agent-state-ico.is-working .agent-spinner')).not.toBeNull();
    expect(rows[0].querySelector('.agent-app-icon')).toBeNull();
    expect(tree.querySelector('.tree-agent-list[data-window="@1"] .agent-app-icon.is-kind-claude svg')).not.toBeNull();
    // Single-pane unexpanded rows still show their app icon on the window row
    expect(rows[2].querySelector('.agent-app-icon.is-kind-antigravity img.agent-app-img')).not.toBeNull();
    // Letter fallback uses data-letter CSS pseudo-element so textContent stays empty
    const letterIcon = rows[1].querySelector('.agent-app-icon.is-letter');
    expect(letterIcon).not.toBeNull();
    expect(letterIcon.getAttribute('data-letter')).toBe('U');
    expect(letterIcon.textContent).toBe('');
  });

  it('renders session rollup indicator and Orca-style nested .tree-agent-row items with model, subagents, and time', () => {
    const w = bootSidebarDom();
    const now = Date.now() - 120_000;
    w.Store.setWorkspace('local', {
      provider: 'tmux',
      instanceId: '1:1',
      actions: {},
      sessions: [
        {
          id: '$1',
          name: 'orca-port',
          windows: [
            {
              id: '@1',
              index: 0,
              name: 'checkout',
              panes: [
                { id: '%1', index: 0, command: 'claude', active: true },
                { id: '%2', index: 1, command: 'codex', active: false },
              ],
            },
          ],
        },
      ],
    });

    w.AgentStatus.setSnapshot('local', {
      hasAgents: true,
      updatedAt: now,
      panes: {
        '%1': {
          paneId: '%1',
          agentType: 'claude',
          appKind: 'claude',
          status: 'working',
          shortModel: 'opus-4.5',
          prompt: 'Tighten validation',
          subagentCount: 3,
          unread: false,
          updatedAt: now,
        },
        '%2': {
          paneId: '%2',
          agentType: 'codex',
          appKind: 'codex',
          status: 'done',
          shortModel: 'gpt-5.3',
          prompt: 'Verify EU rules',
          subagentCount: 0,
          unread: true,
          updatedAt: now,
        },
      },
      windows: {
        '@1': { windowId: '@1', status: 'working', appKind: 'claude', agentCount: 2, unread: true, updatedAt: now },
      },
      sessions: {
        '$1': { sessionId: '$1', sessionName: 'orca-port', status: 'working', appKind: 'claude', agentCount: 2, unread: true, updatedAt: now },
      },
    });

    const tree = w.document.getElementById('tree');
    tree.innerHTML = w.AppShell._renderTree('local', { name: 'terminal', params: { serverId: 'local', sessionId: '$1', windowId: '@1' } });

    expect(tree.querySelector('.tree-session-status .agent-state-ico.is-working')).not.toBeNull();
    const agentRows = tree.querySelectorAll('.tree-agent-row');
    expect(agentRows).toHaveLength(2);
    expect(agentRows[0].dataset.pane).toBe('%1');
    expect(agentRows[0].querySelector('.agent-row-title').textContent).toBe('Tighten validation');
    expect(agentRows[0].querySelector('.agent-row-subagents').textContent).toBe('×3');
    expect(agentRows[0].querySelector('.agent-row-model').textContent).toBe('opus-4.5');
    expect(agentRows[0].querySelector('.agent-row-time').textContent).toBe('2m');
    expect(agentRows[1].classList.contains('is-done-unread')).toBe(true);
    expect(agentRows[1].querySelector('.agent-app-icon.is-kind-codex')).not.toBeNull();

    // Custom pane label matches pane header name even when agent prompt/title exists
    w.Store.setWorkspace('local', {
      provider: 'tmux',
      instanceId: '1:1',
      actions: {},
      sessions: [{
        id: '$1',
        name: 'orca-port',
        windows: [{
          id: '@1',
          index: 0,
          name: 'checkout',
          panes: [
            { id: '%1', index: 0, command: 'claude', label: '自更新', active: true },
            { id: '%2', index: 1, command: 'codex', active: false },
          ],
        }],
      }],
    });
    tree.innerHTML = w.AppShell._renderTree('local', { name: 'terminal', params: { serverId: 'local', sessionId: '$1', windowId: '@1' } });
    const namedRow = tree.querySelector('.tree-agent-row[data-pane="%1"]');
    expect(namedRow.querySelector('.agent-row-title').textContent).toBe('自更新');
    expect(namedRow.querySelector('.tree-agent-btn').getAttribute('title')).toContain('Tighten validation');

    // Acknowledge finished pane clears done unread and posts ack
    w.AgentStatus.acknowledge('local', { windowId: '@1', paneId: '%2', sessionId: '$1' });
    expect(w.AgentStatus.getPane('local', '%2').unread).toBe(false);
    expect(w.Api.post).toHaveBeenCalledWith('/api/agent-status/ack', { paneId: '%2', windowId: '@1', sessionId: '$1' });
  });

  it('merges zero-config attention panes into NotificationPanel.needsYou() and auto-clears stale items when working', async () => {
    const w = bootSidebarDom({ extraScripts: ['plugins/notifications/client/js/notifications.js'] });
    w.Store.setWorkspace('local', {
      provider: 'tmux',
      instanceId: '1:1',
      actions: {},
      sessions: [{ id: '$1', name: 'main', windows: [{ id: '@1', index: 0, name: 'dev', panes: [{ id: '%5', command: 'claude' }] }] }],
    });

    w.AgentStatus.setSnapshot('local', {
      hasAgents: true,
      panes: {
        '%5': { paneId: '%5', agentType: 'claude', status: 'permission', label: 'Allow bash tool', updatedAt: Date.now() },
      },
      windows: { '@1': { windowId: '@1', status: 'permission', agentCount: 1, unread: true } },
      sessions: { '$1': { sessionId: '$1', status: 'permission', agentCount: 1, unread: true } },
    });

    const waiting = w.NotificationPanel.needsYou();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ paneId: '%5', state: 'waiting_attention', _ephemeral: true });
    expect(w.document.getElementById('ms-needs-you-pill').hidden).toBe(false);

    // Ephemeral Needs-You items MUST still render in NotificationPanel when _notifications is empty,
    // and Jump / Reply / Dismiss must resolve the ephemeral card cleanly.
    const bell = w.document.createElement('button');
    w.document.body.appendChild(bell);
    w.NotificationPanel.render({ stopPropagation() {} }, bell);
    const panel = w.document.getElementById('notification-panel');
    expect(panel).not.toBeNull();
    expect(panel.querySelector('.notification-empty')).toBeNull();
    expect(panel.querySelector('.notification-needs-you-item')).not.toBeNull();

    // Prefill reply from ephemeral card resolves waitingList before _notifications
    w.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const replyInput = panel.querySelector('.notification-reply-input');
    replyInput.value = 'yes proceed';
    panel.querySelector('.notification-reply-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.fetch).toHaveBeenCalledWith(
      '/api/agent-docs/reply',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ paneId: '%5', text: 'yes proceed', serverInstance: '1:1' }) }),
    );

    // Dismiss button acknowledges attention pane and clears pill
    panel.querySelector('.notification-dismiss-btn').click();
    expect(w.NotificationPanel.needsYou()).toHaveLength(0);
    expect(w.Api.post).toHaveBeenCalledWith('/api/agent-status/ack', {
      paneId: '%5',
      windowId: '@1',
      sessionId: '$1',
      includeAttention: true,
    });
    w.NotificationPanel.close();

    // Also test stale persisted notification cleared when agent transitions back to working
    w.NotificationPanel.handleServerPush([
      { id: 'n99', type: 'agent-event', state: 'waiting_attention', source: 'claude', session: 'main', windowIndex: 0, paneId: '%5', timestamp: Date.now(), read: false },
    ]);
    w.AgentStatus.setSnapshot('local', {
      hasAgents: true,
      panes: { '%5': { paneId: '%5', agentType: 'claude', status: 'working', updatedAt: Date.now() } },
      windows: { '@1': { windowId: '@1', status: 'working', agentCount: 1, unread: false } },
      sessions: { '$1': { sessionId: '$1', status: 'working', agentCount: 1, unread: false } },
    });

    expect(w.NotificationPanel.needsYou()).toHaveLength(0);
    expect(w.document.getElementById('ms-needs-you-pill').hidden).toBe(true);
  });

  it('renders Orca 45-agent SVG & PNG library with zero external requests, zero textContent, and clean Unicode titles', () => {
    const w = bootSidebarDom();
    const expectedAgents = [
      'claude', 'claude-agent-teams', 'openclaude', 'codex', 'grok', 'copilot',
      'opencode', 'opencode2', 'mimo-code', 'ante', 'trae', 'muse', 'dsh',
      'qoder', 'qoder-cn', 'zcode', 'pi', 'omp', 'prime-agent', 'gemini',
      'antigravity', 'aider', 'goose', 'amp', 'kilo', 'kiro', 'crush', 'aug',
      'autohand', 'cline', 'codebuff', 'freebuff', 'command-code', 'continue',
      'cursor', 'droid', 'kimi', 'mistral-vibe', 'qwen-code', 'rovo', 'hermes',
      'devin', 'openclaw', 'codebuddy', 'jcode',
    ];

    const host = w.document.createElement('div');
    for (const id of expectedAgents) {
      host.innerHTML = w.AgentIcons.appIcon(id);
      const wrap = host.querySelector('.agent-app-icon');
      expect(wrap).not.toBeNull();
      expect(wrap.classList.contains('is-letter')).toBe(false);
      expect(wrap.classList.contains('is-agent')).toBe(true);
      expect(wrap.textContent).toBe('');
      const svg = wrap.querySelector('svg');
      const img = wrap.querySelector('img.agent-app-img');
      expect(Boolean(svg || img)).toBe(true);
      if (img) {
        expect(img.getAttribute('src').startsWith('data:image/png;base64,')).toBe(true);
      }
      if (svg) {
        expect(svg.querySelector('text')).toBeNull();
      }
    }

    // Aliases resolve properly
    host.innerHTML = w.AgentIcons.appIcon('agy');
    expect(host.querySelector('.agent-app-icon.is-kind-antigravity.is-img img.agent-app-img')).not.toBeNull();
    host.innerHTML = w.AgentIcons.appIcon('dsh-tui');
    expect(host.querySelector('.agent-app-icon.is-kind-dsh.is-img img.agent-app-img')).not.toBeNull();

    // Official vector icons match Orca viewBoxes & unique gradient IDs for omp
    host.innerHTML = w.AgentIcons.appIcon('claude');
    expect(host.querySelector('svg').getAttribute('viewBox')).toBe('0 0 24 24');
    host.innerHTML = w.AgentIcons.appIcon('codex');
    expect(host.querySelector('svg').getAttribute('viewBox')).toBe('0 0 24 24');
    host.innerHTML = w.AgentIcons.appIcon('omp') + w.AgentIcons.appIcon('omp');
    const grads = host.querySelectorAll('linearGradient');
    expect(grads).toHaveLength(2);
    expect(grads[0].id).not.toBe(grads[1].id);

    // Client-side detectFromPane treats ✦ as idle brand glyph (not spinner) and handles Braille spinner cleanly without splitting surrogate emoji
    const idleDsh = w.AgentIcons.detectFromPane({ id: '%1', command: 'node', agentType: 'dsh', title: '✦ 🐋 解释 MAS 的 HWID' });
    expect(idleDsh.status).toBe('idle');
    expect(idleDsh.label).toBe('🐋 解释 MAS 的 HWID');
    const noHint = w.AgentIcons.detectFromPane({ id: '%1', command: 'node', title: '✦ 🐋 解释 MAS 的 HWID' });
    expect(noHint.status).toBeNull();
    expect(noHint.label).toBe('🐋 解释 MAS 的 HWID');
    const workingDsh = w.AgentIcons.detectFromPane({ id: '%1', command: 'node', agentType: 'dsh', title: '⠐ 🐋 解释 MAS 的 HWID' });
    expect(workingDsh.status).toBe('working');
    expect(workingDsh.label).toBe('🐋 解释 MAS 的 HWID');
  });

  it('preserves working .agent-spinner DOM node across latency/updatedAt updates and phase-locks fresh spinners', () => {
    const w = bootSidebarDom();
    w.document.body.insertAdjacentHTML('beforeend', '<div class="server-context" id="ms-server-context"></div>');
    w.Store.setServers([{ id: 'local', name: 'local', kind: 'local' }]);
    w.Store.setHealth('local', { state: 'online', latencyMs: 12, capabilities: {} });
    const baseTs = Math.floor(Date.now() / 15000) * 15000 + 2000;
    w.Store.setWorkspace('local', {
      provider: 'tmux',
      instanceId: '1:1',
      actions: {},
      sessions: [{
        id: '$1',
        name: 'work',
        windows: [{ id: '@1', index: 0, name: 'dev', panes: [{ id: '%1', index: 0, command: 'agy', active: true }] }],
      }],
    });
    w.Store.setRoute({ name: 'terminal', params: { serverId: 'local', sessionId: '$1', windowId: '@1', paneId: '%1' } });
    w.AgentStatus.setSnapshot('local', {
      hasAgents: true,
      serverInstance: '1:1',
      updatedAt: baseTs,
      panes: {
        '%1': { paneId: '%1', agentType: 'antigravity', appKind: 'antigravity', status: 'working', prompt: '继续', shortModel: 'gemini-4', updatedAt: baseTs },
      },
      windows: { '@1': { windowId: '@1', status: 'working', appKind: 'antigravity', agentCount: 1, updatedAt: baseTs } },
      sessions: { '$1': { sessionId: '$1', sessionName: 'work', status: 'working', appKind: 'antigravity', agentCount: 1, updatedAt: baseTs } },
    });

    w.AppShell.render();
    const spinner = w.document.querySelector('#ms-server-context .agent-state-ico.is-working span.agent-spinner');
    expect(spinner).not.toBeNull();
    expect(spinner.querySelector('svg')).not.toBeNull();
    expect(spinner.style.animationDelay).toMatch(/^-\d+ms$/);

    // Deterministic SVG gradient UID when scoped
    expect(w.AgentIcons.appIcon('omp', 'pane-%1')).toBe(w.AgentIcons.appIcon('omp', 'pane-%1'));

    // Latency change + minor updatedAt tick within 15s bucket updates switcher only, preserving the exact spinner node
    w.Store.setHealth('local', { state: 'online', latencyMs: 48, capabilities: {} });
    w.AgentStatus.setSnapshot('local', {
      hasAgents: true,
      serverInstance: '1:1',
      updatedAt: baseTs + 3000,
      panes: {
        '%1': { paneId: '%1', agentType: 'antigravity', appKind: 'antigravity', status: 'working', prompt: '继续', shortModel: 'gemini-4', updatedAt: baseTs + 3000 },
      },
      windows: { '@1': { windowId: '@1', status: 'working', appKind: 'antigravity', agentCount: 1, updatedAt: baseTs + 3000 } },
      sessions: { '$1': { sessionId: '$1', sessionName: 'work', status: 'working', appKind: 'antigravity', agentCount: 1, updatedAt: baseTs + 3000 } },
    });
    w.AppShell.render();

    const sameSpinner = w.document.querySelector('#ms-server-context .agent-state-ico.is-working span.agent-spinner');
    expect(sameSpinner).toBe(spinner);
    expect(w.document.querySelector('#ms-server-context .server-switcher small').textContent).toContain('48ms');
  });
});
