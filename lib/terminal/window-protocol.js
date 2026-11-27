/**
 * Binary & control framing for multi-pane `/ws/window-stream/:windowId`.
 *
 * Output frame (0x01, 9B header):          [kind:u8][paneNum:u32BE][seq:u32BE][raw VT bytes...]
 * Snapshot frame (0x02, 21B header):       [kind:u8][paneNum:u32BE][seq:u32BE][cols:u16BE][rows:u16BE][historyLines:u32BE][historyTotal:u32BE][raw VT bytes...]
 * Snapshot chunk frame (0x03, 25B header): [kind:u8][paneNum:u32BE][seq:u32BE][cols:u16BE][rows:u16BE][historyLines:u32BE][historyTotal:u32BE][chunkIndex:u16BE][chunkCount:u16BE][chunk VT bytes...]
 */
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_DIMENSION } from './protocol.js';
import {
  INITIAL_SYNC_LATCH,
  resolveSynchronizedOutputSafeSplitBuffer,
  scanSynchronizedOutput,
} from './synchronized-output.js';

export const BINARY_FRAME_OUTPUT = 0x01;
export const BINARY_FRAME_SNAPSHOT = 0x02;
export const BINARY_FRAME_SNAPSHOT_CHUNK = 0x03;
export const OUTPUT_HEADER_BYTES = 9;
export const SNAPSHOT_HEADER_BYTES = 21;
export const SNAPSHOT_CHUNK_HEADER_BYTES = 25;
export const SNAPSHOT_CHUNK_PAYLOAD_BYTES = 48 * 1024;
export const SNAPSHOT_DEGRADATION_LADDER = Object.freeze([2000, 1000, 500, 250, 100, 25, 0]);

export const OUTPUT_IDLE_AFTER_MS = 10;
export const OUTPUT_BURST_FLUSH_MS = 2;
export const OUTPUT_MAX_BATCH_BYTES = 32 * 1024;

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const NATIVE_SNAPSHOT_HEADER = Buffer.from('\x1bc\x1b[?25l\x1b[?7h\x1b[?6l\x1b[4l');
const ROW_PREFIX = Buffer.from('\x1b[0m\x0f\x1b(B\x1b)0');
const ROW_SUFFIX = Buffer.from('\x1b]8;;\x1b\\');
const CRLF = Buffer.from('\r\n');
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

function buildStrippedRowParts(buf, starts, fromIdx, sectionEnd) {
  const out = [];
  for (let i = fromIdx; i < starts.length; i++) {
    const rowStart = starts[i];
    const rowEnd = i + 1 < starts.length ? starts[i + 1] : sectionEnd;
    const contentStart = rowStart + ROW_PREFIX.length;
    const suffixPos = buf.lastIndexOf(ROW_SUFFIX, rowEnd - ROW_SUFFIX.length);
    if (suffixPos < contentStart) {
      out.push(buf.subarray(rowStart, rowEnd));
      continue;
    }
    const trailerPos = suffixPos + ROW_SUFFIX.length;
    const hasCrlf = trailerPos + 2 <= rowEnd && buf[trailerPos] === 0x0d && buf[trailerPos + 1] === 0x0a;
    const isWrapped = i + 1 < starts.length && !hasCrlf;
    if (isWrapped) {
      out.push(buf.subarray(rowStart, rowEnd));
      continue;
    }
    let spaceStart = suffixPos;
    while (spaceStart > contentStart && buf[spaceStart - 1] === 0x20) spaceStart--;
    if (spaceStart < suffixPos && hasDefaultAttributesAt(buf, contentStart, spaceStart)) {
      out.push(Buffer.concat([buf.subarray(rowStart, spaceStart), buf.subarray(suffixPos, rowEnd)]));
    } else {
      out.push(buf.subarray(rowStart, rowEnd));
    }
  }
  return out;
}

