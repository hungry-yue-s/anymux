// Desktop keyboard shortcuts, Kitty CSI-u mode tracking, modified Enter,
// non-Latin Ctrl chord recovery, and IME deferred newline handling.
// Ported from stablyai/orca (MIT).

const KITTY_SCAN_TAIL_LIMIT = 4096;
const KITTY_STACK_LIMIT = 16;

export const TERMINAL_KITTY_SHIFT_ENTER_INPUT = '\x1b[13;2u';
export const TERMINAL_CSI_U_CTRL_ENTER_INPUT = '\x1b[13;5u';
export const TERMINAL_CTRL_BACKSPACE_INPUT = '\x17';

/**
 * Mirrors xterm's per-screen Kitty keyboard protocol flags/stacks, DECSET 47/1047/1049 screen swaps,
 * RIS (`\x1bc`), DECSTR (`\x1b[!p`), and XTMODKEYS `modifyOtherKeys` (`CSI > 4 ; n m`).
 */
export class TerminalKittyKeyboardModeTracker {
  constructor({ kittyKeyboard = true } = {}) {
    this.kittyKeyboard = kittyKeyboard;
    this.reset();
    this.baselineProven = false;
  }

  get flags() {
    return this.currentFlags;
  }

  get modifyOtherKeys() {
    return this.modifyOtherKeysState;
  }

  get isAlternateScreen() {
    return this.alternateScreenActive;
  }

  reset() {
    this.baselineProven = true;
    this.scanTail = '';
    this.currentFlags = 0;
    this.mainFlags = 0;
    this.altFlags = 0;
    this.currentKnown = true;
    this.mainKnown = true;
    this.altKnown = true;
    this.mainStack = [];
    this.altStack = [];
    this.mainStackComplete = true;
    this.altStackComplete = true;
    this.alternateScreenActive = false;
    this.modifyOtherKeysState = 0;
  }

  resetForSnapshot() {
    const modifyOtherKeys = this.modifyOtherKeysState;
    this.reset();
    this.modifyOtherKeysState = modifyOtherKeys;
    this.baselineProven = false;
    this.currentKnown = false;
    this.mainKnown = false;
    this.altKnown = false;
    this.mainStackComplete = false;
    this.altStackComplete = false;
  }

  adoptSnapshot(snapshotData) {
    this.resetForSnapshot();
    this._scanInternal(snapshotData, true);
  }

  scan(data) {
    this._scanInternal(data, false);
  }

