import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  iterateUtf8InputChunks,
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput,
  pasteTerminalText,
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText,
} from '../../plugins/workbench/client/terminal/paste.js';
import {
  ANYMUX_UNICODE_VERSION,
  activateAnymuxUnicodeProvider,
} from '../../plugins/workbench/client/terminal/unicode-provider.js';
import {
  TERMINAL_CSI_U_CTRL_ENTER_INPUT,
  TERMINAL_CTRL_BACKSPACE_INPUT,
  TERMINAL_KITTY_SHIFT_ENTER_INPUT,
  TerminalKittyKeyboardModeTracker,
  createImeDeferredNewlineTracker,
  createTerminalKeyHandler,
  resolveNonLatinControlChordInput,
} from '../../plugins/workbench/client/terminal/keyboard.js';
import { createPaneSearchController, safeFind } from '../../plugins/workbench/client/terminal/search.js';
import {
  applyDomBlockFills,
  backgroundImageForUniformBlockRun,
  createWebglRecoveryPolicy,
  forceRepaintThroughRenderPause,
  readStableCellSize,
  repairPaneWebglCanvasDpr,
  resolveMinimumContrastRatio,
  stripTerminalSelectionGutter,
} from '../../plugins/workbench/client/terminal/rendering.js';
import {
  cssColorToOscRgb,
  mode2031SequenceFor,
  scanAndReplyOscColorQueries,
  scanMode2031ReplyDecision,
} from '../../plugins/workbench/client/terminal/protocol-replies.js';

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

function loadLinkDetect() {
  const win = {};
  const src = readFileSync(join(process.cwd(), 'plugins/terminal/client/js/link-detect.js'), 'utf8');
  return new Function('window', `${src}\nreturn window.LinkDetect;`)(win);
}

describe('Wave 1: Paste safety & UTF-8 byte chunking (Item 1)', () => {
  it('sanitizes embedded ESC bytes and normalizes CRLF/LF inside bracketed paste', () => {
    expect(sanitizeBracketedPasteText('a\x1b[201~rm -rf')).toBe('a\u241b[201~rm -rf');
    expect(wrapTerminalBracketedPasteText('line1\r\nline2\n')).toBe(
      `${BRACKETED_PASTE_START}line1\rline2\r${BRACKETED_PASTE_END}`,
    );
  });

  it('chunks CJK & emoji text strictly by UTF-8 bytes without splitting surrogate pairs', () => {
    const emoji = '🚀'; // 4 UTF-8 bytes, 2 UTF-16 code units
    const cjk = '中'; // 3 UTF-8 bytes, 1 UTF-16 code unit
    const text = emoji.repeat(5) + cjk.repeat(10); // 20 + 30 = 50 bytes
    const chunks = [...iterateUtf8InputChunks(text, 10)];
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(10);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });

  it('suppresses stale bracketed paste wrapper on single-line paste after Ctrl+C until ?2004 reappears', () => {
    const sent = [];
    const term = {
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
      paste(str) {
        sent.push(this.options.ignoreBracketedPasteMode ? str : `${BRACKETED_PASTE_START}${str}${BRACKETED_PASTE_END}`);
      },
      input(raw) { sent.push(raw); },
    };

    markTerminalBracketedPasteInterrupted(term);
    pasteTerminalText(term, 'ls -la');
    expect(sent).toEqual(['ls -la']);
    expect(term.options.ignoreBracketedPasteMode).toBe(false);

    // Multi-line paste and forceBracketedPaste stay bracketed
    pasteTerminalText(term, 'echo 1\necho 2');
    expect(sent.at(-1)).toBe(`${BRACKETED_PASTE_START}echo 1\necho 2${BRACKETED_PASTE_END}`);
    pasteTerminalText(term, '/tmp/shot.png', { forceBracketedPaste: true });
    expect(sent.at(-1)).toBe(`${BRACKETED_PASTE_START}/tmp/shot.png${BRACKETED_PASTE_END}`);

    // Once PTY emits DECSET ?2004h, normal single-line bracketed paste resumes
    observeTerminalBracketedPasteModeOutput(term, '\x1b[?2004');
    observeTerminalBracketedPasteModeOutput(term, 'h');
    pasteTerminalText(term, 'pwd');
    expect(sent.at(-1)).toBe(`${BRACKETED_PASTE_START}pwd${BRACKETED_PASTE_END}`);
  });
});

