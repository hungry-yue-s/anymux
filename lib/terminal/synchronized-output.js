// DEC 2026 synchronized-output scanner, safe split resolver, and dropped-latch recovery.
// Ported from stablyai/orca (MIT).

export const SYNC_START_SEQ = '\x1b[?2026h';
export const SYNC_END_SEQ = '\x1b[?2026l';
export const SYNC_END_BUFFER = Buffer.from(SYNC_END_SEQ, 'utf8');
export const SYNC_MARKER_TAIL_BYTES = SYNC_START_SEQ.length - 1;

export const INITIAL_SYNC_LATCH = Object.freeze({ markerTail: '', active: false });

/**
 * Scan chunk `data` with carry `markerTail` and prior `wasActive` state
 * to determine whether a DEC 2026 synchronized update frame stays open after the chunk.
 */
export function scanSynchronizedOutput(data, markerTail = '', wasActive = false) {
  const str = Buffer.isBuffer(data) ? data.toString('latin1') : String(data || '');
  const scanData = markerTail ? `${markerTail}${str}` : str;
  const currentStart = scanData.length - str.length;
  let active = Boolean(wasActive);
  let started = false;
  let ended = false;
  let startIndex = scanData.indexOf(SYNC_START_SEQ);
  let endIndex = scanData.indexOf(SYNC_END_SEQ);

  while (startIndex !== -1 || endIndex !== -1) {
    if (endIndex !== -1 && (startIndex === -1 || endIndex < startIndex)) {
      active = false;
      if (endIndex + SYNC_END_SEQ.length > currentStart) ended = true;
      endIndex = scanData.indexOf(SYNC_END_SEQ, endIndex + SYNC_END_SEQ.length);
      continue;
    }
    active = true;
    if (startIndex + SYNC_START_SEQ.length > currentStart) started = true;
    startIndex = scanData.indexOf(SYNC_START_SEQ, startIndex + SYNC_START_SEQ.length);
  }

  return {
    started,
    ended,
    active,
    markerTail: scanData.slice(-SYNC_MARKER_TAIL_BYTES),
  };
}

/**
 * Advance latch state across dropped/coalesced bytes. If the stream stays inside
 * an open DEC 2026 frame when output is discarded, return SYNC_END_BUFFER so the
 * client closes the latch instead of waiting up to 1s for xterm's safety timeout.
 */
export function advanceDroppedSynchronizedOutputLatch(data, previous = INITIAL_SYNC_LATCH) {
  const scan = scanSynchronizedOutput(data, previous.markerTail || '', Boolean(previous.active));
  return {
    closeSequence: scan.active ? SYNC_END_BUFFER : null,
    state: { markerTail: scan.markerTail, active: scan.active },
  };
}

/**
 * Given a Buffer exceeding `limit`, find a split offset <= `limit` that:
 * 1) Never splits a `\x1b[?2026h` or `\x1b[?2026l` marker across batches, and
 * 2) Prefers ending just after the last closed `\x1b[?2026l` if at least half of `limit` fits.
 */
export function resolveSynchronizedOutputSafeSplitBuffer(buffer, limit, markerTail = '', wasActive = false) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= limit || limit <= 0) {
    return Buffer.isBuffer(buffer) ? buffer.length : 0;
  }
  const str = buffer.subarray(0, limit).toString('latin1');
  let candidate = limit;
  const guardStart = Math.max(0, limit - SYNC_MARKER_TAIL_BYTES);
  const escIdx = str.lastIndexOf('\x1b', limit - 1);
  if (escIdx >= guardStart && limit - escIdx < SYNC_START_SEQ.length) {
    candidate = escIdx;
  }
  if (!scanSynchronizedOutput(str.slice(0, candidate), markerTail, wasActive).active) {
    return candidate > 0 ? candidate : limit;
  }
  const searchBefore = Math.max(0, candidate - SYNC_END_SEQ.length);
  const lastClose = str.lastIndexOf(SYNC_END_SEQ, searchBefore);
  if (lastClose === -1) {
    return candidate > 0 ? candidate : limit;
  }
  const aligned = lastClose + SYNC_END_SEQ.length;
  return aligned * 2 >= limit ? aligned : (candidate > 0 ? candidate : limit);
}
