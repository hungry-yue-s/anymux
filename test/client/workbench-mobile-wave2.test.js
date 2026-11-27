import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
  applyXtermSelectionRange,
  createMobileSelectionOverlay,
  orderedSelectionRange,
} from '../../plugins/workbench/client/mobile/selection-handles.js';
import {
  createMobileModeTracker,
  encodeMobileTouchScrollInput,
  readOsc8UriAtCell,
  scanMobileTerminalModes,
} from '../../plugins/workbench/client/mobile/mouse-and-osc8.js';
import {
  MOMENTUM_FRICTION_PER_16MS,
  RELEASE_VELOCITY_MAX_AGE_MS,
  computeActiveTerminalKeyboardLift,
  resolvePinchTargetFontSize,
  smoothTouchVelocity,
  startMomentumScroll,
} from '../../plugins/workbench/client/mobile/gestures-and-keyboard.js';
import {
  AGENT_SMART_KEY_STEP_MS,
  applyStickyModifiersToInput,
  consumeOneShotModifiers,
  createStickyModifiersState,
  encodeTerminalKeyForModes,
  resolveAgentSmartKeys,
  sendSmartKeySequence,
  tapStickyModifier,
} from '../../plugins/workbench/client/mobile/sticky-and-smart-keys.js';

function createDomStub() {
  const dom = new JSDOM('<!doctype html><html><body><div class="seam-pane"><div class="pane-body"><div class="xterm"><div class="xterm-screen"></div></div></div></div></body></html>');
  const win = dom.window;
  const doc = win.document;
  const paneEl = doc.querySelector('.seam-pane');
  const bodyEl = doc.querySelector('.pane-body');
  const xtermEl = doc.querySelector('.xterm');
  const screenEl = doc.querySelector('.xterm-screen');

  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 480 });
  screenEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 480 });

  const selections = [];
  let cleared = false;
  let selectionText = '  12 hello\u2502  world  \n  34 line2 ';
  const term = {
    cols: 80,
    rows: 24,
    element: xtermEl,
    buffer: { active: { viewportY: 0, type: 'normal' } },
    select: vi.fn((col, row, len) => { selections.push({ col, row, len }); }),
    clearSelection: vi.fn(() => { cleared = true; }),
    getSelection: vi.fn(() => selectionText),
    scrollLines: vi.fn((delta) => {
      term.buffer.active.viewportY = Math.max(0, Math.min(200, term.buffer.active.viewportY + delta));
    }),
  };

  return { win, doc, paneEl, bodyEl, screenEl, term, selections, wasCleared: () => cleared, setSelectionText: (v) => { selectionText = v; } };
}