describe('Wave 1: Unicode 11 + ZWJ emoji cluster width (Item 2)', () => {
  it('activates custom ZWJ provider on headless xterm and treats ZWJ emoji sequences as one wide cluster', () => {
    const term = new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true });
    const fakeProvider = {
      version: '11',
      wcwidth: (cp) => (cp >= 0x1f300 ? 2 : 1),
      charProperties: (cp) => ((cp << 3) | ((cp >= 0x1f300 ? 2 : 1) << 1)),
    };
    term.unicode.register(fakeProvider);
    if (term._core?.unicodeService?._providers) {
      term._core.unicodeService._providers['11'] = fakeProvider;
    }

    expect(activateAnymuxUnicodeProvider(term, {})).toBe(true);
    expect(term.unicode.activeVersion).toBe(ANYMUX_UNICODE_VERSION);

    const active = term._core.unicodeService._providers[ANYMUX_UNICODE_VERSION];
    const p1 = active.charProperties(0x1f469, 0);
    const pZwj = active.charProperties(0x200d, p1);
    const p2 = active.charProperties(0x1f4bb, pZwj);
    expect((pZwj & 1)).toBe(1);
    expect((p2 & 1)).toBe(1);
    expect((p2 >> 1) & 3).toBe(2);
    term.dispose();
  });
});

