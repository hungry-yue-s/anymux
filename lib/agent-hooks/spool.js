// Durable bounded JSONL spool for failed agent hook deliveries and startup replay.
// Ported from stablyai/orca (MIT).

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const AGENT_HOOK_SPOOL_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_HOOK_SPOOL_MAX_RECORDS = 1000;
export const AGENT_HOOK_SPOOL_MAX_BYTES = 512 * 1024;

export function sanitizeSpoolRecord(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const receivedAt = typeof payload.receivedAt === 'number' && Number.isFinite(payload.receivedAt)
    ? payload.receivedAt
    : now;
  return { ...payload, receivedAt };
}

export function appendSpoolRecord(spoolPath, payload, {
  now = Date.now(),
  ttlMs = AGENT_HOOK_SPOOL_TTL_MS,
  maxRecords = AGENT_HOOK_SPOOL_MAX_RECORDS,
  maxBytes = AGENT_HOOK_SPOOL_MAX_BYTES,
} = {}) {
  const record = sanitizeSpoolRecord(payload, now);
  if (!record) return false;
  mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(record) + '\n';

  // Enforce bounded ring cap when existing file approaches limits.
  try {
    if (existsSync(spoolPath)) {
      const { records } = readSpoolRecords(spoolPath, { now, ttlMs });
      const totalBytes = Buffer.byteLength(line) + records.reduce((acc, r) => acc + Buffer.byteLength(JSON.stringify(r) + '\n'), 0);
      if (records.length >= maxRecords || totalBytes > maxBytes) {
        const trimmed = [...records, record];
        while (trimmed.length > maxRecords) trimmed.shift();
        let serialized = trimmed.map((r) => JSON.stringify(r) + '\n');
        while (serialized.length > 1 && Buffer.byteLength(serialized.join('')) > maxBytes) {
          serialized.shift();
        }
        writeFileSync(spoolPath, serialized.join(''), { mode: 0o600 });
        return true;
      }
    }
  } catch { /* fall through to direct append */ }

  appendFileSync(spoolPath, line, { mode: 0o600 });
  return true;
}

export function readSpoolRecords(spoolPath, {
  now = Date.now(),
  ttlMs = AGENT_HOOK_SPOOL_TTL_MS,
} = {}) {
  let raw;
  try {
    raw = readFileSync(spoolPath, 'utf8');
  } catch {
    return { records: [], expired: 0, torn: 0 };
  }
  const cutoff = now - ttlMs;
  const records = [];
  let expired = 0;
  let torn = 0;
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  const completeCount = endsWithNewline ? lines.length - 1 : Math.max(0, lines.length - 1);

  for (let i = 0; i < completeCount; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        torn += 1;
        continue;
      }
      if (typeof parsed.receivedAt === 'number' && parsed.receivedAt < cutoff) {
        expired += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      torn += 1;
    }
  }
  return { records, expired, torn };
}

/**
 * Drain valid JSONL spool records in FIFO order, tagging each with `isReplay: true`.
 * Preserves any concurrent incomplete/appended bytes after the consumed snapshot.
 */
export async function drainSpoolFile(spoolPath, onRecord, {
  now = Date.now(),
  ttlMs = AGENT_HOOK_SPOOL_TTL_MS,
} = {}) {
  if (!existsSync(spoolPath) || typeof onRecord !== 'function') return 0;
  let bytes;
  try {
    bytes = readFileSync(spoolPath);
  } catch {
    return 0;
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  const consumedBytes = lastNewline === -1 ? 0 : lastNewline + 1;
  if (consumedBytes === 0) return 0;

  const cutoff = now - ttlMs;
  const sliceText = bytes.subarray(0, consumedBytes).toString('utf8');
  let replayed = 0;
  for (const line of sliceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (typeof parsed.receivedAt === 'number' && parsed.receivedAt < cutoff) continue;
      await onRecord({ ...parsed, isReplay: true });
      replayed += 1;
    } catch { /* ignore malformed lines */ }
  }

  try {
    const fd = openSync(spoolPath, 'r+');
    try {
      const totalSize = fstatSync(fd).size;
      if (totalSize > consumedBytes) {
        const tail = readFileSync(spoolPath).subarray(consumedBytes);
        writeSync(fd, tail, 0, tail.length, 0);
        ftruncateSync(fd, tail.length);
      } else {
        ftruncateSync(fd, 0);
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore truncation race */ }

  return replayed;
}
