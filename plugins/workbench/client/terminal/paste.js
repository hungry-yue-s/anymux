// Bracketed paste sanitization, UTF-8 safe chunking, and Ctrl+C stale paste-mode leak protection.
// Ported from stablyai/orca (MIT).

export const ESCAPE = '\u001b';
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`;
export const INERT_ESCAPE = '\u241b';
export const DEFAULT_PASTE_CHUNK_MAX_BYTES = 32 * 1024;

const BRACKETED_PASTE_MODE_RE = /\x1b\[\?(?:\d+;)*2004(?:;\d+)*[hl]/;
const BRACKETED_PASTE_TAIL_MAX = 128;
const LINE_BREAK_RE = /[\r\n]/;

/**
 * Replace embedded ESC (0x1b) with printable ␛ (U+241B) so pasted bytes
 * cannot close bracketed-paste framing prematurely or execute escape payloads.
 */
export function sanitizeBracketedPasteText(text) {
  if (typeof text !== 'string' || !text.includes(ESCAPE)) return String(text || '');
  return text.replaceAll(ESCAPE, INERT_ESCAPE);
}

/** Normalize CRLF/LF to CR so direct paste frames match xterm's paste behavior. */
export function normalizeTerminalPasteLineEndings(text) {
  return String(text || '').replace(/\r?\n/g, '\r');
}

/** Wrap text in bracketed paste start/end markers with sanitized ESC bytes and normalized CR endings. */
export function wrapTerminalBracketedPasteText(text) {
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizeTerminalPasteLineEndings(text))}${BRACKETED_PASTE_END}`;
}

function utf8CodePointByteLength(cp) {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * Iterate string slices whose encoded UTF-8 length never exceeds `maxBytes`
 * and never splits surrogate pairs across chunk boundaries.
 */
export function* iterateUtf8InputChunks(text, maxBytes = DEFAULT_PASTE_CHUNK_MAX_BYTES) {
  const str = typeof text === 'string' ? text : String(text || '');
  if (!str) return;
  const limit = Math.max(4, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : DEFAULT_PASTE_CHUNK_MAX_BYTES);
  let sliceStart = 0;
  let chunkBytes = 0;

  for (let i = 0; i < str.length; i += 1) {
    const cp = str.codePointAt(i);
    const units = cp > 0xffff ? 2 : 1;
    const cpBytes = utf8CodePointByteLength(cp);
    if (chunkBytes > 0 && chunkBytes + cpBytes > limit) {
      yield str.slice(sliceStart, i);
      sliceStart = i;
      chunkBytes = cpBytes;
    } else {
      chunkBytes += cpBytes;
    }
    if (units === 2) i += 1;
  }
  if (sliceStart < str.length) {
    yield str.slice(sliceStart);
  }
}

const interruptedTerms = new WeakSet();
const outputTails = new WeakMap();

/** Mark a terminal whose active TUI was interrupted with Ctrl+C while bracketed paste mode was on. */
export function markTerminalBracketedPasteInterrupted(term) {
  if (term?.modes?.bracketedPasteMode) {
    interruptedTerms.add(term);
  }
}

/** Clear interrupted paste state once the PTY explicitly re-emits DECSET/DECRST ?2004. */
export function observeTerminalBracketedPasteModeOutput(term, data) {
  if (!term || !interruptedTerms.has(term) || typeof data !== 'string' || !data) {
    if (term && !interruptedTerms.has(term)) outputTails.delete(term);
    return;
  }
  const combined = (outputTails.get(term) || '') + data;
  outputTails.set(term, combined.slice(-BRACKETED_PASTE_TAIL_MAX));
  if (BRACKETED_PASTE_MODE_RE.test(combined)) {
    interruptedTerms.delete(term);
    outputTails.delete(term);
  }
}

/**
 * Paste text safely into an xterm instance:
 * - Sanitize embedded ESC bytes.
 * - After Ctrl+C with stale bracketedPasteMode, omit ^[[200~ wrappers on single-line text so shells do not leak `^[[200~`.
 * - Multi-line text or `forceBracketedPaste` (image/file path injection) always retains bracketed paste.
 */
export function pasteTerminalText(term, text, options = {}) {
  if (!term || typeof text !== 'string') return false;
  const sanitized = sanitizeBracketedPasteText(text);
  if (options.forceBracketedPaste && typeof term.input === 'function') {
    term.input(wrapTerminalBracketedPasteText(sanitized));
    return true;
  }
  if (!interruptedTerms.has(term) || !term.modes?.bracketedPasteMode || LINE_BREAK_RE.test(sanitized)) {
    if (interruptedTerms.has(term) && !term.modes?.bracketedPasteMode) {
      interruptedTerms.delete(term);
      outputTails.delete(term);
    }
    if (typeof term.paste === 'function') {
      term.paste(sanitized);
    } else if (typeof options.sendFallback === 'function') {
      options.sendFallback(wrapTerminalBracketedPasteText(sanitized));
    }
    return true;
  }

  // Single-line paste after interrupted TUI: suppress stale bracketed-paste wrappers temporarily.
  const prevIgnore = term.options?.ignoreBracketedPasteMode;
  if (term.options) term.options.ignoreBracketedPasteMode = true;
  try {
    if (typeof term.paste === 'function') {
      term.paste(sanitized);
    } else if (typeof options.sendFallback === 'function') {
      options.sendFallback(normalizeTerminalPasteLineEndings(sanitized));
    }
  } finally {
    if (term.options) term.options.ignoreBracketedPasteMode = prevIgnore;
  }
  return true;
}
