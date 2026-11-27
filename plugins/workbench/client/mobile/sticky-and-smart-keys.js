// 3-state sticky modifiers (off -> once -> locked via double-tap),
// mode-aware quick key encoding, and state-driven Agent Smart Keys.
// Ported from stablyai/orca (MIT).

export const STICKY_MODIFIER_DOUBLE_TAP_MS = 350;
export const AGENT_SMART_KEY_STEP_MS = 120;

const ESC = '\x1b';
const ARROW_UP = '\x1b[A';
const ARROW_LEFT = '\x1b[D';
const ARROW_RIGHT = '\x1b[C';
const SHIFT_TAB = '\x1b[Z';
const SHIFT_LEFT = '\x1b[1;2D';
const UNMODIFIED_CURSOR_RE = /^\x1b\[([ABCDHF])$/;

export function createStickyModifiersState() {
  return { ctrl: 'off', alt: 'off', shift: 'off' };
}

/**
 * Transition modifier latch:
 * - Quick double-tap (<350ms) locks ('locked')
 * - Single tap toggles 'off' <-> 'once'
 */
export function tapStickyModifier(state, modifier, doubleTap = false) {
  if (!state || !(modifier in state)) return state;
  const latch = doubleTap ? 'locked' : (state[modifier] === 'off' ? 'once' : 'off');
  return { ...state, [modifier]: latch };
}

export function hasActiveStickyModifier(state) {
  return Boolean(state && (state.ctrl !== 'off' || state.alt !== 'off' || state.shift !== 'off'));
}

export function consumeOneShotModifiers(state) {
  if (!state) return createStickyModifiersState();
  return {
    ctrl: state.ctrl === 'once' ? 'off' : state.ctrl,
    alt: state.alt === 'once' ? 'off' : state.alt,
    shift: state.shift === 'once' ? 'off' : state.shift,
  };
}

/** Apply active sticky Ctrl / Alt / Shift modifiers to a single key string or escape sequence. */
export function applyStickyModifiersToInput(data, state, modes = {}) {
  if (!data || !state || !hasActiveStickyModifier(state)) return data;
  const hasCtrl = state.ctrl !== 'off';
  const hasAlt = state.alt !== 'off';
  const hasShift = state.shift !== 'off';

  let out = data;
  if (data.length === 1) {
    let ch = data;
    if (hasShift && ch >= 'a' && ch <= 'z') ch = ch.toUpperCase();
    if (hasCtrl) {
      const code = ch.charCodeAt(0);
      if ((code >= 64 && code <= 95) || (code >= 97 && code <= 122)) {
        ch = String.fromCharCode(code & 0x1f);
      }
    }
    out = hasAlt ? `${ESC}${ch}` : ch;
    return encodeTerminalKeyForModes(out, modes);
  }

  // Modified CSI cursor keys: \x1b[A -> \x1b[1;<mod>A
  const cursorMatch = UNMODIFIED_CURSOR_RE.exec(data);
  if (cursorMatch) {
    let mod = 1;
    if (hasShift) mod += 1;
    if (hasAlt) mod += 2;
    if (hasCtrl) mod += 4;
    if (mod > 1) return `${ESC}[1;${mod}${cursorMatch[1]}`;
  }
  return encodeTerminalKeyForModes(out, modes);
}

/** Encode navigation & modified Enter keys respecting DECCKM, Kitty flags, and modifyOtherKeys. */
export function encodeTerminalKeyForModes(bytes, modes = {}) {
  const kitty = Number(modes?.kittyKeyboardFlags || 0);
  const mok = Number(modes?.modifyOtherKeys || 0);
  if (bytes === '\x1b[13;2u') {
    if (kitty > 0) return '\x1b[13;2u';
    return mok > 0 ? '\x1b[27;2;13~' : '\x1b\r';
  }
  if (bytes === '\x1b[13;5u') {
    return '\x1b[13;5u';
  }
  if (modes?.applicationCursorKeysMode === true && kitty === 0) {
    const match = UNMODIFIED_CURSOR_RE.exec(bytes);
    if (match) return `${ESC}O${match[1]}`;
  }
  return bytes;
}

const wordKey = (id, label, combo, writes, primary = false) => ({
  id,
  label,
  combo,
  writes,
  ...(primary ? { primary: true } : {}),
});

const AGENT_SMART_KEYS = {
  claude: {
    working: [
      wordKey('stop', '中断', 'Esc', [ESC]),
      wordKey('sendNow', '立即发', '⌃X ⌃S', ['\x18\x13']),
      wordKey('background', '后台', '⌃B', ['\x02']),
      wordKey('mode', '模式', '⇧Tab', [SHIFT_TAB]),
    ],
    permission: [
      wordKey('yes', '允许', '1', ['1'], true),
      wordKey('always', '始终', '2', ['2']),
      wordKey('no', '拒绝', 'Esc', [ESC]),
    ],
    idle: [
      wordKey('mode', '模式', '⇧Tab', [SHIFT_TAB]),
      wordKey('history', '历史', '↑', [ARROW_UP]),
      wordKey('rewind', '回退', 'Esc Esc', [ESC, ESC]),
    ],
  },
  codex: {
    working: [
      wordKey('stop', '中断', 'Esc', [ESC]),
      wordKey('queue', '排队', 'Tab', ['\t']),
      wordKey('edit', '取回', '⇧←', [SHIFT_LEFT]),
    ],
    permission: [
      wordKey('yes', '允许', 'y', ['y'], true),
      wordKey('no', '拒绝', 'n', ['n']),
    ],
  },
  opencode: {
    working: [wordKey('stop', '中断', 'Esc Esc', [ESC, ESC])],
    permission: [
      wordKey('left', '←', '←', [ARROW_LEFT]),
      wordKey('right', '→', '→', [ARROW_RIGHT]),
      wordKey('confirm', '确认', 'Enter', ['\r'], true),
      wordKey('reject', '拒绝', 'Esc', [ESC]),
    ],
  },
  antigravity: {
    working: [wordKey('stop', '中断', 'Esc', [ESC])],
    permission: [
      wordKey('yes', '允许', 'y', ['y'], true),
      wordKey('no', '拒绝', 'Esc', [ESC]),
    ],
  },
};

function canonicalSmartAgent(agentType) {
  const raw = String(agentType || '').toLowerCase();
  if (raw.includes('claude')) return 'claude';
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('opencode')) return 'opencode';
  if (raw === 'agy' || raw.includes('antigravity')) return 'antigravity';
  return null;
}

