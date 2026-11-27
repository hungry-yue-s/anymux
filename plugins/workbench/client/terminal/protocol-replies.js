// OSC 10/11 color query responders, Mode 2031 theme-change notifications,
// OSC 52 microtask coalescing, and link-click PTY mouse suppression.
// Ported from stablyai/orca (MIT).

const OSC = '\u001b]';
const BEL = '\u0007';
const ST = '\u001b\\';
const MODE_2031_TAIL_LIMIT = 128;

export function mode2031SequenceFor(mode) {
  return mode === 'light' ? '\x1b[?997;2n' : '\x1b[?997;1n';
}

export function cssColorToOscRgb(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed)?.[1];
  if (hex) {
    const exp = hex.length === 3 ? hex.split('').map((c) => `${c}${c}`).join('') : hex;
    return `rgb:${exp.slice(0, 2).repeat(2)}/${exp.slice(2, 4).repeat(2)}/${exp.slice(4, 6).repeat(2)}`;
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(trimmed)?.[1];
  if (!rgb) return null;
  const colorPart = rgb.split('/')[0]?.trim();
  if (!colorPart) return null;
  const parts = colorPart.includes(',') ? colorPart.split(',').slice(0, 3) : colorPart.split(/\s+/).slice(0, 3);
  if (parts.length !== 3) return null;
  const channels = [];
  for (const part of parts) {
    const p = part.trim();
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(p)?.[1];
    const num = pct !== undefined ? (Number(pct) / 100) * 255 : (/^\d+(?:\.\d+)?$/.test(p) ? Number(p) : NaN);
    if (!Number.isFinite(num)) return null;
    channels.push(Math.min(255, Math.max(0, Math.round(num))).toString(16).padStart(2, '0').repeat(2));
  }
  return `rgb:${channels[0]}/${channels[1]}/${channels[2]}`;
}

export function terminalOscColorQueryReply(colors, slot) {
  const color = slot === 10 ? cssColorToOscRgb(colors?.foreground) : cssColorToOscRgb(colors?.background);
  return color ? `\x1b]${slot};${color}\x1b\\` : null;
}

function parseOscTerminator(data, offset) {
  if (offset >= data.length) return { kind: 'partial' };
  if (data[offset] === BEL) return { kind: 'complete', endIndex: offset + 1 };
  if (data.startsWith(ST, offset)) return { kind: 'complete', endIndex: offset + 2 };
  if (data[offset] === '\x1b' && offset + 1 >= data.length) return { kind: 'partial' };
  return { kind: 'none' };
}

/** Scan live PTY output for OSC 10;? / OSC 11;? / OSC 10;?;? queries and emit replies. */
export function scanAndReplyOscColorQueries(data, colors, sendReply, previousTail = '') {
  if (typeof data !== 'string' || (!previousTail && !data.includes(OSC))) {
    return { sent: false, tail: '' };
  }
  const input = previousTail + data;
  let sent = false;
  let offset = 0;
  let nextTail = '';

  while (offset < input.length) {
    const oscIdx = input.indexOf(OSC, offset);
    if (oscIdx === -1) break;
    const after = input.slice(oscIdx);
    const is10 = after.startsWith(`${OSC}10;`);
    const is11 = after.startsWith(`${OSC}11;`);
    if (!is10 && !is11) {
      if ((`${OSC}10;`.startsWith(after) || `${OSC}11;`.startsWith(after))) {
        nextTail = after;
        break;
      }
      offset = oscIdx + OSC.length;
      continue;
    }
    const bodyStart = oscIdx + 5;
    if (bodyStart >= input.length) {
      nextTail = input.slice(oscIdx);
      break;
    }
    if (input[bodyStart] !== '?') {
      offset = oscIdx + OSC.length;
      continue;
    }
    const slot = is10 ? 10 : 11;
    let term = parseOscTerminator(input, bodyStart + 1);
    let slots = [slot];
    if (term.kind === 'none' && is10 && input[bodyStart + 1] === ';') {
      if (bodyStart + 2 >= input.length) {
        nextTail = input.slice(oscIdx);
        break;
      }
      if (input[bodyStart + 2] === '?') {
        term = parseOscTerminator(input, bodyStart + 3);
        slots = [10, 11];
      }
    }
    if (term.kind === 'partial') {
      nextTail = input.slice(oscIdx);
      break;
    }
    if (term.kind === 'complete') {
      for (const s of slots) {
        const reply = terminalOscColorQueryReply(colors, s);
        if (reply) {
          sendReply?.(reply);
          sent = true;
        }
      }
      offset = term.endIndex;
      continue;
    }
    offset = oscIdx + OSC.length;
  }

  return { sent, tail: nextTail.slice(-32) };
}