function buildExtraHistoryRowParts(extraHistoryBytes) {
  if (!extraHistoryBytes) return [];
  const buf = Buffer.isBuffer(extraHistoryBytes) ? extraHistoryBytes : Buffer.from(extraHistoryBytes);
  if (!buf.length) return [];
  const rows = [];
  let start = 0;
  while (start <= buf.length) {
    const nl = buf.indexOf(0x0a, start);
    let end = nl === -1 ? buf.length : nl;
    if (end > start && buf[end - 1] === 0x0d) end--;
    const line = buf.subarray(start, end);
    rows.push(Buffer.concat([ROW_PREFIX, line, ROW_SUFFIX, CRLF]));
    if (nl === -1) break;
    start = nl + 1;
  }
  return rows;
}

function buildBudgetLimits(maxHistoryLines, maxBytes) {
  const normalized = Number.isInteger(maxHistoryLines) && maxHistoryLines >= 0 ? maxHistoryLines : null;
  if (!(maxBytes > 0)) return [normalized];
  if (normalized === null) return [null, ...SNAPSHOT_DEGRADATION_LADDER];
  const limits = [normalized];
  for (const step of SNAPSHOT_DEGRADATION_LADDER) {
    if (step < normalized) limits.push(step);
  }
  if (limits[limits.length - 1] !== 0) limits.push(0);
  return limits;
}

/**
 * Bounds scrollback on native `input_snapshot()` VT payloads without breaking
 * wrapped lines, strips lossless trailing default-background spaces, optionally
 * splices older ANSI capture-pane lines before the first row, and enforces
 * Orca-style byte-budget degradation steps when `maxBytes` is set.
 */