  _scanInternal(data, replay) {
    const chunk = typeof data === 'string' ? data : '';
    if (!this.scanTail && !chunk.includes('\x1b') && !chunk.includes('\x9b')) return;
    const input = this.scanTail + chunk;
    this.scanTail = this._extractScanTail(input);
    // Match RIS, DECSTR, private screen swaps (?47/?1047/?1049 h/l), Kitty (</>/= ... u), XTMODKEYS (>4;n m).
    const re = /\x1bc|(?:\x1b\[|\x9b)(?:!p|\?([0-9;]+)([hl])|([<>=])([0-9;]*)u|>4(?:;([0-9]*))?m)/g;
    let match;
    while ((match = re.exec(input)) !== null) {
      if (match[0] === '\x1bc') {
        const tail = this.scanTail;
        this.reset();
        this.scanTail = tail;
        continue;
      }
      if (match[0].endsWith('!p')) {
        this._applySoftReset();
        continue;
      }
      if (match[1] !== undefined) {
        this._applyScreenSwitch(match[1], match[2] === 'h');
        continue;
      }
      if (match[3] === undefined) {
        this.modifyOtherKeysState = Number(match[5] ?? '') || 0;
        continue;
      }
      if (this.kittyKeyboard) {
        this._applyKittySequence(match[3], match[4] ?? '', replay);
      }
    }
  }

  _applySoftReset() {
    this.baselineProven = true;
    this.currentFlags = 0;
    this.mainFlags = 0;
    this.altFlags = 0;
    this.currentKnown = true;
    this.mainKnown = true;
    this.altKnown = true;
    this.mainStack = [];
    this.altStack = [];
    this.mainStackComplete = true;
    this.altStackComplete = true;
  }

  _applyScreenSwitch(params, enabled) {
    for (const raw of params.split(';')) {
      const param = Number(raw);
      if (param !== 47 && param !== 1047 && param !== 1049) continue;
      if (enabled) {
        this.mainFlags = this.currentFlags;
        this.mainKnown = this.currentKnown;
        this.currentFlags = this.altFlags;
        this.currentKnown = this.altKnown;
        this.alternateScreenActive = true;
      } else {
        this.altFlags = this.currentFlags;
        this.altKnown = this.currentKnown;
        this.currentFlags = this.mainFlags;
        this.currentKnown = this.mainKnown;
        this.alternateScreenActive = false;
      }
    }
  }

  _applyKittySequence(prefix, params, replay) {
    const parsed = params.split(';').map((entry) => Number(entry));
    const stack = this.alternateScreenActive ? this.altStack : this.mainStack;
    if (prefix === '>') {
      if (!replay) {
        if (stack.length >= KITTY_STACK_LIMIT) stack.shift();
        stack.push({ flags: this.currentFlags, known: this.currentKnown });
      }
      this.currentFlags = parsed[0] || 0;
      this.currentKnown = true;
      this.baselineProven = true;
      return;
    }
    if (prefix === '<') {
      const count = Math.max(1, parsed[0] || 1);
      let lastPopped = null;
      for (let i = 0; i < count; i += 1) {
        const frame = stack.pop();
        if (!frame) {
          lastPopped = null;
          break;
        }
        lastPopped = frame;
        this.currentFlags = frame.flags;
        this.currentKnown = frame.known;
      }
      if (stack.length === 0) {
        this.currentFlags = 0;
        const complete = this.alternateScreenActive ? this.altStackComplete : this.mainStackComplete;
        this.currentKnown = complete || (lastPopped !== null && lastPopped.known && lastPopped.flags === 0);
      }
      return;
    }
    const flags = parsed[0] || 0;
    const mode = parsed.length > 1 && parsed[1] ? parsed[1] : 1;
    if (mode === 1) {
      this.currentFlags = flags;
      this.currentKnown = true;
      this.baselineProven = true;
    } else if (mode === 2) {
      this.currentFlags |= flags;
    } else if (mode === 3) {
      this.currentFlags &= ~flags;
    }
  }

  _extractScanTail(input) {
    const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'));
    if (start === -1) return '';
    const tail = input.slice(start);
    if (tail.length > KITTY_SCAN_TAIL_LIMIT) return '';
    if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b') return tail;
    const body = tail.startsWith('\x1b[')
      ? tail.slice(2)
      : tail.startsWith('\x9b')
        ? tail.slice(1)
        : null;
    if (body === null) return '';
    return (body === '!' || /^[<>=?]?[0-9;]*$/.test(body)) ? tail : '';
  }
}

export function encodeModifyOtherKeysEnter(modifyOtherKeys, modifier) {
  return modifyOtherKeys > 0 ? `\x1b[27;${modifier};13~` : null;
}

export function encodeTerminalShiftEnter({ kittyFlags = 0, modifyOtherKeys = 0 } = {}) {
  if (kittyFlags > 0) return TERMINAL_KITTY_SHIFT_ENTER_INPUT;
  return encodeModifyOtherKeysEnter(modifyOtherKeys, 2) ?? '\x1b\r';
}

export function encodeTerminalAltEnter({ kittyFlags = 0, modifyOtherKeys = 0 } = {}) {
  if (kittyFlags > 0) return '\x1b[13;3u';
  return encodeModifyOtherKeysEnter(modifyOtherKeys, 3) ?? '\x1b\r';
}

export function encodeTerminalCtrlEnter({ kittyFlags = 0 } = {}) {
  return kittyFlags > 0 ? TERMINAL_CSI_U_CTRL_ENTER_INPUT : '\x1b[13;5u';
}

/** Recover Ctrl+A..Z (excluding Ctrl+C) from physical key `code` on non-Latin keyboard layouts. */
export function resolveNonLatinControlChordInput(event) {
  if (!event || event.type !== 'keydown') return null;
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const key = String(event.key || '');
  if (Array.from(key).length !== 1 || (key.codePointAt(0) ?? 0) <= 0x7f) return null;
  const code = event.code;
  if (!code || code.length !== 4 || !code.startsWith('Key')) return null;
  const letter = code.charAt(3);
  if (letter === 'C' || letter < 'A' || letter > 'Z') return null;
  return String.fromCharCode(letter.charCodeAt(0) - 0x40);
}

export function isNonLatinControlChordKeyup(event, claimedCode) {
  return Boolean(event && claimedCode && event.type === 'keyup' && event.code === claimedCode);
}

/**
 * Check whether a keyboard event belongs to Anymux shell global shortcuts
 * that must always bubble up untouched.
 */
export function isPanelGlobalShortcut(event) {
  if (!event) return false;
  // Workspace commands in workspace-commands.js use Alt+Shift+...
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) return true;
  // App-level Cmd/Ctrl+K (CommandPalette), Cmd/Ctrl+Shift+O, Cmd/Ctrl+L
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey) return false;
  const lower = String(event.key || '').toLowerCase();
  if (!event.shiftKey && (lower === 'k' || lower === 'l')) return true;
  if (event.shiftKey && lower === 'o') return true;
  return false;
}

