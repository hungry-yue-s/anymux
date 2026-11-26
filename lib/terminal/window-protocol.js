/**
 * Binary & control framing for multi-pane `/ws/window-stream/:windowId`.
 *
 * Output frame (0x01, 9B header):   [kind:u8][paneNum:u32BE][seq:u32BE][raw VT bytes...]
 * Snapshot frame (0x02, 21B header): [kind:u8][paneNum:u32BE][seq:u32BE][cols:u16BE][rows:u16BE][historyLines:u32BE][historyTotal:u32BE][raw VT bytes...]
 */
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_DIMENSION } from './protocol.js';

export const BINARY_FRAME_OUTPUT = 0x01;
export const BINARY_FRAME_SNAPSHOT = 0x02;
export const OUTPUT_HEADER_BYTES = 9;
export const SNAPSHOT_HEADER_BYTES = 21;

export const OUTPUT_IDLE_AFTER_MS = 10;
export const OUTPUT_BURST_FLUSH_MS = 2;
export const OUTPUT_MAX_BATCH_BYTES = 32 * 1024;

const MAX_UINT32 = 0xffffffff;
const NATIVE_SNAPSHOT_HEADER = Buffer.from('\x1bc\x1b[?25l\x1b[?7h\x1b[?6l\x1b[4l');
const ROW_PREFIX = Buffer.from('\x1b[0m\x0f\x1b(B\x1b)0');
const ROW_SUFFIX = Buffer.from('\x1b]8;;\x1b\\');
const ALT_ENTER = Buffer.from('\x1b[?1049h\x1b[H');
const POSTAMBLE = Buffer.from('\x1b[3g');
const CSI_PREFIX = Buffer.from('\x1b[');
const OSC8_PREFIX = Buffer.from('\x1b]8;');

function collectRowStarts(buf, start, end) {
  const starts = [];
  let pos = start;
  while (pos < end) {
    const idx = buf.indexOf(ROW_PREFIX, pos);
    if (idx === -1 || idx >= end) break;
    starts.push(idx);
    pos = idx + ROW_PREFIX.length;
  }
  return starts;
}

function hasDefaultAttributesAt(buf, contentStart, pos) {
  const lastOsc = buf.lastIndexOf(OSC8_PREFIX, pos - 1);
  if (lastOsc >= contentStart) {
    const closesDefault = lastOsc + ROW_SUFFIX.length <= pos
      && buf.compare(ROW_SUFFIX, 0, ROW_SUFFIX.length, lastOsc, lastOsc + ROW_SUFFIX.length) === 0;
    if (!closesDefault) return false;
  }
  const lastCsi = buf.lastIndexOf(CSI_PREFIX, pos - 1);
  if (lastCsi < contentStart) return true;
  let end = lastCsi + CSI_PREFIX.length;
  while (end < pos) {
    const b = buf[end];
    if (b >= 0x40 && b <= 0x7e) break;
    end++;
  }
  if (end >= pos || buf[end] !== 0x6d) return false;
  const paramLen = end - (lastCsi + CSI_PREFIX.length);
  return paramLen === 0 || (paramLen === 1 && buf[lastCsi + CSI_PREFIX.length] === 0x30);
}

function appendStrippedRows(chunks, buf, starts, fromIdx, sectionEnd) {
  for (let i = fromIdx; i < starts.length; i++) {
    const rowStart = starts[i];
    const rowEnd = i + 1 < starts.length ? starts[i + 1] : sectionEnd;
    const contentStart = rowStart + ROW_PREFIX.length;
    const suffixPos = buf.lastIndexOf(ROW_SUFFIX, rowEnd - ROW_SUFFIX.length);
    if (suffixPos < contentStart) {
      chunks.push(buf.subarray(rowStart, rowEnd));
      continue;
    }
    const trailerPos = suffixPos + ROW_SUFFIX.length;
    const hasCrlf = trailerPos + 2 <= rowEnd && buf[trailerPos] === 0x0d && buf[trailerPos + 1] === 0x0a;
    const isWrapped = i + 1 < starts.length && !hasCrlf;
    if (isWrapped) {
      chunks.push(buf.subarray(rowStart, rowEnd));
      continue;
    }
    let spaceStart = suffixPos;
    while (spaceStart > contentStart && buf[spaceStart - 1] === 0x20) spaceStart--;
    if (spaceStart < suffixPos && hasDefaultAttributesAt(buf, contentStart, spaceStart)) {
      chunks.push(buf.subarray(rowStart, spaceStart), buf.subarray(suffixPos, rowEnd));
    } else {
      chunks.push(buf.subarray(rowStart, rowEnd));
    }
  }
}