/**
 * Stateful scanner for DEC private mode 2031 (`CSI ?2031h` subscribe / `CSI ?2031l` unsubscribe).
 * Holds provisional subscribe decisions if the chunk ends mid private-mode sequence so `;2031l` overrides cleanly.
 */
export function scanMode2031ReplyDecision(previousState, data) {
  const prev = previousState || { tail: '', pendingSubscribe: false };
  if (!prev.pendingSubscribe && !prev.tail && (typeof data !== 'string' || (!data.includes('\x1b') && !data.includes('\x9b')))) {
    return { decision: null, state: { tail: '', pendingSubscribe: false } };
  }
  const input = prev.tail + (typeof data === 'string' ? data : '');
  const tailStart = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'));
  let nextTail = '';
  if (tailStart !== -1) {
    const candidate = input.slice(tailStart);
    if (candidate.length <= MODE_2031_TAIL_LIMIT) {
      if (candidate === '\x1b' || candidate === '\x1b[' || candidate === '\x9b'
        || ((candidate.startsWith('\x1b[?') || candidate.startsWith('\x9b?')) && /^[0-9;]*$/.test(candidate.slice(candidate.startsWith('\x1b') ? 3 : 2)))) {
        nextTail = candidate;
      }
    }
  }

  let finalState = null;
  const re = /\x1b\[\?([0-9;]+)([hl])|\x9b\?([0-9;]+)([hl])/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    const params = match[1] ?? match[3];
    if (!params.split(';').some((p) => Number(p) === 2031)) continue;
    finalState = (match[2] ?? match[4]) === 'h' ? 'subscribed' : 'unsubscribed';
  }

  let decision = finalState;
  let pendingSubscribe = Boolean(prev.pendingSubscribe);
  if (finalState === 'unsubscribed') {
    pendingSubscribe = false;
  } else if (finalState === 'subscribed' || pendingSubscribe) {
    if (nextTail.length > 0) {
      decision = null;
      pendingSubscribe = true;
    } else {
      decision = 'subscribed';
      pendingSubscribe = false;
    }
  }
  return { decision, state: { tail: nextTail, pendingSubscribe } };
}

/**
 * Coalesces OSC 52 clipboard writes to the latest payload per microtask to avoid UI/IPC storms.
 */
export function createOsc52Coalescer(writeFn) {
  let pending = null;
  let scheduled = false;
  return (text) => {
    if (typeof text !== 'string' || !text) return;
    pending = text;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const value = pending;
      pending = null;
      if (value !== null) writeFn?.(value);
    });
  };
}

/** Check if data looks like an xterm X10 or SGR mouse click/release/drag sequence. */
export function isXtermMouseReport(data) {
  if (typeof data !== 'string' || data.length < 6) return false;
  return /^\x1b\[M[\s\S]{3}$/.test(data) || /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
}

/**
 * Defers mouse button press/release PTY forwarding briefly on link-modifier clicks (Meta/Ctrl+click)
 * or claims & drops mouse reports once a terminal link activation fires.
 */
export function createLinkPtyMouseSuppressor(term, { isMac = false, globalObj = globalThis } = {}) {
  const el = term?.element;
  let suppressingDirect = false;
  let prevRequireAlt = null;
  let mouseDownDirect = false;

  const isDirectActivation = (e) => (isMac ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.ctrlKey && !e.metaKey && !e.altKey));

  const restore = () => {
    if (prevRequireAlt !== null && term?.options) {
      term.options.mouseEventsRequireAlt = prevRequireAlt;
      prevRequireAlt = null;
    }
    suppressingDirect = false;
    mouseDownDirect = false;
  };

  const onMouseDown = (e) => {
    if (e.button !== 0 || !isDirectActivation(e) || !term?.options) return;
    restore();
    prevRequireAlt = Boolean(term.options.mouseEventsRequireAlt);
    term.options.mouseEventsRequireAlt = true;
    suppressingDirect = true;
    mouseDownDirect = true;
  };

  const onMouseUp = () => {
    if (suppressingDirect) queueMicrotask(restore);
  };

  el?.addEventListener?.('mousedown', onMouseDown, true);
  el?.addEventListener?.('mouseup', onMouseUp, true);
  globalObj.addEventListener?.('blur', restore);

  return {
    claimAction() {
      if (!mouseDownDirect && !suppressingDirect) return false;
      return true;
    },
    shouldSuppressReport(data) {
      return (suppressingDirect || mouseDownDirect) && isXtermMouseReport(data);
    },
    dispose() {
      restore();
      el?.removeEventListener?.('mousedown', onMouseDown, true);
      el?.removeEventListener?.('mouseup', onMouseUp, true);
      globalObj.removeEventListener?.('blur', restore);
    },
  };
}
