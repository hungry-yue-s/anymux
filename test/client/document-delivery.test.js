import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
afterEach(() => { dom?.window.close(); vi.useRealTimers(); });

describe('document delivery feedback', () => {
  it('stores dock events in hidden browser tabs using the socket source server', () => {
    const app = readFileSync('plugins/ui/client/js/app.js', 'utf8');
    const source = app.slice(app.indexOf('class StatusSocket {'), app.indexOf('var statusSocket ='));
    const sockets = [];
    class Socket { constructor() { sockets.push(this); } }
    let activeServer = 'remote';
    const Api = { activeServerId: () => activeServer, activeUrl: path => '/n/remote' + path };
    const opener = { run: vi.fn() };
    const StatusSocket = new Function('WebSocket', 'Api', 'Auth', 'location', 'document', 'PanelSlots',
      source + '; return StatusSocket;')(Socket, Api, { wsTokenParam: () => '' }, { protocol: 'https:', host: 'panel.test' },
      { visibilityState: 'hidden' }, { openers: { get: () => opener } });
    new StatusSocket().connect();
    activeServer = 'local';
    sockets[0].onmessage({ data: JSON.stringify({ type: 'open-file', placement: 'dock', path: '/w/new.md' }) });
    expect(opener.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ serverId: 'remote', path: '/w/new.md' }));
    sockets[0].onmessage({ data: JSON.stringify({ type: 'open-file', path: '/w/manual.md' }) });
    sockets[0].onmessage({ data: JSON.stringify({ type: 'open-url', url: 'https://example.test' }) });
    expect(opener.run).toHaveBeenCalledOnce();
    sockets[0].onmessage({ data: JSON.stringify({ type: 'open-git', path: '/repo', paneId: '%1', commit: 'abcd1234' }) });
    expect(opener.run).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'open-git', serverId: 'remote', commit: 'abcd1234' }));
  });

  it('keeps document feedback visible while hovered or focused and offers an explicit close button', () => {
    vi.useFakeTimers();
    dom = new JSDOM('<div id="ms-toast" class="ms-toast"></div>', { url: 'https://panel.test', runScripts: 'outside-only' });
    const win = dom.window;
    const source = readFileSync('plugins/ui/client/js/blocks-kit.js', 'utf8');
    new Function('window', 'document', source + '; window.Blocks = Blocks;')(win, win.document);
    const host = win.document.getElementById('ms-toast');
    win.Blocks.ui.toast('已打开文档', { duration: 15000, dismissible: true, action: { label: '查看文档', run() {} } });
    vi.advanceTimersByTime(6001);
    expect(host.classList.contains('show')).toBe(true);
    host.onpointerenter();
    vi.advanceTimersByTime(30000);
    expect(host.classList.contains('show')).toBe(true);
    host.onpointerleave();
    vi.advanceTimersByTime(15001);
    expect(host.classList.contains('show')).toBe(false);
    win.Blocks.ui.toast('已加入侧栏', { dismissible: true, duration: 15000 });
    host.querySelector('[aria-label="关闭提示"]').click();
    expect(host.classList.contains('show')).toBe(false);
    expect(host.getAttribute('role')).toBe('status');
  });
});