/**
 * Bounds scrollback on native `input_snapshot()` VT payloads without breaking
 * wrapped lines and strips lossless trailing default-background spaces.
 */
export function compactNativeSnapshot(raw, { rows, maxHistoryLines = 200 } = {}) {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  if (data.length < NATIVE_SNAPSHOT_HEADER.length
    || data.compare(NATIVE_SNAPSHOT_HEADER, 0, NATIVE_SNAPSHOT_HEADER.length, 0, NATIVE_SNAPSHOT_HEADER.length) !== 0) {
    return { data, historyLines: null, historyTotal: null };
  }
  const firstRow = data.indexOf(ROW_PREFIX, NATIVE_SNAPSHOT_HEADER.length);
  const postambleStart = data.lastIndexOf(POSTAMBLE);
  if (firstRow === -1 || postambleStart === -1 || postambleStart <= firstRow) {
    return { data, historyLines: null, historyTotal: null };
  }
  const altMarker = data.indexOf(ALT_ENTER, firstRow);
  const hasAlt = altMarker !== -1 && altMarker < postambleStart;
  const normalEnd = hasAlt ? altMarker : postambleStart;
  const normalStarts = collectRowStarts(data, firstRow, normalEnd);
  if (!normalStarts.length) {
    return { data, historyLines: null, historyTotal: null };
  }

  const histCount = Number.isInteger(rows) && rows > 0 ? Math.max(0, normalStarts.length - rows) : 0;
  let cutIdx = 0;
  if (Number.isInteger(maxHistoryLines) && maxHistoryLines >= 0 && histCount > maxHistoryLines) {
    cutIdx = histCount - maxHistoryLines;
    // Never slice inside a soft-wrapped logical line.
    while (cutIdx < histCount && (normalStarts[cutIdx] < 2 || data[normalStarts[cutIdx] - 2] !== 0x0d || data[normalStarts[cutIdx] - 1] !== 0x0a)) {
      cutIdx++;
    }
  }

  const chunks = [data.subarray(0, firstRow)];
  appendStrippedRows(chunks, data, normalStarts, cutIdx, normalEnd);
  if (hasAlt) {
    const altGridStart = altMarker + ALT_ENTER.length;
    chunks.push(data.subarray(altMarker, altGridStart));
    const altStarts = collectRowStarts(data, altGridStart, postambleStart);
    if (altStarts.length) {
      if (altStarts[0] > altGridStart) chunks.push(data.subarray(altGridStart, altStarts[0]));
      appendStrippedRows(chunks, data, altStarts, 0, postambleStart);
    } else {
      chunks.push(data.subarray(altGridStart, postambleStart));
    }
  }
  chunks.push(data.subarray(postambleStart));

  return {
    data: Buffer.concat(chunks),
    historyLines: histCount - cutIdx,
    historyTotal: histCount,
  };
}

export function parsePaneNum(paneId) {
  const match = /^%(\d+)$/.exec(String(paneId || ''));
  if (!match) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane identity');
  const num = Number(match[1]);
  if (!Number.isSafeInteger(num) || num < 0 || num > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Pane number out of range');
  }
  return num;
}

export function encodeOutputFrame(paneNum, seq, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  if (!Number.isInteger(paneNum) || paneNum < 0 || paneNum > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid output frame pane');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid output frame sequence');
  }
  const frame = Buffer.allocUnsafe(OUTPUT_HEADER_BYTES + data.length);
  frame[0] = BINARY_FRAME_OUTPUT;
  frame.writeUInt32BE(paneNum, 1);
  frame.writeUInt32BE(seq, 5);
  if (data.length) data.copy(frame, OUTPUT_HEADER_BYTES);
  return frame;
}

export function encodeSnapshotFrame({ paneNum, seq = 0, cols, rows, historyLines = 0, historyTotal = 0, data }) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  if (!Number.isInteger(paneNum) || paneNum < 0 || paneNum > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot frame pane');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot frame sequence');
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot frame size');
  }
  const lines = Number.isInteger(historyLines) && historyLines >= 0 ? Math.min(historyLines, MAX_UINT32) : 0;
  const total = Number.isInteger(historyTotal) && historyTotal >= 0 ? Math.min(historyTotal, MAX_UINT32) : 0;
  const frame = Buffer.allocUnsafe(SNAPSHOT_HEADER_BYTES + payload.length);
  frame[0] = BINARY_FRAME_SNAPSHOT;
  frame.writeUInt32BE(paneNum, 1);
  frame.writeUInt32BE(seq, 5);
  frame.writeUInt16BE(cols, 9);
  frame.writeUInt16BE(rows, 11);
  frame.writeUInt32BE(lines, 13);
  frame.writeUInt32BE(total, 17);
  if (payload.length) payload.copy(frame, SNAPSHOT_HEADER_BYTES);
  return frame;
}

