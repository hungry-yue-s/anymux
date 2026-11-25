import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createTileRegistry } from '../../plugins/workbench/client/tile-registry.js';
import { SeamWindowSession } from '../../plugins/workbench/client/seam-window-session.js';
import { fixture } from './workbench-session.test.js';

function snap(paneId, text = 'ok') {
  const payload = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(21 + payload.byteLength);
  const v = new DataView(buf);
  v.setUint8(0, 0x02);
  v.setUint32(1, Number(paneId.replace('%', '')), false);
  v.setUint32(5, 0, false);
  v.setUint16(9, 60, false);
  v.setUint16(11, 30, false);
  new Uint8Array(buf, 21).set(payload);
  return buf;
}

describe('TileRegistry & mixed rich Seam panes', () => {
  let cleanups = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()();
  });

  it('validates browser URLs and renders built-in + fallback tiles safely', async () => {
    const dom = new JSDOM('<div id="host"></div>', { url: 'https://panel.test' });
    cleanups.push(() => dom.window.close());
    const win = dom.window;
    const host = win.document.getElementById('host');
    const registry = createTileRegistry();
    expect(registry.list()).toEqual(expect.arrayContaining(['browser', 'diff', 'doc', 'worktrees', 'sessions', 'automations']));

    const onUpdatePayload = vi.fn();
    const browserHandle = registry.mount('browser', host, {
      global: win,
      serverId: 'local',
      payload: JSON.stringify({ url: 'https://example.com/app' }),
      onUpdatePayload,
    });
    const iframe = host.querySelector('iframe.seam-tile-frame');
    expect(iframe?.getAttribute('src')).toBe('https://example.com/app');

    // Unsafe protocols must be blocked instead of assigned to iframe.src.
    browserHandle.update({ global: win, serverId: 'local', payloadData: { url: 'javascript:alert(1)' } });
    expect(host.querySelector('iframe.seam-tile-frame')).toBeNull();
    expect(host.querySelector('.seam-tile-empty')?.textContent).toContain('仅支持 http:// 或 https://');
    browserHandle.dispose();

    win.Api = {
      nodeUrl: (_s, p) => p,
      get: vi.fn(async (url) => {
        if (url.startsWith('/api/git/status')) return { files: [{ path: 'src/app.js', staged: false, worktree: 'M' }] };
        if (url.startsWith('/api/worktrees')) return { worktrees: [{ branch: 'feat/tile', path: '/repo-wt' }] };
        if (url.startsWith('/api/session-vault/sessions')) return { sessions: [{ id: 's1', provider: 'claude', title: 'Build stage 4' }] };
        if (url.startsWith('/api/automations')) return { jobs: [{ id: 'j1', name: 'Nightly test', cron: '0 * * * *' }] };
        if (url.startsWith('/api/files/read')) return { content: '# Readme' };
        return {};
      }),
      post: vi.fn(async () => ({ ok: true })),
    };

    registry.mount('diff', host, { global: win, serverId: 'local', payload: '{"path":"/repo"}' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.textContent).toContain('src/app.js');

    registry.mount('doc', host, { global: win, serverId: 'local', payload: '{"path":"/repo/README.md"}' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.textContent).toContain('# Readme');

    registry.mount('worktrees', host, { global: win, serverId: 'local', payload: '{"path":"/repo"}' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.textContent).toContain('feat/tile');

    registry.mount('sessions', host, { global: win, serverId: 'local', payload: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.textContent).toContain('Build stage 4');

    registry.mount('automations', host, { global: win, serverId: 'local', payload: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.textContent).toContain('Nightly test');

    const convert = vi.fn();
    registry.mount('custom-widget', host, { global: win, payload: '{"foo":"bar"}', onConvertToTerminal: convert });
    expect(host.textContent).toContain('custom-widget');
    host.querySelector('.seam-tile-btn')?.click();
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('mounts mixed terminal + rich panes inside SeamWindowSession without allocating xterm for rich panes and supports live transitions', async () => {
    const fx = fixture();
    cleanups.push(fx.close);
    const states = [];
    const actions = [];
    const menus = [];
    fx.win.ContextMenu = { open: (spec) => menus.push(spec) };

    const session = new SeamWindowSession(fx.win, {
      container: fx.host,
      target: { serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@1', clientId: 'c-test' },
      onState: (s) => states.push(s.status),
      onAction: (action, detail) => actions.push({ action, detail }),
    });
    await session.ready;
    const ws = fx.sockets[0];
    ws.readyState = 1;
    ws.onopen?.();
    ws.onmessage({ data: JSON.stringify({
      type: 'ready', protocol: 1, instanceId: '42:123', sessionId: '$1', windowId: '@1',
      windowCols: 120, windowRows: 30, zoomed: false, sizeLease: 'owner', inputAllowed: true, foreignClient: false,
    }) });

    const tree = {
      type: 'split', dir: 'row', width: 120, height: 30,
      children: [
        { type: 'pane', paneId: '%1', width: 60, height: 30 },
        { type: 'pane', paneId: '%2', width: 59, height: 30 },
      ],
    };
    ws.onmessage({ data: JSON.stringify({
      type: 'layout', windowId: '@1', windowCols: 120, windowRows: 30, zoomed: false, activePaneId: '%1', layoutString: 'm', tree,
      panes: [
        { id: '%1', index: 0, active: true, width: 60, height: 30, kind: 'terminal', payload: '', command: 'zsh' },
        { id: '%2', index: 1, active: false, width: 59, height: 30, kind: 'browser', payload: '{"url":"https://example.com"}' },
      ],
    }) });
    ws.onmessage({ data: snap('%1', 'shell ready') });
    await new Promise((r) => setTimeout(r, 10));

    // Only the terminal pane allocates an xterm Terminal; rich pane renders its tile immediately.
    expect(fx.terminals).toHaveLength(1);
    expect(states).toContain('live');
    expect(fx.host.querySelector('[data-pane-id="%2"] iframe.seam-tile-frame')?.getAttribute('src')).toBe('https://example.com/');

    // Right-click menu on the rich pane rail offers rich split & revert actions.
    const richRail = fx.host.querySelector('[data-pane-id="%2"] .seam-rail');
    richRail.dispatchEvent(new fx.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    expect(menus.at(-1).items.some((i) => i.id === 'to-terminal')).toBe(true);
    expect(menus.at(-1).items.some((i) => i.id === 'split-rich-browser')).toBe(true);

    // Converting %2 back to terminal instantiates a second Terminal cleanly.
    ws.onmessage({ data: JSON.stringify({
      type: 'layout', windowId: '@1', windowCols: 120, windowRows: 30, zoomed: false, activePaneId: '%2', layoutString: 'm', tree,
      panes: [
        { id: '%1', index: 0, active: false, width: 60, height: 30, kind: 'terminal', payload: '', command: 'zsh' },
        { id: '%2', index: 1, active: true, width: 59, height: 30, kind: 'terminal', payload: '', command: 'bash' },
      ],
    }) });
    expect(fx.terminals).toHaveLength(2);
    expect(fx.host.querySelector('[data-pane-id="%2"] iframe.seam-tile-frame')).toBeNull();
    session.dispose();
  });

  it('mounts the full embedded git block via BlockHost.mountEmbedded when available and falls back cleanly without it', () => {
    const dom = new JSDOM('<div id="host"></div>', { url: 'https://panel.test' });
    cleanups.push(() => dom.window.close());
    const win = dom.window;
    const host = win.document.getElementById('host');
    const registry = createTileRegistry();
    const updates = [];
    let disposedCount = 0;

    win.BlockHost = {
      mountEmbedded: vi.fn((kind, container, options) => {
        expect(kind).toBe('git');
        const el = win.document.createElement('div');
        el.className = 'git-block';
        el.textContent = 'embedded:' + options.params.path;
        container.replaceChildren(el);
        return {
          el,
          update(nextParams) {
            updates.push(nextParams);
            el.textContent = 'embedded:' + nextParams.path;
          },
          dispose() { disposedCount += 1; el.remove(); },
        };
      }),
    };

    const handle = registry.mount('diff', host, {
      global: win,
      serverId: 'dev',
      payload: JSON.stringify({ path: '/repo/a' }),
    });
    expect(host.querySelector('.seam-tile-diff.blk-frame.blk-mode-tile .git-block')?.textContent).toBe('embedded:/repo/a');

    handle.update({ global: win, serverId: 'dev', payloadData: { path: '/repo/b', commit: 'abc123' } });
    expect(updates).toEqual([{ path: '/repo/b', commit: 'abc123' }]);
    expect(host.querySelector('.git-block')?.textContent).toBe('embedded:/repo/b');

    handle.dispose();
    expect(disposedCount).toBe(1);
    expect(host.querySelector('.seam-tile-diff')).toBeNull();
  });
});