/**
 * Create an xterm custom key event handler providing:
 * - Cmd/Ctrl+F in-pane search
 * - Shift+Enter / Alt+Enter / Ctrl+Enter via Kitty CSI-u or modifyOtherKeys/ESC CR fallback
 * - Ctrl+Backspace -> Ctrl+W (`\x17`)
 * - macOS Cmd+Arrow/Backspace/Delete & Option+Arrow/Backspace natural editing (preserving Kitty mode)
 * - Non-Latin Ctrl+Letter physical key recovery
 * - Ctrl+C notification for bracketed-paste stale mode mitigation
 */
export function createTerminalKeyHandler({
  isMac = false,
  getKittyFlags = () => 0,
  getModifyOtherKeys = () => 0,
  sendInput,
  onSearch,
  onCopySelection,
  getSelection,
  onScrollViewport,
  onCtrlInterrupt,
} = {}) {
  let claimedNonLatinCtrlCode = null;

  return (event) => {
    if (!event) return true;

    if (event.type === 'keyup') {
      if (isNonLatinControlChordKeyup(event, claimedNonLatinCtrlCode)) {
        claimedNonLatinCtrlCode = null;
        return false;
      }
      return true;
    }

    if (event.type !== 'keydown') return true;
    if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return true;
    if (isPanelGlobalShortcut(event)) return true;

    const lowerKey = String(event.key || '').toLowerCase();
    const primaryMod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

    // Cmd/Ctrl+F opens in-pane search (when not holding Alt)
    if (primaryMod && !event.altKey && lowerKey === 'f') {
      if (!event.repeat) onSearch?.();
      event.preventDefault?.();
      return false;
    }

    // Copy active selection on Cmd+C (macOS) or Ctrl+Shift+C (all platforms)
    const selection = getSelection?.();
    if (selection && ((isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && lowerKey === 'c')
      || (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && lowerKey === 'c'))) {
      if (!event.repeat) onCopySelection?.(selection);
      event.preventDefault?.();
      return false;
    }

    // Ctrl+C with no selection marks interrupted bracketed paste before passing ^C to xterm/PTY.
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (lowerKey === 'c' || event.code === 'KeyC')) {
      onCtrlInterrupt?.();
      return true;
    }

    const kittyFlags = Number(getKittyFlags?.()) || 0;
    const modifyOtherKeys = Number(getModifyOtherKeys?.()) || 0;

    if (event.key === 'Enter') {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey) {
        sendInput?.(encodeTerminalShiftEnter({ kittyFlags, modifyOtherKeys }));
        event.preventDefault?.();
        return false;
      }
      if (!event.metaKey && !event.ctrlKey && event.altKey && !event.shiftKey && kittyFlags === 0) {
        const mok = encodeModifyOtherKeysEnter(modifyOtherKeys, 3);
        if (mok) {
          sendInput?.(mok);
          event.preventDefault?.();
          return false;
        }
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        sendInput?.(encodeTerminalCtrlEnter({ kittyFlags }));
        event.preventDefault?.();
        return false;
      }
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === 'Backspace') {
      sendInput?.(TERMINAL_CTRL_BACKSPACE_INPUT);
      event.preventDefault?.();
      return false;
    }

    if (isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (event.key === 'Backspace') { sendInput?.('\x15'); event.preventDefault?.(); return false; }
      if (event.key === 'Delete') { sendInput?.('\x0b'); event.preventDefault?.(); return false; }
      if (event.key === 'ArrowLeft') { sendInput?.('\x01'); event.preventDefault?.(); return false; }
      if (event.key === 'ArrowRight') { sendInput?.('\x05'); event.preventDefault?.(); return false; }
      if (event.key === 'ArrowUp') { onScrollViewport?.('top'); event.preventDefault?.(); return false; }
      if (event.key === 'ArrowDown') { onScrollViewport?.('bottom'); event.preventDefault?.(); return false; }
    }

    // Alt/Option word navigation and word deletion when not inside Kitty enhanced mode
    if (!event.metaKey && !event.ctrlKey && event.altKey && !event.shiftKey && !String(event.code || '').startsWith('Numpad')) {
      if (kittyFlags === 0) {
        if (event.key === 'Backspace') { sendInput?.('\x1b\x7f'); event.preventDefault?.(); return false; }
        if (isMac && event.key === 'Delete') { sendInput?.('\x1bd'); event.preventDefault?.(); return false; }
        if (event.key === 'ArrowLeft') { sendInput?.('\x1bb'); event.preventDefault?.(); return false; }
        if (event.key === 'ArrowRight') { sendInput?.('\x1bf'); event.preventDefault?.(); return false; }
      }
    }

    if (!isMac && !event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey
      && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && kittyFlags === 0) {
      sendInput?.(event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf');
      event.preventDefault?.();
      return false;
    }

    const nonLatinCtrl = resolveNonLatinControlChordInput(event);
    if (nonLatinCtrl) {
      claimedNonLatinCtrlCode = event.code || null;
      sendInput?.(nonLatinCtrl);
      event.preventDefault?.();
      return false;
    }

    return true;
  };
}