export function decodeBinaryFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length < 1) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Empty binary frame');
  const kind = buf[0];
  if (kind === BINARY_FRAME_OUTPUT) {
    if (buf.length < OUTPUT_HEADER_BYTES) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Truncated output binary frame');
    const paneNum = buf.readUInt32BE(1);
    return {
      kind: 'output',
      paneNum,
      paneId: `%${paneNum}`,
      seq: buf.readUInt32BE(5),
      data: buf.subarray(OUTPUT_HEADER_BYTES),
    };
  }
  if (kind === BINARY_FRAME_SNAPSHOT) {
    if (buf.length < SNAPSHOT_HEADER_BYTES) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Truncated snapshot binary frame');
    const paneNum = buf.readUInt32BE(1);
    const cols = buf.readUInt16BE(9);
    const rows = buf.readUInt16BE(11);
    if (cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot dimensions');
    }
    return {
      kind: 'snapshot',
      paneNum,
      paneId: `%${paneNum}`,
      seq: buf.readUInt32BE(5),
      cols,
      rows,
      historyLines: buf.readUInt32BE(13),
      historyTotal: buf.readUInt32BE(17),
      data: buf.subarray(SNAPSHOT_HEADER_BYTES),
    };
  }
  throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported binary frame kind');
}

export function parseWindowStreamTarget(pathname, query) {
  let windowId;
  try {
    const match = /^\/ws\/window-stream\/([^/]+)$/.exec(pathname);
    if (!match) throw new Error();
    windowId = decodeURIComponent(match[1]);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid window stream address');
  }
  if (query.get('protocol') !== '1') {
    throw new AppError(ErrorCode.UNSUPPORTED, 'Unsupported window stream protocol');
  }
  const instanceId = query.get('instanceId');
  const sessionId = query.get('sessionId');
  if (!/^\d+:\d+$/.test(String(instanceId || '')) || !/^\$\d+$/.test(String(sessionId || '')) || !/^@\d+$/.test(windowId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid window stream target identity');
  }
  return { instanceId, sessionId, windowId };
}

/**
 * Per-pane adaptive binary output coalescer.
 * Flushes immediately on idle (0 ms) to preserve keystroke echo responsiveness,
 * coalescing rapid burst chunks for `burstMs` (up to `maxBytes`) to avoid WS framing storms.
 */
export function createBinaryOutputBatcher(onFlush, {
  now = Date.now,
  burstMs = OUTPUT_BURST_FLUSH_MS,
  idleAfterMs = OUTPUT_IDLE_AFTER_MS,
  maxBytes = OUTPUT_MAX_BATCH_BYTES,
} = {}) {
  const panes = new Map();

  function getEntry(paneId) {
    let entry = panes.get(paneId);
    if (!entry) {
      entry = { chunks: [], bytes: 0, timer: null, lastFlush: 0 };
      panes.set(paneId, entry);
    }
    return entry;
  }

  function flush(paneId) {
    const entry = panes.get(paneId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.chunks.length === 0) return;
    const merged = entry.chunks.length === 1 ? entry.chunks[0] : Buffer.concat(entry.chunks, entry.bytes);
    entry.chunks = [];
    entry.bytes = 0;
    entry.lastFlush = now();
    onFlush(paneId, merged);
  }

  return {
    push(paneId, raw) {
      if (!raw || raw.length === 0) return;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const entry = getEntry(paneId);
      if (!entry.timer && entry.chunks.length === 0 && (now() - entry.lastFlush > idleAfterMs || burstMs <= 0)) {
        entry.lastFlush = now();
        onFlush(paneId, bytes);
        return;
      }
      entry.chunks.push(bytes);
      entry.bytes += bytes.length;
      if (entry.bytes >= maxBytes) {
        flush(paneId);
        return;
      }
      if (!entry.timer) {
        entry.timer = setTimeout(() => flush(paneId), burstMs);
        entry.timer.unref?.();
      }
    },
    flush,
    discard(paneId) {
      const entry = panes.get(paneId);
      if (!entry) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.chunks = [];
      entry.bytes = 0;
    },
    flushAll() {
      for (const paneId of [...panes.keys()]) flush(paneId);
    },
    dispose() {
      for (const entry of panes.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      panes.clear();
    },
  };
}