/**
 * Resolve contextual smart shortcuts for a pane's agent status from `AgentStatus.getPane()`.
 */
export function resolveAgentSmartKeys(paneInfo) {
  if (!paneInfo) return null;
  const agent = canonicalSmartAgent(paneInfo.agentType || paneInfo.appKind);
  if (!agent) return null;
  const status = String(paneInfo.status || '').toLowerCase();
  let state = null;
  if (status === 'working') state = 'working';
  else if (status === 'permission' || status === 'waiting_attention') state = 'permission';
  else if (status === 'idle' || status === 'done' || status === 'completed') state = 'idle';
  if (!state) return null;
  const keys = AGENT_SMART_KEYS[agent]?.[state];
  return keys && keys.length ? { agent, state, keys } : null;
}

/**
 * Send multi-write smart key sequences (e.g. `Esc Esc`) spaced 120ms apart so TUI
 * parsers never fuse `[ESC, ESC]` into `Alt+Esc`.
 */
export function sendSmartKeySequence(writes, sendFn, globalObj = globalThis) {
  if (!Array.isArray(writes) || !writes.length || typeof sendFn !== 'function') return;
  sendFn(writes[0]);
  for (let i = 1; i < writes.length; i += 1) {
    globalObj.setTimeout?.(() => sendFn(writes[i]), i * AGENT_SMART_KEY_STEP_MS);
  }
}