/**
 * Defers Shift+Enter / Ctrl+Enter pressed during an open IME composition so the
 * newline is sent right after compositionend instead of being silently swallowed.
 */
export function createImeDeferredNewlineTracker({
  globalObj = globalThis,
  getKittyFlags = () => 0,
  getModifyOtherKeys = () => 0,
  sendInput,
} = {}) {
  let pending = null;
  let timer = null;

  const clear = () => {
    pending = null;
    if (timer != null) {
      globalObj.clearTimeout?.(timer);
      timer = null;
    }
  };

  const flush = () => {
    const seq = pending;
    clear();
    if (!seq) return;
    globalObj.setTimeout?.(() => sendInput?.(seq), 0);
  };

  return {
    captureComposingKeydown(event) {
      const isEnter = event && (event.key === 'Enter' || event.keyCode === 13 || event.code === 'Enter' || event.code === 'NumpadEnter');
      if (!isEnter) return false;
      const kittyFlags = Number(getKittyFlags?.()) || 0;
      const modifyOtherKeys = Number(getModifyOtherKeys?.()) || 0;
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        pending = encodeTerminalShiftEnter({ kittyFlags, modifyOtherKeys });
      } else if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        pending = encodeTerminalCtrlEnter({ kittyFlags });
      } else {
        return false;
      }
      if (timer != null) globalObj.clearTimeout?.(timer);
      timer = globalObj.setTimeout?.(flush, 200) ?? null;
      return true;
    },
    onCompositionEnd() {
      if (pending) flush();
    },
    dispose: clear,
  };
}
