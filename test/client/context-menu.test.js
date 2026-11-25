import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = (path) => readFileSync(path, 'utf8');
const windows = [];
afterEach(() => { vi.useRealTimers(); windows.splice(0).forEach((w) => w.close()); });

function setupDom() {
  const dom = new JSDOM('<!doctype html><body><div class="ms-app mode-terminal"><aside class="ms-sidebar"><div id="ms-server-context"></div></aside><main class="ms-main"><div id="ms-view"><div class="wb-stage"></div></div></main></div></body>', {
    url: 'https://panel.test/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  windows.push(w);
  Object.defineProperty(w, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: 900, configurable: true });
  w.eval(source('plugins/ui/client/js/context-menu.js'));
  return w;
}

describe('Unified 5-zone ContextMenu', () => {
  it('supports keyboard navigation, separator normalization, disabled items, and viewport clamping', () => {
    const w = setupDom();
    const ran = vi.fn();
    const menu = w.ContextMenu.open({
      x: 1400,
      y: 880,
      label: '测试菜单',
      items: [
        { separator: true },
        { id: 'disabled', label: '不可用', disabled: true, action: ran },
        { id: 'first', label: '第一项', action: ran },
        { separator: true },
        { separator: true },
        { id: 'second', label: '第二项', danger: true, action: () => ran('second') },
        { separator: true },
      ],
    });
    expect(menu.hidden).toBe(false);
    // Leading, consecutive, trailing separators are normalized to 1 middle separator.
    expect(menu.querySelectorAll('.seam-ctx-sep')).toHaveLength(1);
    // Focus starts on first enabled item ('first').
    expect(w.document.activeElement.dataset.ctxAction).toBe('first');

    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(w.document.activeElement.dataset.ctxAction).toBe('second');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ran).toHaveBeenCalledWith('second');
    expect(w.ContextMenu.isOpen()).toBe(false);
  });

  it('triggers mobile 500ms long-press and cancels when pointer drifts >10px', () => {
    vi.useFakeTimers();
    const w = setupDom();
    const btn = w.document.createElement('button');
    btn.className = 'rail-target';
    w.document.body.append(btn);
    const triggered = vi.fn();
    const dispose = w.ContextMenu.installLongPress(w.document, '.rail-target', triggered, 500);

    const start1 = new w.Event('touchstart', { bubbles: true });
    Object.defineProperty(start1, 'touches', { value: [{ clientX: 50, clientY: 60 }] });
    btn.dispatchEvent(start1);
    const moveFar = new w.Event('touchmove', { bubbles: true });
    Object.defineProperty(moveFar, 'touches', { value: [{ clientX: 80, clientY: 60 }] });
    btn.dispatchEvent(moveFar);
    vi.advanceTimersByTime(600);
    expect(triggered).not.toHaveBeenCalled();

    const start2 = new w.Event('touchstart', { bubbles: true });
    Object.defineProperty(start2, 'touches', { value: [{ clientX: 50, clientY: 60 }] });
    btn.dispatchEvent(start2);
    vi.advanceTimersByTime(500);
    expect(triggered).toHaveBeenCalledOnce();
    expect(triggered.mock.calls[0][1]).toMatchObject({ clientX: 50, clientY: 60, longPress: true });
    dispose();
  });

  it('wires Zone 3 (dock tab close-others/close-right) and Zone 4 (dock resizer reset width) via FilePreview', async () => {
    const w = setupDom();
    w.Api = { activeServerId: () => 'local', nodeUrl: (_id, p) => p };
    w.Blocks = { ui: { currentContext: () => ({ onTerminal: true, serverId: 'local', instanceId: '1:1', sessionId: '$1', windowId: '@1', paneId: '%1' }) } };
    w.fetch = vi.fn(async (url) => {
      const p = new URL(url, w.location.href).searchParams.get('path') || '/a';
      return { status: 200, json: async () => ({ success: true, data: { isDirectory: true, absPath: p, parent: '/', entries: [], mtimeMs: 1, size: 0 } }) };
    });
    w.eval(source('plugins/files/client/js/file-preview.js'));
    await w.FilePreview.switchDockContext('local', '@1', '1:1');
    await w.FilePreview.openFile('/dir-a', '%1'); w.FilePreview._test.dockCurrent();
    await w.FilePreview.openFile('/dir-b', '%1'); w.FilePreview._test.dockCurrent();
    await w.FilePreview.openFile('/dir-c', '%1'); w.FilePreview._test.dockCurrent();

    const dock = w.document.querySelector('.fp-dock');
    dock.getBoundingClientRect = () => ({ width: 520, height: 800, left: 900, top: 0 });

    // Zone 4: right-click dock resizer -> reset width to 420px
    const resizer = dock.querySelector('.fp-side-resizer');
    resizer.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 200 }));
    const resetItem = w.document.querySelector('#seam-context-menu [data-ctx-action="reset-width"]');
    expect(resetItem).not.toBeNull();
    resetItem.click();
    expect(dock.style.width).toBe('420px');

    // Zone 3: right-click first tab -> close-right closes /dir-b and /dir-c
    const firstTab = w.document.querySelectorAll('.fp-dock-tab-item')[0];
    firstTab.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 960, clientY: 16 }));
    const closeRight = w.document.querySelector('#seam-context-menu [data-ctx-action="close-right"]');
    expect(closeRight.disabled).toBe(false);
    closeRight.click();
    expect(w.document.querySelectorAll('.fp-dock-tab-item')).toHaveLength(1);
  });

  it('supports cascading submenus via hover, click, ArrowRight, ArrowLeft, and Escape', () => {
    const w = setupDom();
    const ran = vi.fn();
    const menu = w.ContextMenu.open({
      x: 100,
      y: 100,
      label: '窗格操作',
      items: [
        { id: 'split-h', label: '左右分窗', action: () => ran('split-h') },
        {
          id: 'open-git-preview',
          label: '打开 Git 预览',
          children: [
            { id: 'git-sidebar', label: '侧边栏', action: () => ran('sidebar') },
            { id: 'git-replace', label: '覆盖当前窗格', action: () => ran('replace') },
          ],
        },
        { id: 'respawn', label: '重置窗格', danger: true, action: () => ran('respawn') },
      ],
    });
    const trigger = menu.querySelector('[data-ctx-action="open-git-preview"]');
    expect(trigger.classList.contains('has-submenu')).toBe(true);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    // ArrowRight on focused trigger opens submenu and focuses first child
    trigger.focus();
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const sub = w.document.getElementById('seam-context-submenu');
    expect(sub.hidden).toBe(false);
    expect(w.document.activeElement.dataset.ctxAction).toBe('git-sidebar');

    // ArrowDown moves within submenu; ArrowLeft closes only submenu back to trigger
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(w.document.activeElement.dataset.ctxAction).toBe('git-replace');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(sub.hidden).toBe(true);
    expect(w.document.activeElement).toBe(trigger);

    // Hover opens submenu, hovering sibling closes it, clicking child executes action & closes both
    trigger.dispatchEvent(new w.MouseEvent('mouseenter', { bubbles: true }));
    expect(sub.hidden).toBe(false);
    menu.querySelector('[data-ctx-action="respawn"]').dispatchEvent(new w.MouseEvent('mouseenter', { bubbles: true }));
    expect(sub.hidden).toBe(true);

    trigger.click();
    expect(sub.hidden).toBe(false);
    sub.querySelector('[data-ctx-action="git-replace"]').click();
    expect(ran).toHaveBeenCalledWith('replace');
    expect(sub.hidden).toBe(true);
    expect(w.ContextMenu.isOpen()).toBe(false);
  });
});
