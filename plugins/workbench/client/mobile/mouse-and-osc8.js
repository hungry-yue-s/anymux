// Mobile DECCKM/mouse-mode tracker (X10, VT200, drag, any, SGR 1006, SGR-Pixels 1016)
// and touch tap OSC 8 hyperlink extraction.
// Ported from stablyai/orca (MIT).

const ESC = '\x1b';
const C1_CSI = '\x9b';
const SCAN_TAIL_LIMIT = 128;

export function createMobileModeTracker() {
  return {
    scanTail: '',
    applicationCursorKeysMode: false,
    mouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false,
    mouseEncodingKnown: false,
  };
}

export function scanMobileTerminalModes(state, data) {
  if (!state || typeof data !== 'string' || !data) return state;
  if (!state.scanTail && !data.includes(ESC) && !data.includes(C1_CSI)) return state;
  const input = state.scanTail + data;
  const escStart = Math.max(input.lastIndexOf(ESC), input.lastIndexOf(C1_CSI));
  state.scanTail = '';
  if (escStart !== -1) {
    const tail = input.slice(escStart);
    if (tail.length <= SCAN_TAIL_LIMIT) {
      if (tail === ESC || tail === `${ESC}[` || tail === C1_CSI
        || ((tail.startsWith(`${ESC}[?`) || tail.startsWith(`${C1_CSI}?`)) && /^[0-9;]*$/.test(tail.slice(tail.startsWith(ESC) ? 3 : 2)))) {
        state.scanTail = tail;
      }
    }
  }

  const re = /\x1bc|\x1b\[\?([0-9;]+)([hl])|\x9b\?([0-9;]+)([hl])/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    if (match[0] === `${ESC}c`) {
      state.applicationCursorKeysMode = false;
      state.mouseTrackingMode = 'none';
      state.sgrMouseMode = false;
      state.sgrMousePixelsMode = false;
      state.mouseEncodingKnown = true;
      continue;
    }
    const enabled = (match[2] || match[4]) === 'h';
    for (const raw of (match[1] || match[3]).split(';')) {
      if (!raw) continue;
      const param = Number(raw);
      if (param === 1) state.applicationCursorKeysMode = enabled;
      else if (param === 9) state.mouseTrackingMode = enabled ? 'x10' : 'none';
      else if (param === 1000) state.mouseTrackingMode = enabled ? 'vt200' : 'none';
      else if (param === 1002) state.mouseTrackingMode = enabled ? 'drag' : 'none';
      else if (param === 1003) state.mouseTrackingMode = enabled ? 'any' : 'none';
      else if (param === 1006) {
        state.mouseEncodingKnown = true;
        state.sgrMouseMode = enabled;
        state.sgrMousePixelsMode = false;
      } else if (param === 1016) {
        state.mouseEncodingKnown = true;
        state.sgrMouseMode = false;
        state.sgrMousePixelsMode = enabled;
      }
    }
  }
  return state;
}

function effectiveMouseMode(term, tracked) {
  const termMode = term?.modes?.mouseTrackingMode;
  if (termMode === 'x10' || termMode === 'vt200' || termMode === 'drag' || termMode === 'any' || termMode === 'sgr') return termMode;
  if (termMode === 'none') return tracked?.mouseTrackingMode && tracked.mouseTrackingMode !== 'none' ? tracked.mouseTrackingMode : 'none';
  return tracked?.mouseTrackingMode || 'none';
}

function isApplicationCursorKeys(term, tracked) {
  if (typeof term?.modes?.applicationCursorKeysMode === 'boolean') {
    return term.modes.applicationCursorKeysMode;
  }
  return Boolean(tracked?.applicationCursorKeysMode);
}

/**
 * Encode touch vertical scroll lines into mouse-wheel sequences (SGR-Pixels 1016 / SGR 1006 / X10)
 * or DECCKM/CSI cursor up/down on alternate screen; returns null if local scrollback should handle it.
 */
export function encodeMobileTouchScrollInput({ term, trackedModes, lines, cell, pixelX = 0, pixelY = 0 }) {
  if (!lines) return null;
  const count = Math.min(Math.abs(lines), 32);
  if (count <= 0) return null;

  const mouseMode = effectiveMouseMode(term, trackedModes);
  const btn = lines > 0 ? 65 : 64;

  if (mouseMode && mouseMode !== 'none' && mouseMode !== 'x10') {
    if (trackedModes?.sgrMousePixelsMode) {
      const px = Math.max(0, Math.round(pixelX));
      const py = Math.max(0, Math.round(pixelY));
      if (px <= 9999 && py <= 9999) {
        return `${ESC}[<${btn};${px};${py}M`.repeat(count);
      }
    }
    const mx = Math.max(1, (cell?.col ?? 0) + 1);
    const my = Math.max(1, (cell?.row ?? 0) + 1);
    // Default to SGR 1006 when sgrMouseMode is set, or xterm reports mouseTrackingMode and encoding wasn't explicitly set to X10/VT200
    if (trackedModes?.sgrMouseMode || (!trackedModes?.mouseEncodingKnown && term?.modes?.mouseTrackingMode === mouseMode)) {
      if (mx <= 9999 && my <= 9999) {
        return `${ESC}[<${btn};${mx};${my}M`.repeat(count);
      }
    }
    const b = btn + 32;
    const cx = mx + 32;
    const cy = my + 32;
    if (b <= 126 && cx <= 126 && cy <= 126) {
      return `${ESC}[M${String.fromCharCode(b)}${String.fromCharCode(cx)}${String.fromCharCode(cy)}`.repeat(count);
    }
  }

  if (term?.buffer?.active?.type === 'alternate') {
    const prefix = isApplicationCursorKeys(term, trackedModes) ? 'O' : '[';
    const arrow = lines > 0 ? 'B' : 'A';
    return `${ESC}${prefix}${arrow}`.repeat(count);
  }

  return null;
}

/**
 * Look up an OSC 8 URI on a buffer cell tapped on mobile.
 * Returns raw URI string or null if cell carries no OSC 8 link.
 */
export function readOsc8UriAtCell(term, col, absRow) {
  try {
    const line = term?.buffer?.active?.getLine?.(absRow);
    const cell = line?.getCell?.(col);
    const urlId = cell?.extended?.urlId;
    if (!urlId) return null;
    const core = term._core;
    const svc = core?._oscLinkService || core?._inputHandler?._oscLinkService;
    const data = svc?.getLinkData?.(urlId);
    return typeof data?.uri === 'string' && data.uri ? data.uri : null;
  } catch {
    return null;
  }
}