describe('Wave 1: Keyboard shortcuts, Kitty CSI-u tracker, non-Latin Ctrl, IME deferred newline (Item 3)', () => {
  it('tracks Kitty push/pop flags across alternate screen swaps and RIS', () => {
    const tracker = new TerminalKittyKeyboardModeTracker();
    tracker.scan('\x1b[>1u'); // main push 1
    expect(tracker.flags).toBe(1);
    tracker.scan('\x1b[?1049h'); // enter alt -> 0
    expect(tracker.flags).toBe(0);
    tracker.scan('\x1b[>3u');
    expect(tracker.flags).toBe(3);
    tracker.scan('\x1b[?1049l'); // exit alt -> back to main 1
    expect(tracker.flags).toBe(1);
    tracker.scan('\x1b[>4;2m'); // XTMODKEYS
    expect(tracker.modifyOtherKeys).toBe(2);
    tracker.scan('\x1bc'); // RIS resets both screens
    expect(tracker.flags).toBe(0);
    expect(tracker.modifyOtherKeys).toBe(0);
  });

  it('recovers non-Latin Ctrl+Letter chords (except C) and handles Cmd/Opt/Shift+Enter shortcuts', () => {
    expect(resolveNonLatinControlChordInput({
      type: 'keydown', key: 'ф', code: 'KeyA', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
    })).toBe('\x01');
    expect(resolveNonLatinControlChordInput({
      type: 'keydown', key: 'с', code: 'KeyC', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
    })).toBeNull();

    const sent = [];
    const scrolled = [];
    let searched = false;
    const handler = createTerminalKeyHandler({
      isMac: true,
      getKittyFlags: () => 1,
      sendInput: (d) => sent.push(d),
      onSearch: () => { searched = true; },
      onScrollViewport: (p) => scrolled.push(p),
    });

    // Global Alt+Shift shortcut must pass through untouched
    expect(handler({ type: 'keydown', key: 'G', code: 'KeyG', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false })).toBe(true);
    // Cmd+F opens search
    expect(handler({ type: 'keydown', key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(searched).toBe(true);
    // Shift+Enter & Ctrl+Enter encode Kitty CSI-u when flags > 0
    handler({ type: 'keydown', key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false });
    handler({ type: 'keydown', key: 'Enter', ctrlKey: true, shiftKey: false, metaKey: false, altKey: false });
    // Cmd+Left / Cmd+Up
    handler({ type: 'keydown', key: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
    handler({ type: 'keydown', key: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
    expect(sent).toEqual([TERMINAL_KITTY_SHIFT_ENTER_INPUT, TERMINAL_CSI_U_CTRL_ENTER_INPUT, '\x01']);
    expect(scrolled).toEqual(['top']);
  });

  it('defers Shift+Enter during IME composition until compositionend', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const ime = createImeDeferredNewlineTracker({
        globalObj: globalThis,
        getKittyFlags: () => 1,
        sendInput: (s) => sent.push(s),
      });
      expect(ime.captureComposingKeydown({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
      expect(sent).toEqual([]);
      ime.onCompositionEnd();
      vi.advanceTimersByTime(10);
      expect(sent).toEqual([TERMINAL_KITTY_SHIFT_ENTER_INPUT]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Wave 1: In-pane search & safeFind (Item 4)', () => {
  it('swallows narrow-viewport positive-integer decoration errors while preserving real exceptions', () => {
    expect(safeFind(() => { throw new Error('SelectionRange only accepts positive integers'); }, 'abc')).toBe(false);
    expect(() => safeFind(() => { throw new Error('boom'); }, 'abc')).toThrow('boom');
  });

  it('mounts floating search bar inside pane card and navigates matches cleanly', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    const paneEl = doc.createElement('section');
    doc.body.appendChild(paneEl);

    const cleared = [];
    const calls = [];
    let cb = null;
    class FakeSearchAddon {
      onDidChangeResults(listener) { cb = listener; return { dispose: () => {} }; }
      findNext(q, opts) { calls.push(['next', q, opts]); cb?.({ resultIndex: 0, resultCount: 3 }); return true; }
      findPrevious(q, opts) { calls.push(['prev', q, opts]); cb?.({ resultIndex: 2, resultCount: 3 }); return true; }
      clearDecorations() { cleared.push(true); }
      dispose() {}
    }
    const ctrl = createPaneSearchController({
      entry: { paneId: '%1', el: paneEl, term: { loadAddon: () => {}, getSelection: () => 'hello' } },
      globalObj: { document: doc, SearchAddon: { SearchAddon: FakeSearchAddon } },
    });

    ctrl.open();
    const input = paneEl.querySelector('.wb-pane-search-input');
    expect(input.value).toBe('hello');
    expect(paneEl.querySelector('.wb-pane-search-count').textContent).toBe('1/3');
    ctrl.close();
    expect(cleared.length).toBeGreaterThan(0);
    expect(paneEl.querySelector('.wb-pane-search').hidden).toBe(true);
  });
});

describe('Wave 1: Rendering resilience, contrast, DOM block fills & gutter stripping (Item 5)', () => {
  it('bounds WebGL context-loss retries to 3 within 60s window', () => {
    const policy = createWebglRecoveryPolicy(3, 60_000);
    expect(policy.canRetry(1000)).toBe(true);
    policy.recordLoss(1000);
    policy.recordLoss(2000);
    expect(policy.canRetry(3000)).toBe(true);
    policy.recordLoss(3000);
    expect(policy.canRetry(4000)).toBe(false);
    expect(policy.canRetry(62_000)).toBe(true);
  });

  it('resolves contrast ratio, releases paused render latch, repairs canvas DPR, and prefers device cell size', () => {
    expect(resolveMinimumContrastRatio('dark')).toBe(3);
    expect(resolveMinimumContrastRatio('light')).toBe(4.5);

    const refreshCalls = [];
    const term = {
      cols: 80,
      rows: 24,
      element: { ownerDocument: { defaultView: { devicePixelRatio: 2 } } },
      _core: {
        _renderService: {
          _isPaused: true,
          _needsFullRefresh: true,
          dimensions: { device: { cell: { width: 18, height: 36 } }, css: { cell: { width: 9.2, height: 18 } } },
          refreshRows: (s, e, sync) => refreshCalls.push([s, e, sync]),
        },
      },
    };
    expect(readStableCellSize(term)).toEqual({ width: 9, height: 18 });
    expect(forceRepaintThroughRenderPause(term)).toBe(true);
    expect(refreshCalls).toEqual([[0, 23, true]]);
  });

  it('fills uniform DOM block runs U+2580..U+2595 and strips common selection gutter', () => {
    expect(backgroundImageForUniformBlockRun('▄▄▄')).toContain('linear-gradient(to bottom');
    expect(backgroundImageForUniformBlockRun('██')).toContain('transparent 0%, var(--anymux-block-fg) 0%');
    expect(backgroundImageForUniformBlockRun('ab')).toBeNull();

    const dom = new JSDOM('<!doctype html><html><body><div class="xterm-rows"><div><span style="color: rgb(120, 180, 255)">████</span><span>plain</span></div></div></body></html>');
    applyDomBlockFills(dom.window.document.body);
    const blockSpan = dom.window.document.querySelector('span');
    expect(blockSpan.style.color).toBe('transparent');
    expect(blockSpan.style.backgroundImage).toContain('linear-gradient');

    expect(stripTerminalSelectionGutter('    const a = 1;\n\n      const b = 2;')).toBe(
      'const a = 1;\n\n  const b = 2;',
    );
    expect(stripTerminalSelectionGutter('no-gutter\n    indented')).toBe('no-gutter\n    indented');
  });
});

describe('Wave 1: OSC 10/11, Mode 2031 & extended link detection (Item 6)', () => {
  it('converts CSS colors and replies to OSC 10/11 and Mode 2031 across chunk splits', () => {
    expect(cssColorToOscRgb('#1a1b26')).toBe('rgb:1a1a/1b1b/2626');
    const replies = [];
    let scan = scanAndReplyOscColorQueries('\x1b]10;?', { foreground: '#c0caf5', background: '#1a1b26' }, (r) => replies.push(r), '');
    expect(replies).toEqual([]);
    scan = scanAndReplyOscColorQueries(';?\x07', { foreground: '#c0caf5', background: '#1a1b26' }, (r) => replies.push(r), scan.tail);
    expect(replies).toEqual(['\x1b]10;rgb:c0c0/caca/f5f5\x1b\\', '\x1b]11;rgb:1a1a/1b1b/2626\x1b\\']);

    const m1 = scanMode2031ReplyDecision(null, '\x1b[?2031h');
    expect(m1.decision).toBe('subscribed');
    expect(mode2031SequenceFor('dark')).toBe('\x1b[?997;1n');
    expect(mode2031SequenceFor('light')).toBe('\x1b[?997;2n');
  });

  it('extracts Markdown [label](path) links and proposes spaced path candidates', () => {
    const ld = loadLinkDetect();
    const mdLinks = ld.findLinks('See [guide](docs/design-spec.md:42) and `[raw](src/app.js)`');
    expect(mdLinks.some((m) => m.text === 'docs/design-spec.md' && m.lineRef === 42)).toBe(true);
    expect(mdLinks.some((m) => m.text === 'src/app.js')).toBe(true);

    const line = 'open /Users/me/My Project/hello world.txt now';
    const base = ld.findLinks(line).find((m) => m.text.startsWith('/Users/me/My'));
    expect(base).toBeTruthy();
    const cands = ld.spacedPathCandidates(line, base);
    expect(cands.some((c) => c.text === '/Users/me/My Project/hello world.txt')).toBe(true);
  });
});