describe('wave 2 mobile selection handles, auto-scroll, and gutter strip', () => {
  it('orders inverted anchor/focus pairs and computes xterm select length across rows', () => {
    const ordered = orderedSelectionRange({ anchor: { row: 5, col: 10 }, focus: { row: 3, col: 4 } });
    expect(ordered).toEqual({ start: { row: 3, col: 4 }, end: { row: 5, col: 10 } });
    const term = { cols: 80, select: vi.fn() };
    applyXtermSelectionRange(term, { anchor: { row: 5, col: 10 }, focus: { row: 3, col: 4 } });
    // (80 - 4) + 1*80 + (10 + 1) = 76 + 80 + 11 = 167
    expect(term.select).toHaveBeenCalledWith(4, 3, 167);
  });

  it('supports handle drag, crossing start past end, edge auto-scroll, and stripped copy', () => {
    vi.useFakeTimers();
    try {
      const stub = createDomStub();
      const copied = [];
      let cleared = 0;
      const overlay = createMobileSelectionOverlay({
        entry: { el: stub.paneEl, body: stub.bodyEl, term: stub.term },
        globalObj: stub.win,
        pointToCell: ({ clientX, clientY }) => ({
          col: Math.max(0, Math.min(79, Math.floor(clientX / 4))),
          row: stub.term.buffer.active.viewportY + Math.max(0, Math.min(23, Math.floor(clientY / 20))),
        }),
        onCopy: (text) => copied.push(text),
        onClear: () => { cleared += 1; },
      });

      overlay.show({ row: 4, col: 10 }, { row: 4, col: 20 });
      expect(overlay.isActive()).toBe(true);
      const startHandle = stub.paneEl.querySelector('.wb-sel-handle.is-start');
      const endHandle = stub.paneEl.querySelector('.wb-sel-handle.is-end');
      expect(startHandle).not.toBeNull();
      expect(endHandle).not.toBeNull();

      const touchEv = (type, clientX, clientY) => {
        const ev = new stub.win.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: [{ clientX, clientY }] });
        return ev;
      };

      // Drag start handle forward past end (row 6, col 5) and near bottom edge (y=470 > 440) -> triggers +1 auto-scroll
      stub.term.buffer.active.viewportY = 10;
      startHandle.dispatchEvent(touchEv('touchstart', 40, 80));
      expect(overlay.isDraggingHandle()).toBe(true);
      startHandle.dispatchEvent(touchEv('touchmove', 20, 470));
      vi.advanceTimersByTime(130);
      expect(stub.term.scrollLines).toHaveBeenCalledWith(1);
      startHandle.dispatchEvent(touchEv('touchend', 20, 470));
      expect(overlay.isDraggingHandle()).toBe(false);

      // Copy strips shared leading gutter whitespace before calling onCopy
      stub.setSelectionText('    alpha\n      beta');
      stub.paneEl.querySelector('.wb-touch-copy-inline').click();
      expect(copied).toEqual(['alpha\n  beta']);
      expect(overlay.isActive()).toBe(false);
      expect(cleared).toBe(1);

      overlay.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('wave 2 DECCKM, mouse wheel protocols, and OSC 8 lookup', () => {
  it('tracks DECCKM, SGR 1006, SGR-Pixels 1016, and X10/VT200 across chunks', () => {
    const modes = createMobileModeTracker();
    scanMobileTerminalModes(modes, '\x1b[?1h\x1b[?1002');
    scanMobileTerminalModes(modes, ';1016h');
    expect(modes.applicationCursorKeysMode).toBe(true);
    expect(modes.mouseTrackingMode).toBe('drag');
    expect(modes.sgrMousePixelsMode).toBe(true);
    expect(encodeMobileTouchScrollInput({
      term: { buffer: { active: { type: 'normal' } } },
      trackedModes: modes,
      lines: 2,
      cell: { col: 5, row: 7 },
      pixelX: 120.4,
      pixelY: 240.6,
    })).toBe('\x1b[<65;120;241M\x1b[<65;120;241M');

    // Switch to legacy X10/VT200 without SGR 1006 (SGR disabled, mouseEncodingKnown remains true)
    scanMobileTerminalModes(modes, '\x1b[?1000;1006l\x1b[?1000h');
    expect(modes.sgrMouseMode).toBe(false);
    expect(modes.sgrMousePixelsMode).toBe(false);
    expect(encodeMobileTouchScrollInput({
      term: { modes: { mouseTrackingMode: 'vt200' }, buffer: { active: { type: 'normal' } } },
      trackedModes: modes,
      lines: -1,
      cell: { col: 2, row: 3 },
    })).toBe(`\x1b[M${String.fromCharCode(64 + 32)}${String.fromCharCode(3 + 32)}${String.fromCharCode(4 + 32)}`);

    // Alt-screen without mouse tracking uses DECCKM SS3 vs CSI arrows
    scanMobileTerminalModes(modes, '\x1b[?1000l\x1b[?1h');
    expect(encodeMobileTouchScrollInput({
      term: { buffer: { active: { type: 'alternate' } } },
      trackedModes: modes,
      lines: -2,
    })).toBe('\x1bOA\x1bOA');
    scanMobileTerminalModes(modes, '\x1b[?1l');
    expect(encodeMobileTouchScrollInput({
      term: { buffer: { active: { type: 'alternate' } } },
      trackedModes: modes,
      lines: 1,
    })).toBe('\x1b[B');
  });

  it('reads OSC 8 URI from xterm cell link service safely', () => {
    const term = {
      buffer: { active: { getLine: (r) => (r === 3 ? { getCell: (c) => (c === 5 ? { extended: { urlId: 42 } } : {}) } : null) } },
      _core: { _oscLinkService: { getLinkData: (id) => (id === 42 ? { uri: 'https://example.com/docs' } : null) } },
    };
    expect(readOsc8UriAtCell(term, 5, 3)).toBe('https://example.com/docs');
    expect(readOsc8UriAtCell(term, 0, 3)).toBeNull();
  });
});

describe('wave 2 120Hz EMA momentum, pinch reflow, and keyboard avoidance lift', () => {
  it('smooths velocity and applies frame-rate-independent friction with 100ms rest cutoff', () => {
    let v = smoothTouchVelocity(0, 20, 10);
    v = smoothTouchVelocity(v, 10, 10);
    expect(v).toBeCloseTo(2 * 0.55 + 1 * 0.45, 4);

    // Cutoff after >100ms pause between last move and release
    const scrolled = [];
    const cancelStale = startMomentumScroll({
      globalObj: { requestAnimationFrame: () => 1 },
      initialVelocity: 1.5,
      lastMoveTime: 1000,
      cellHeight: 18,
      onScrollLines: (l) => scrolled.push(l),
      nowEpoch: () => 1000 + RELEASE_VELOCITY_MAX_AGE_MS + 10,
    });
    cancelStale();
    expect(scrolled).toEqual([]);

    // 120Hz (8ms step) decays with (0.945 ** (8/16)) per frame
    const callbacks = [];
    let rafSeq = 0;
    const fakeGlobal = {
      requestAnimationFrame: (cb) => { callbacks.push(cb); return ++rafSeq; },
      cancelAnimationFrame: vi.fn(),
    };
    let perfNow = 100;
    const cancel = startMomentumScroll({
      globalObj: fakeGlobal,
      initialVelocity: 2.5,
      lastMoveTime: 5000,
      cellHeight: 18,
      onScrollLines: (l) => scrolled.push(l),
      now: () => perfNow,
      nowEpoch: () => 5020,
    });
    perfNow += 8;
    callbacks.shift()(perfNow);
    const firstBatch = scrolled.reduce((a, b) => a + b, 0);
    expect(firstBatch).toBeGreaterThanOrEqual(1);
    expect(MOMENTUM_FRICTION_PER_16MS).toBeCloseTo(0.945, 3);
    cancel();
    expect(fakeGlobal.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('computes snapped pinch font size and soft-keyboard cursor/footer lift', () => {
    expect(resolvePinchTargetFontSize(14, 1.35)).toBe(19);
    expect(resolvePinchTargetFontSize(14, 4)).toBe(22);
    expect(resolvePinchTargetFontSize(12, 0.5)).toBe(11);

    // Cursor well above keyboard dock -> 0 lift needed in normal mode
    expect(computeActiveTerminalKeyboardLift({
      keyboardLift: 280,
      rows: 24,
      cursorY: 4,
      rowPitch: 20,
      terminalFrameHeight: 700,
      altScreen: false,
    })).toBe(0);

    // Cursor near bottom hidden behind keyboard -> lifts proportionally up to keyboardLift
    expect(computeActiveTerminalKeyboardLift({
      keyboardLift: 280,
      rows: 24,
      cursorY: 22,
      rowPitch: 20,
      terminalFrameHeight: 480,
      altScreen: false,
    })).toBeGreaterThan(0);

    // Alt-screen TUI fills frame -> full keyboard lift
    expect(computeActiveTerminalKeyboardLift({
      keyboardLift: 280,
      rows: 24,
      cursorY: 5,
      rowPitch: 20,
      terminalFrameHeight: 480,
      altScreen: true,
    })).toBe(280);
  });
});

describe('wave 2 3-state sticky modifiers and Agent Smart Keys', () => {
  it('supports one-shot and double-tap locked modifiers with mode-aware encoding', () => {
    let state = createStickyModifiersState();
    state = tapStickyModifier(state, 'ctrl', false);
    expect(state.ctrl).toBe('once');
    state = tapStickyModifier(state, 'alt', true);
    expect(state.alt).toBe('locked');
    state = tapStickyModifier(state, 'shift', false);
    expect(state.shift).toBe('once');

    // Ctrl + Shift + Alt + 'a' -> \x1b + (\x41 & 0x1f = \x01)
    expect(applyStickyModifiersToInput('a', state, {})).toBe('\x1b\x01');
    // CSI cursor with modifiers -> \x1b[1;<mod>A (1 + shift:1 + alt:2 + ctrl:4 = 8)
    expect(applyStickyModifiersToInput('\x1b[A', state, {})).toBe('\x1b[1;8A');

    // Consume one-shot clears ctrl/shift but keeps locked alt
    state = consumeOneShotModifiers(state);
    expect(state).toEqual({ ctrl: 'off', alt: 'locked', shift: 'off' });

    expect(encodeTerminalKeyForModes('\x1b[A', { applicationCursorKeysMode: true, kittyKeyboardFlags: 0 })).toBe('\x1bOA');
    expect(encodeTerminalKeyForModes('\x1b[13;2u', { kittyKeyboardFlags: 0, modifyOtherKeys: 0 })).toBe('\x1b\r');
    expect(encodeTerminalKeyForModes('\x1b[13;2u', { kittyKeyboardFlags: 1, modifyOtherKeys: 0 })).toBe('\x1b[13;2u');
  });

  it('resolves smart keys per agent/state and spaces multi-write sequences by 120ms', () => {
    vi.useFakeTimers();
    try {
      const claudePerm = resolveAgentSmartKeys({ agentType: 'claude', status: 'permission' });
      expect(claudePerm.keys.map((k) => k.id)).toEqual(['yes', 'always', 'no']);
      expect(claudePerm.keys[0].primary).toBe(true);

      const codexWork = resolveAgentSmartKeys({ agentType: 'codex', status: 'working' });
      expect(codexWork.keys.map((k) => k.writes[0])).toEqual(['\x1b', '\t', '\x1b[1;2D']);

      expect(resolveAgentSmartKeys({ appKind: 'opencode', status: 'waiting_attention' }).agent).toBe('opencode');
      expect(resolveAgentSmartKeys({ agentType: 'agy', status: 'working' }).agent).toBe('antigravity');

      const sent = [];
      sendSmartKeySequence(['\x1b', '\x1b'], (seq) => sent.push(seq), globalThis);
      expect(sent).toEqual(['\x1b']);
      vi.advanceTimersByTime(AGENT_SMART_KEY_STEP_MS - 1);
      expect(sent).toEqual(['\x1b']);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(['\x1b', '\x1b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
