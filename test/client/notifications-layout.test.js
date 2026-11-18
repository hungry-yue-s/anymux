import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('plugins/notifications/client/js/notifications.js', 'utf8');
let dom;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.useRealTimers();
});

describe('window preview feedback', () => {
  function setup() {
    dom = new JSDOM('<div class="tree-session-group"><div class="tree-session-row" data-server-id="local" data-session="$1" data-entity-name="work"><button class="tree-item">work</button></div>'
      + '<div class="tree-window-list"><div id="source" class="tree-window-row" data-server-id="local" data-window="@5" data-window-index="5"><button class="tree-item">review</button></div>'
      + '<div id="other" class="tree-window-row" data-server-id="local" data-window="@0" data-window-index="0"><button class="tree-item">current</button></div></div></div>',
    { url: 'https://panel.example/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    win.Date.now = () => Date.now();
    let context = ['local', 'test:1', '@0'];
    win.FilePreview = { blockDock: { context: () => context.join('\0') } };
    win.Api = { activeServerId: () => 'local' };
    win.AppShell = { workspace: () => ({ instanceId: 'test:1' }) };
    win.api = { post: vi.fn(async () => ({})) };
    win.eval(source);
    const notice = { id: 'git-source', type: 'git', path: '/repo', commit: 'abcd1234', serverId: 'local', session: 'work', windowIndex: 5,
      windowName: 'review', message: '提交预览已加入所属窗口的侧栏：abcd1234', target: { serverId: 'local', sessionId: '$1', instanceId: 'test:1', windowId: '@5', paneId: '%7' } };
    return { win, panel: win.NotificationPanel, notice, visit: () => { context = ['local', 'test:1', '@5']; } };
  }

  it('puts a persistent View action on the exact source row and acknowledges a successful open', async () => {
    const { win, panel, notice } = setup();
    notice.type = 'document';
    const open = vi.fn(async () => true);
    panel.addPreview(notice, open);
    const row = win.document.querySelector('#source');
    const view = row.querySelector('.preview-window-view');
    expect(view?.textContent).toBe('查看');
    expect(win.document.querySelector('#other .preview-window-notice')).toBeNull();
    panel.syncAttention();
    expect(row.querySelector('.preview-window-view')).toBe(view);
    view.click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(open).toHaveBeenCalledOnce();
    expect(panel.unreadCount()).toBe(0);
    expect(row.querySelector('.preview-window-notice')).toBeNull();
    expect(win.api.post).not.toHaveBeenCalled();
  });

  it('stops pulsing after its deadline even when the sidebar keeps refreshing', () => {
    vi.useFakeTimers();
    const { win, panel, notice } = setup();
    panel.addPreview(notice, () => true);
    expect(win.document.querySelector('#source').classList.contains('notify-breathe')).toBe(true);
    vi.advanceTimersByTime(10000);
    panel.syncAttention(); panel.syncAttention();
    expect(win.document.querySelector('.notify-breathe')).toBeNull();
    expect(win.document.querySelector('#source .preview-window-notice')).not.toBeNull();
  });

  it('stops the source window animation when it is visited and clears a viewed preview', () => {
    const { win, panel, notice, visit } = setup();
    panel.addPreview(notice);
    visit(); panel.syncAttention();
    expect(win.document.querySelector('.notify-breathe')).toBeNull();
    panel.previewViewed({ type: 'git', path: '/repo', commit: 'abcd1234', contextKey: ['local', 'test:1', '@5'].join('\0') });
    expect(panel.unreadCount()).toBe(0);
    expect(JSON.parse(win.localStorage.getItem('anymux_document_notifications_v1'))[0].read).toBe(true);
  });

  it('attaches a collapsed window reminder to its session and preserves failed opens for retry', async () => {
    const { win, panel, notice } = setup();
    win.document.querySelector('.tree-window-list').remove();
    panel.addPreview(notice, async () => false);
    const view = win.document.querySelector('.tree-session-row .preview-window-view');
    expect(view).not.toBeNull();
    view.click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel.unreadCount()).toBe(1);
    expect(view.disabled).toBe(false);
  });

  it('closes the mobile workspace menu before opening a preview', async () => {
    const { win, panel, notice } = setup();
    win.AppShell.closeMobileWorkspaceSheet = vi.fn();
    panel.addPreview(notice, async () => true);
    win.document.querySelector('.preview-window-view').click();
    expect(win.AppShell.closeMobileWorkspaceSheet).toHaveBeenCalledWith({ restoreFocus: false });
  });

  it('finds a moved window in its current collapsed session', () => {
    const { win, panel, notice } = setup();
    win.document.querySelector('.tree-window-list').remove();
    win.document.querySelector('.tree-session-row').dataset.session = '$9';
    win.AppShell.workspace = () => ({ instanceId: 'test:1', sessions: [{ id: '$9', windows: [{ id: '@5' }] }] });
    panel.addPreview(notice, async () => true);
    expect(win.document.querySelector('.tree-session-row .preview-window-view')).not.toBeNull();
  });
});

describe('notification viewport layout', () => {
  it('restores Git preview notices with their exact commit and local read state', async () => {
    dom = new JSDOM('<button class="workspace-notification">通知</button>', { url: 'https://panel.example/', runScripts: 'outside-only' });
    const win = dom.window;
    win.api = { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(async () => ({})) };
    win.Blocks = { openGitNotice: vi.fn() };
    win.eval(source);
    win.NotificationPanel.addPreview({ id: 'git-local-abcd', type: 'git', path: '/repo', commit: 'abcd1234', serverId: 'local', target: { instanceId: 'test:1', windowId: '@5' }, message: '已打开提交预览：abcd1234' });
    win.eval(source);
    await win.NotificationPanel.refresh();
    win.NotificationPanel._markReadByWindow('', 0);
    expect(win.NotificationPanel.unreadCount()).toBe(1);
    win.NotificationPanel.render();
    win.document.querySelector('.notification-item').click();
    expect(win.Blocks.openGitNotice).toHaveBeenCalledWith(expect.objectContaining({ commit: 'abcd1234' }));
    expect(win.api.post).not.toHaveBeenCalled();
    win.NotificationPanel.previewViewed({ type: 'git', path: '/repo', commit: 'abcd1234', contextKey: ['local', 'test:1', '@5'].join('\0') });
    win.eval(source);
    expect(win.NotificationPanel.unreadCount()).toBe(0);
  });

  it('does not acknowledge document tabs just because a same-named terminal window is visited', () => {
    dom = new JSDOM('<button class="workspace-notification">通知</button>', { url: 'https://panel.example/', runScripts: 'outside-only' });
    const win = dom.window;
    win.Api = { activeServerId: () => 'local' };
    win.api = { post: vi.fn(async () => ({})) };
    win.eval(source);
    win.NotificationPanel.addDocument({ id: 'remote-doc', path: '/remote/new.md', session: 'work', windowIndex: 0, serverId: 'remote' });
    win.NotificationPanel._markReadByWindow('work', 0);
    expect(win.NotificationPanel.unreadCount()).toBe(1);
    expect(win.api.post).not.toHaveBeenCalled();
  });

  it('keeps document notices across server refreshes and reloads, and opens their original target', async () => {
    dom = new JSDOM('<button class="workspace-notification">通知</button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    win.api = { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(async () => ({})) };
    win.eval(source);
    const open = vi.fn();
    win.NotificationPanel.addDocument({ id: 'doc-local-5', path: '/w/new.md', message: '文档已加入所属窗口',
      serverId: 'local', windowId: '@5', paneId: '%7', timestamp: Date.now() }, open);
    win.NotificationPanel.addDocument({ id: 'doc-local-5', path: '/w/new.md', message: '文档已加入所属窗口' }, open);
    await win.NotificationPanel.refresh();
    expect(win.NotificationPanel.unreadCount()).toBe(1);
    win.NotificationPanel.render();
    expect(win.document.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(win.document.querySelector('.notification-item-command').textContent).toContain('new.md');
    win.document.querySelector('.notification-item').click();
    expect(open).toHaveBeenCalledOnce();
    expect(win.api.post).not.toHaveBeenCalled();
    win.eval(source);
    expect(win.NotificationPanel.unreadCount()).toBe(0);
    win.NotificationPanel.render();
    expect(win.document.querySelector('.notification-item-command').textContent).toContain('new.md');
  });

  it('anchors delegated desktop clicks to the actual toolbar and keeps clear-all clickable after rerender', async () => {
    dom = new JSDOM('<button class="notification-bell" hidden></button><button class="workspace-notification" data-action="notifications">通知</button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    const bell = win.document.querySelector('.workspace-notification');
    bell.getBoundingClientRect = () => ({ left: 980, right: 1008, top: 8, bottom: 36, width: 28, height: 28 });
    win.api = { post: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) };
    win.eval(source);
    win.NotificationPanel.handleServerPush([{ id: 'n1', session: 'work', windowIndex: 1, timestamp: Date.now() }]);
    win.NotificationPanel.render({ currentTarget: win.document, stopPropagation: vi.fn() }, bell);
    const panel = win.document.getElementById('notification-panel');
    expect(panel.style.top).toBe('40px');
    expect(parseFloat(panel.style.left) + 360).toBeLessThanOrEqual(win.innerWidth - 12);
    await new Promise(resolve => win.setTimeout(resolve, 15));
    panel.querySelector('.notification-clear-btn').click();
    expect(win.api.delete).toHaveBeenCalledExactlyOnceWith('/api/notifications');
    expect(win.NotificationPanel.unreadCount()).toBe(0);
    expect(panel.isConnected).toBe(true);
    expect(panel.textContent).toContain('暂无通知');
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.isConnected).toBe(false);
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    expect(win.document.activeElement).toBe(bell);
  });

  it('uses a visible modern bell for shortcut opens and closes listeners on a rapid toggle', async () => {
    dom = new JSDOM('<button class="notification-bell" hidden></button><button class="workspace-notification"></button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    const bell = win.document.querySelector('.workspace-notification');
    bell.getClientRects = () => [{}];
    bell.getBoundingClientRect = () => ({ left: 900, top: 8, bottom: 36 });
    win.eval(source);
    win.NotificationPanel.render();
    expect(win.document.getElementById('notification-panel').style.top).toBe('40px');
    win.NotificationPanel.render();
    await new Promise(resolve => win.setTimeout(resolve, 15));
    expect(win.document.getElementById('notification-panel')).toBeNull();
    expect(() => win.document.body.click()).not.toThrow();
  });

  it.each([
    { width: 844, mobile: true, sheet: true },
    { width: 844, mobile: false, sheet: false },
    { width: 375, mobile: undefined, sheet: true },
    { width: 1024, mobile: undefined, sheet: false },
  ])('uses the shared viewport decision at $width px (MobileUI=$mobile)', ({ width, mobile, sheet }) => {
    dom = new JSDOM('<div id="sidebar" hidden><button class="notification-bell"></button></div><button id="visible-bell" class="notification-bell"></button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    win.innerWidth = width;
    if (mobile !== undefined) win.MobileUI = { isMobile: vi.fn(() => mobile) };
    const hiddenBell = win.document.querySelector('#sidebar .notification-bell');
    hiddenBell.getBoundingClientRect = vi.fn(() => ({ left: 0, bottom: 0 }));
    const visibleBell = win.document.getElementById('visible-bell');
    visibleBell.getBoundingClientRect = vi.fn(() => ({ left: 120, bottom: 60 }));
    win.eval(source);
    const stopPropagation = vi.fn();
    win.NotificationPanel.render({ currentTarget: visibleBell, stopPropagation });

    const panel = win.document.getElementById('notification-panel');
    expect(panel.classList.contains('notification-mobile-sheet')).toBe(sheet);
    expect(Boolean(win.document.getElementById('notification-sheet-overlay'))).toBe(sheet);
    expect(hiddenBell.getBoundingClientRect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    if (mobile !== undefined) expect(win.MobileUI.isMobile).toHaveBeenCalledOnce();
    if (!sheet) {
      expect(panel.style.top).toBe('64px');
      expect(panel.style.left).toBe('120px');
      expect(visibleBell.getBoundingClientRect).toHaveBeenCalledOnce();
    }
    const icon = panel.querySelector('.notification-panel-title svg');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('stroke')).toBe('currentColor');
    expect(panel.textContent).not.toContain('🔔');
  });
});
