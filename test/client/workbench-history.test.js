import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { openHistory } from '../../plugins/workbench/client/history.js';

const target = { serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@7', paneId: '%8' };

function fixture() {
  const dom = new JSDOM('<button id="opener">history</button>', { url: 'https://panel.test' });
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  const reply = (before = 1000) => ({ ...target, lines: ['older line', 'newer line'], total: 1000, before, nextBefore: before - 2 || null });
  win.Api = { nodeUrl: (serverId, path) => '/n/' + serverId + path, get: vi.fn(async () => reply()) };
  return { win, reply, close: () => win.close() };
}

describe('independent retained history reader', () => {
  it('pins its source, pages older records and never writes the main terminal', async () => {
    const f = fixture();
    const input = { ...target };
    const reader = openHistory(f.win, input, { title: 'Build' });
    input.paneId = '%99';
    await reader.ready;
    expect(f.win.Api.get.mock.calls[0][0]).toBe('/n/dev/api/workbench/panes/%258/history?instanceId=42%3A123&sessionId=%241&windowId=%407&limit=500');
    expect(reader.dialog.querySelector('pre').textContent).toBe('older line\nnewer line');
    f.win.Api.get.mockResolvedValueOnce(f.reply(998));
    await reader.loadEarlier();
    expect(f.win.Api.get.mock.calls[1][0]).toContain('before=998');
    expect(reader.target.paneId).toBe('%8');
    expect(reader.dialog.getAttribute('aria-label')).toBe('Build的更多历史');
    expect(reader.dialog.querySelector('.wb-history-header strong').textContent).toBe('Build · 更多历史');
    expect(reader.dialog.textContent).toContain('历史随终端输出滚动');
    reader.close(); expect(reader.dialog.isConnected).toBe(false); f.close();
  });

  it('does not apply a stale response after closing and retains an existing page on failure', async () => {
    const f = fixture();
    const reader = openHistory(f.win, target); await reader.ready;
    f.win.Api.get.mockRejectedValueOnce(new Error('offline'));
    await reader.loadEarlier();
    expect(reader.dialog.querySelector('pre').textContent).toContain('older line');
    expect(reader.dialog.textContent).toContain('offline');
    let finish;
    f.win.Api.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const request = reader.refresh(); reader.close(); finish(f.reply()); await request;
    expect(reader.dialog.isConnected).toBe(false); f.close();
  });

  it('closes via header close button, footer close button, backdrop click, and Escape key while centering the dialog', async () => {
    const css = readFileSync('plugins/workbench/client/css/workbench.css', 'utf8');
    expect(css).toMatch(/\.wb-history\s*\{[^}]*margin:\s*auto;/);

    // 1. Header close button & ignoring inside clicks
    let f = fixture();
    let reader = openHistory(f.win, target, { title: 'Build' });
    await reader.ready;
    reader.dialog.querySelector('.wb-history-content').dispatchEvent(new f.win.MouseEvent('click', { bubbles: true }));
    expect(reader.dialog.isConnected).toBe(true);
    reader.dialog.querySelector('[aria-label="关闭历史"]').click();
    expect(reader.dialog.isConnected).toBe(false);
    f.close();

    // 2. Footer close button
    f = fixture();
    reader = openHistory(f.win, target);
    await reader.ready;
    const footerButtons = [...reader.dialog.querySelectorAll('.wb-history-footer button')];
    footerButtons.find((btn) => btn.textContent === '关闭').click();
    expect(reader.dialog.isConnected).toBe(false);
    f.close();

    // 3. Backdrop click (event.target === dialog)
    f = fixture();
    reader = openHistory(f.win, target);
    await reader.ready;
    reader.dialog.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true }));
    expect(reader.dialog.isConnected).toBe(false);
    f.close();

    // 4. Escape key fallback
    f = fixture();
    reader = openHistory(f.win, target);
    await reader.ready;
    reader.dialog.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(reader.dialog.isConnected).toBe(false);
    f.close();
  });
});