export function compactNativeSnapshot(raw, { rows, maxHistoryLines = 2000, extraHistoryBytes = null, maxBytes = 0 } = {}) {
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

  const baseHistCount = Number.isInteger(rows) && rows > 0 ? Math.max(0, normalStarts.length - rows) : 0;
  const extraParts = buildExtraHistoryRowParts(extraHistoryBytes);
  const extraCount = extraParts.length;
  const totalHistCount = extraCount + baseHistCount;

  const headerBuf = data.subarray(0, firstRow);
  const normalParts = buildStrippedRowParts(data, normalStarts, 0, normalEnd);
  const altChunks = [];
  let altBytes = 0;
  if (hasAlt) {
    const altGridStart = altMarker + ALT_ENTER.length;
    altChunks.push(data.subarray(altMarker, altGridStart));
    altBytes += altGridStart - altMarker;
    const altStarts = collectRowStarts(data, altGridStart, postambleStart);
    if (altStarts.length) {
      if (altStarts[0] > altGridStart) {
        const pre = data.subarray(altGridStart, altStarts[0]);
        altChunks.push(pre);
        altBytes += pre.length;
      }
      const altParts = buildStrippedRowParts(data, altStarts, 0, postambleStart);
      for (const part of altParts) {
        altChunks.push(part);
        altBytes += part.length;
      }
    } else {
      const rest = data.subarray(altGridStart, postambleStart);
      altChunks.push(rest);
      altBytes += rest.length;
    }
  }
  const postambleBuf = data.subarray(postambleStart);
  const fixedBytes = headerBuf.length + altBytes + postambleBuf.length;

  const extraSuffixBytes = new Array(extraCount + 1);
  extraSuffixBytes[extraCount] = 0;
  for (let i = extraCount - 1; i >= 0; i--) {
    extraSuffixBytes[i] = extraSuffixBytes[i + 1] + extraParts[i].length;
  }
  const normalSuffixBytes = new Array(normalParts.length + 1);
  normalSuffixBytes[normalParts.length] = 0;
  for (let i = normalParts.length - 1; i >= 0; i--) {
    normalSuffixBytes[i] = normalSuffixBytes[i + 1] + normalParts[i].length;
  }

  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  const limits = buildBudgetLimits(maxHistoryLines, budget);
  let chosenExtraStart = extraCount;
  let chosenCutIdx = 0;
  for (let i = 0; i < limits.length; i++) {
    const limit = limits[i];
    let extraStartIdx = 0;
    let cutIdx = 0;
    if (limit !== null && limit >= 0 && totalHistCount > limit) {
      const keepExtra = Math.max(0, limit - baseHistCount);
      extraStartIdx = extraCount - keepExtra;
      if (limit < baseHistCount) {
        cutIdx = baseHistCount - limit;
        // Never slice inside a soft-wrapped logical line.
        while (cutIdx < baseHistCount && (normalStarts[cutIdx] < 2 || data[normalStarts[cutIdx] - 2] !== 0x0d || data[normalStarts[cutIdx] - 1] !== 0x0a)) {
          cutIdx++;
        }
      }
    }
    const candidateBytes = fixedBytes + extraSuffixBytes[extraStartIdx] + normalSuffixBytes[cutIdx];
    chosenExtraStart = extraStartIdx;
    chosenCutIdx = cutIdx;
    if (!budget || candidateBytes <= budget || limit === 0 || i === limits.length - 1) {
      break;
    }
  }

  const chunks = [headerBuf];
  for (let i = chosenExtraStart; i < extraCount; i++) chunks.push(extraParts[i]);
  for (let i = chosenCutIdx; i < normalParts.length; i++) chunks.push(normalParts[i]);
  for (const part of altChunks) chunks.push(part);
  chunks.push(postambleBuf);

  return {
    data: Buffer.concat(chunks),
    historyLines: (extraCount - chosenExtraStart) + (baseHistCount - chosenCutIdx),
    historyTotal: totalHistCount,
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

export function encodeSnapshotChunkFrames({
  paneNum,
  seq = 0,
  cols,
  rows,
  historyLines = 0,
  historyTotal = 0,
  data,
  chunkBytes = SNAPSHOT_CHUNK_PAYLOAD_BYTES,
}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot chunk size');
  }
  if (payload.length <= chunkBytes) {
    return [encodeSnapshotFrame({ paneNum, seq, cols, rows, historyLines, historyTotal, data: payload })];
  }
  if (!Number.isInteger(paneNum) || paneNum < 0 || paneNum > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot frame pane');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_UINT32) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot frame sequence');
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot frame size');
  }
  const chunkCount = Math.ceil(payload.length / chunkBytes);
  if (chunkCount > MAX_UINT16) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Snapshot payload exceeds maximum chunk count');
  }
  const lines = Number.isInteger(historyLines) && historyLines >= 0 ? Math.min(historyLines, MAX_UINT32) : 0;
  const total = Number.isInteger(historyTotal) && historyTotal >= 0 ? Math.min(historyTotal, MAX_UINT32) : 0;
  const frames = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkBytes;
    const end = Math.min(payload.length, start + chunkBytes);
    const slice = payload.subarray(start, end);
    const frame = Buffer.allocUnsafe(SNAPSHOT_CHUNK_HEADER_BYTES + slice.length);
    frame[0] = BINARY_FRAME_SNAPSHOT_CHUNK;
    frame.writeUInt32BE(paneNum, 1);
    frame.writeUInt32BE(seq, 5);
    frame.writeUInt16BE(cols, 9);
    frame.writeUInt16BE(rows, 11);
    frame.writeUInt32BE(lines, 13);
    frame.writeUInt32BE(total, 17);
    frame.writeUInt16BE(i, 21);
    frame.writeUInt16BE(chunkCount, 23);
    if (slice.length) slice.copy(frame, SNAPSHOT_CHUNK_HEADER_BYTES);
    frames[i] = frame;
  }
  return frames;
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
  if (kind === BINARY_FRAME_SNAPSHOT_CHUNK) {
    if (buf.length < SNAPSHOT_CHUNK_HEADER_BYTES) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Truncated snapshot chunk binary frame');
    const paneNum = buf.readUInt32BE(1);
    const cols = buf.readUInt16BE(9);
    const rows = buf.readUInt16BE(11);
    const chunkIndex = buf.readUInt16BE(21);
    const chunkCount = buf.readUInt16BE(23);
    if (cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot dimensions');
    }
    if (chunkCount < 1 || chunkIndex >= chunkCount) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid snapshot chunk index');
    }
    return {
      kind: 'snapshot-chunk',
      paneNum,
      paneId: `%${paneNum}`,
      seq: buf.readUInt32BE(5),
      cols,
      rows,
      historyLines: buf.readUInt32BE(13),
      historyTotal: buf.readUInt32BE(17),
      chunkIndex,
      chunkCount,
      data: buf.subarray(SNAPSHOT_CHUNK_HEADER_BYTES),
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
  const rawDevice = query.get('device');
  const rawPaneId = query.get('paneId');
  const device = rawDevice === 'mobile' || rawDevice === 'desktop' ? rawDevice : null;
  const paneId = /^%\d+$/.test(String(rawPaneId || '')) ? rawPaneId : null;
  const ack = query.get('ack') === '1';
  return {
    instanceId,
    sessionId,
    windowId,
    ...(device ? { device } : {}),
    ...(paneId ? { paneId } : {}),
    ...(ack ? { ack: true } : {}),
  };
}

