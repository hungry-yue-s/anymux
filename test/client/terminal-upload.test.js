import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { clientPath, indexSource } from '../helpers/pages.js';

const source = readFileSync(clientPath('js/terminal-upload.js'), 'utf8');

let dom;

function setup() {
  dom = new JSDOM('<!doctype html><html><body><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></body></html>', {
    runScripts: 'outside-only',
  });
  dom.window.eval(source);
  return dom.window;
}

afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
});

/** A clipboardData as browsers hand it to a paste listener. */
function clipboard(window, { files = [], text = '' } = {}) {
  return {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files,
    getData: (type) => (type === 'text/plain' ? text : ''),
  };
}

function image(window, name = 'image.png', type = 'image/png') {
  return new window.File(['png-bytes'], name, { type });
}

function pasteEvent(window, data) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  return event;
}

function respond(data, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(ok ? { success: true, data } : { success: false, error: data }) });
}

async function settle(window) {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe('which pastes are images', () => {
  it('takes a screenshot paste, which has no text', () => {
    const window = setup();
    const shot = image(window);
    expect(window.TerminalUpload.pastedImages(clipboard(window, { files: [shot] }))).toEqual([shot]);
  });

  it('leaves text alone, including the picture a spreadsheet puts beside its cells', () => {
    const window = setup();
    const { pastedImages } = window.TerminalUpload;
    expect(pastedImages(clipboard(window, { text: 'echo hi' }))).toEqual([]);
    expect(pastedImages(clipboard(window, { files: [image(window)], text: 'a\tb\n1\t2' }))).toEqual([]);
  });

  it('takes a copied file, which brings its own name or address as text', () => {
    const window = setup();
    const { pastedImages } = window.TerminalUpload;
    const shot = image(window, 'Screenshot 2026-11-19.png');
    expect(pastedImages(clipboard(window, { files: [shot], text: 'Screenshot 2026-11-19.png' }))).toEqual([shot]);
    expect(pastedImages(clipboard(window, { files: [shot], text: 'file:///Users/me/Desktop/Screenshot%202026-11-19.png' }))).toEqual([shot]);
    expect(pastedImages(clipboard(window, { files: [image(window)], text: 'https://example.com/cat.png' }))).toHaveLength(1);
  });

  it('ignores files that are not images', () => {
    const window = setup();
    const pdf = new window.File(['%PDF'], 'a.pdf', { type: 'application/pdf' });
    expect(window.TerminalUpload.pastedImages(clipboard(window, { files: [pdf] }))).toEqual([]);
  });
});

describe('the pasted path', () => {
  it('stores a pasted image under a one-word name the agents recognise', () => {
    const window = setup();
    const { uploadName } = window.TerminalUpload;
    expect(uploadName(image(window), 0, 1)).toBe('paste.png');
    expect(uploadName(image(window, 'image.png', 'image/jpeg'), 1, 2)).toBe('paste-2.jpg');
    expect(uploadName(image(window, 'Screenshot 2026-11-19 at 10.00.png'), 0, 1)).toBe('Screenshot_2026-11-19_at_10.00.png');
    expect(uploadName(new window.File(['x'], '报告 (1).pdf', { type: 'application/pdf' }), 0, 1)).toBe('报告_1.pdf');
  });

  it('quotes a path only when a shell would split it', () => {
    const window = setup();
    const { pasteText } = window.TerminalUpload;
    expect(pasteText('C:/msys64/tmp/anymux-uploads/1_paste.png')).toBe('C:/msys64/tmp/anymux-uploads/1_paste.png');
    expect(pasteText('/tmp/anymux-uploads/1_paste.png')).toBe('/tmp/anymux-uploads/1_paste.png');
    expect(pasteText('/Users/a b/uploads/1_paste.png')).toBe("'/Users/a b/uploads/1_paste.png'");
  });
});

describe('pasting an image into a terminal', () => {
  function mount(window, overrides = {}) {
    const element = window.document.querySelector('.xterm');
    const textarea = element.querySelector('textarea');
    const xtermPaste = vi.fn();
    textarea.addEventListener('paste', xtermPaste);
    const options = {
      serverId: () => 'win',
      isCurrent: () => true,
      paste: vi.fn(() => true),
      copy: vi.fn(),
      notify: vi.fn(),
      ...overrides,
    };
    const cleanup = window.TerminalUpload.install(element, options);
    return { element, textarea, xtermPaste, options, cleanup };
  }

  it('uploads to the pane\'s machine and pastes the path its programs read', async () => {
    const window = setup();
    window.Api = { nodeUrl: (serverId, path) => '/n/' + serverId + path };
    window.Auth = { headers: () => ({ Authorization: 'Bearer t' }) };
    window.fetch = vi.fn(() => respond({ path: '/tmp/anymux-uploads/1_paste.png', nativePath: 'C:/msys64/tmp/anymux-uploads/1_paste.png' }));
    const { textarea, xtermPaste, options } = mount(window);

    const event = pasteEvent(window, clipboard(window, { files: [image(window)] }));
    textarea.dispatchEvent(event);
    await settle(window);

    // xterm never sees it: it would send an empty paste the agent reads as "no image".
    expect(event.defaultPrevented).toBe(true);
    expect(xtermPaste).not.toHaveBeenCalled();
    expect(window.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = window.fetch.mock.calls[0];
    expect(url).toBe('/n/win/api/upload');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer t' });
    expect(init.body.get('file').name).toBe('paste.png');
    expect(options.paste).toHaveBeenCalledWith('C:/msys64/tmp/anymux-uploads/1_paste.png');
  });

  it('lets a text paste through to xterm untouched', async () => {
    const window = setup();
    window.fetch = vi.fn();
    const { textarea, xtermPaste, options } = mount(window);
    const event = pasteEvent(window, clipboard(window, { text: 'ls -la' }));
    textarea.dispatchEvent(event);
    await settle(window);
    expect(event.defaultPrevented).toBe(false);
    expect(xtermPaste).toHaveBeenCalledTimes(1);
    expect(window.fetch).not.toHaveBeenCalled();
    expect(options.paste).not.toHaveBeenCalled();
  });

  it('pastes several images one path per paste, in order', async () => {
    const window = setup();
    let release;
    const first = new Promise((resolve) => { release = resolve; });
    window.fetch = vi.fn()
      .mockImplementationOnce(() => first.then(() => respond({ path: '/a', nativePath: 'C:/u/1_paste-1.png' })))
      .mockImplementationOnce(() => respond({ path: '/b', nativePath: 'C:/u/1_paste-2.png' }));
    const { textarea, options } = mount(window);
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window), image(window)] })));
    await settle(window);
    expect(options.paste).not.toHaveBeenCalled();
    release();
    await settle(window);
    expect(options.paste.mock.calls).toEqual([['C:/u/1_paste-1.png '], ['C:/u/1_paste-2.png']]);
  });

  it('falls back to the shell path from an older Node', async () => {
    const window = setup();
    window.fetch = vi.fn(() => respond({ path: '/tmp/anymux-uploads/1_paste.png' }));
    const { textarea, options } = mount(window);
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window)] })));
    await settle(window);
    expect(options.paste).toHaveBeenCalledWith('/tmp/anymux-uploads/1_paste.png');
  });

  it('copies the path instead when the terminal moved on during the upload', async () => {
    const window = setup();
    window.fetch = vi.fn(() => respond({ path: '/p', nativePath: 'C:/u/1_paste.png' }));
    const { textarea, options } = mount(window, { isCurrent: () => false });
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window)] })));
    await settle(window);
    expect(options.paste).not.toHaveBeenCalled();
    expect(options.copy).toHaveBeenCalledWith('C:/u/1_paste.png');
  });

  it('copies the path when the terminal is not connected', async () => {
    const window = setup();
    window.fetch = vi.fn(() => respond({ path: '/p', nativePath: 'C:/u/1_paste.png' }));
    const { textarea, options } = mount(window, { paste: vi.fn(() => false) });
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window)] })));
    await settle(window);
    expect(options.copy).toHaveBeenCalledWith('C:/u/1_paste.png');
  });

  it('reports a failed upload and pastes nothing', async () => {
    const window = setup();
    window.fetch = vi.fn(() => respond('File too large (max 20MB)', false, 413));
    const { textarea, options } = mount(window);
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window)] })));
    await settle(window);
    expect(options.paste).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenLastCalledWith('上传失败：File too large (max 20MB)', 3500);
  });

  it('does not upload to a server without a Node, and still keeps the empty paste from xterm', async () => {
    const window = setup();
    window.fetch = vi.fn();
    const { textarea, xtermPaste, options } = mount(window, { serverId: () => null });
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window)] })));
    await settle(window);
    expect(window.fetch).not.toHaveBeenCalled();
    expect(xtermPaste).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenCalledWith('该服务器未安装面板服务，无法上传图片', 3000);
  });

  it('removes its listeners with the cleanup', async () => {
    const window = setup();
    window.fetch = vi.fn();
    const { textarea, xtermPaste, cleanup } = mount(window);
    cleanup();
    textarea.dispatchEvent(pasteEvent(window, clipboard(window, { files: [image(window)] })));
    await settle(window);
    expect(window.fetch).not.toHaveBeenCalled();
    expect(xtermPaste).toHaveBeenCalledTimes(1);
  });
});