/**
 * Per-pane adaptive binary output coalescer.
 * Flushes immediately on idle (0 ms) to preserve keystroke echo responsiveness,
 * coalescing rapid burst chunks for `burstMs` (or per-pane `getBurstMs(paneId)`,
 * up to `maxBytes`) to avoid WS framing storms.
 */
export function createBinaryOutputBatcher(onFlush, {
  now = Date.now,
  burstMs = OUTPUT_BURST_FLUSH_MS,
  idleAfterMs = OUTPUT_IDLE_AFTER_MS,
  maxBytes = OUTPUT_MAX_BATCH_BYTES,
  getBurstMs = null,
} = {}) {
  const panes = new Map();

  function getEntry(paneId) {
    let entry = panes.get(paneId);
    if (!entry) {
      entry = { chunks: [], bytes: 0, timer: null, lastFlush: 0, syncLatch: INITIAL_SYNC_LATCH };
      panes.set(paneId, entry);
    }
    return entry;
  }

  function emitWithLatch(paneId, entry, payload) {
    const scan = scanSynchronizedOutput(payload, entry.syncLatch.markerTail, entry.syncLatch.active);
    entry.syncLatch = { markerTail: scan.markerTail, active: scan.active };
    entry.lastFlush = now();
    onFlush(paneId, payload);
  }

  function flush(paneId) {
    const entry = panes.get(paneId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.chunks.length === 0) return;
    let merged = entry.chunks.length === 1 ? entry.chunks[0] : Buffer.concat(entry.chunks, entry.bytes);
    entry.chunks = [];
    entry.bytes = 0;

    const hasSyncMarkers = entry.syncLatch.active || merged.includes('\x1b[?2026');
    if (hasSyncMarkers) {
      while (merged.length > maxBytes) {
        const splitAt = resolveSynchronizedOutputSafeSplitBuffer(
          merged,
          maxBytes,
          entry.syncLatch.markerTail,
          entry.syncLatch.active,
        );
        const cut = splitAt > 0 && splitAt <= merged.length ? splitAt : maxBytes;
        emitWithLatch(paneId, entry, merged.subarray(0, cut));
        merged = merged.subarray(cut);
      }
    }
    if (merged.length > 0) {
      emitWithLatch(paneId, entry, merged);
    }
  }

  return {
    push(paneId, raw) {
      if (!raw || raw.length === 0) return;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const entry = getEntry(paneId);
      const effectiveBurstMs = typeof getBurstMs === 'function' ? getBurstMs(paneId) : burstMs;
      if (!entry.timer && entry.chunks.length === 0 && (now() - entry.lastFlush > idleAfterMs || effectiveBurstMs <= 0)) {
        if (bytes.length <= maxBytes || (!entry.syncLatch.active && !bytes.includes('\x1b[?2026'))) {
          emitWithLatch(paneId, entry, bytes);
          return;
        }
      }
      entry.chunks.push(bytes);
      entry.bytes += bytes.length;
      if (entry.bytes >= maxBytes) {
        flush(paneId);
        return;
      }
      if (!entry.timer) {
        entry.timer = setTimeout(() => flush(paneId), effectiveBurstMs);
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
      entry.syncLatch = INITIAL_SYNC_LATCH;
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