describe('dropping files onto a terminal', () => {
  it('uploads dropped files and skips folders', async () => {
    const window = setup();
    window.fetch = vi.fn(() => respond({ path: '/p', nativePath: '/home/me/uploads/1_notes.pdf' }));
    const element = window.document.querySelector('.xterm');
    const paste = vi.fn(() => true);
    window.TerminalUpload.install(element, { serverId: () => 'local', isCurrent: () => true, paste, notify: vi.fn() });
    const pdf = new window.File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
    const folder = new window.File([''], 'src', { type: '' });
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: {
      types: ['Files'],
      files: [pdf, folder],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }, { webkitGetAsEntry: () => ({ isDirectory: true }) }],
    } });
    element.dispatchEvent(drop);
    await settle(window);
    expect(drop.defaultPrevented).toBe(true);
    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(window.fetch.mock.calls[0][1].body.get('file').name).toBe('notes.pdf');
    expect(paste).toHaveBeenCalledWith('/home/me/uploads/1_notes.pdf');
  });

  it('ignores drags without files, such as panel tabs', () => {
    const window = setup();
    window.fetch = vi.fn();
    const element = window.document.querySelector('.xterm');
    window.TerminalUpload.install(element, { serverId: () => 'local', isCurrent: () => true, paste: vi.fn(), notify: vi.fn() });
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['application/x-anymux-tab'], files: [], items: [] } });
    element.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(window.fetch).not.toHaveBeenCalled();
  });
});

describe('the page', () => {
  it('loads the helper before the terminal mounts', () => {
    const page = indexSource();
    const helper = page.indexOf('/js/terminal-upload.js');
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(page.indexOf('/js/terminal.js'));
  });
});
