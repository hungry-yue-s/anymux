// Incremental byte-offset reader, title normalizer, fork detector, and FTS5 indexer
// for Session Vault. Strictly read-only on source transcripts (never mutates mtimes).
// Ported from stablyai/orca (MIT).

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { scanSessions, readSessionTranscript } from './scanner.js';

const PREFIX_SAMPLE_BYTES = 4096;

export function normalizeSessionTitle(raw, fallback = '未命名会话') {
  const cleaned = String(raw || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\[Pasted[^\]]*\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 96 ? `${cleaned.slice(0, 96)}…` : cleaned;
}

/**
 * Expand camelCase, snake_case, kebab-case, and file paths into searchable tokens
 * alongside the untouched original text so exact and split matches both rank cleanly.
 */
export function splitSearchIdentifiers(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const extra = new Set();
  for (const token of raw.split(/\s+/)) {
    if (!token || token.length < 3) continue;
    const expanded = token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-./\\:+]+/g, ' ')
      .trim();
    if (expanded && expanded !== token) {
      for (const part of expanded.split(/\s+/)) {
        if (part.length >= 2) extra.add(part);
      }
    }
  }
  return extra.size ? `${raw}\n${[...extra].join(' ')}` : raw;
}

export async function readFilePrefixSignature(filePath, maxBytes = PREFIX_SAMPLE_BYTES) {
  const info = await stat(filePath);
  const fh = await open(filePath, 'r');
  try {
    const sampleLen = Math.min(maxBytes, info.size);
    const buf = Buffer.allocUnsafe(sampleLen);
    if (sampleLen > 0) {
      await fh.read(buf, 0, sampleLen, 0);
    }
    const prefixHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    return { size: info.size, mtimeMs: info.mtimeMs, prefixHash };
  } finally {
    await fh.close();
  }
}

async function readAppendedJsonlTurns(filePath, fromOffset, totalSize) {
  if (!(totalSize > fromOffset)) return [];
  const fh = await open(filePath, 'r');
  try {
    const len = totalSize - fromOffset;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, fromOffset);
    const text = buf.toString('utf8');
    const turns = [];
    for (const rawLine of text.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        const msg = row.message || row.payload || row;
        const role = row.type === 'user' || msg?.role === 'user' ? 'user'
          : (row.type === 'assistant' || msg?.role === 'assistant' ? 'assistant' : null);
        if (!role) continue;
        const content = msg?.content ?? row.content;
        let extracted = '';
        if (typeof content === 'string') extracted = content.trim();
        else if (Array.isArray(content)) {
          extracted = content
            .map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : '')))
            .filter(Boolean)
            .join('\n')
            .trim();
        }
        if (extracted) {
          const ts = row.timestamp ? Date.parse(row.timestamp) : Date.now();
          turns.push({ role, text: extracted, timestamp: Number.isFinite(ts) ? ts : Date.now() });
        }
      } catch { /* skip partial or malformed line */ }
    }
    return turns;
  } finally {
    await fh.close();
  }
}

export async function indexSessionVault(vaultDb, scanOptions = {}) {
  const { db } = vaultDb;
  const sessions = await scanSessions({ limit: 200, ...scanOptions });

  const selectMeta = db.prepare('SELECT key, byte_offset, prefix_hash, file_size, file_mtime_ms, turn_count FROM sessions WHERE key = ?');
  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      key, provider, session_id, title, raw_title, cwd, git_branch, model,
      input_tokens, output_tokens, turn_count, created_at, updated_at,
      resume_command, source_path, fork_parent, byte_offset, prefix_hash, file_mtime_ms, file_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      title=excluded.title, raw_title=excluded.raw_title, cwd=excluded.cwd,
      git_branch=excluded.git_branch, model=excluded.model,
      input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      turn_count=excluded.turn_count, updated_at=excluded.updated_at,
      resume_command=excluded.resume_command, fork_parent=excluded.fork_parent,
      byte_offset=excluded.byte_offset, prefix_hash=excluded.prefix_hash,
      file_mtime_ms=excluded.file_mtime_ms, file_size=excluded.file_size
  `);
  const deleteMsgs = db.prepare('DELETE FROM messages WHERE session_key = ?');
  const insertMsg = db.prepare('INSERT INTO messages (session_key, seq, role, text, search_text, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  const deleteFts = db.prepare('DELETE FROM session_fts WHERE session_key = ?');
  const insertFts = db.prepare('INSERT INTO session_fts (session_key, title, cwd, git_branch, body) VALUES (?, ?, ?, ?, ?)');
  const getMsgs = db.prepare('SELECT search_text FROM messages WHERE session_key = ? ORDER BY seq ASC');

  // Identify fork relationships: same cwd + normalized title (keep earliest as root parent)
  const forkRoots = new Map();
  const orderedByCreated = [...sessions].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const s of orderedByCreated) {
    const normTitle = normalizeSessionTitle(s.title);
    const sig = `${s.provider}\0${s.cwd}\0${normTitle}`;
    if (normTitle !== '未命名会话' && !forkRoots.has(sig)) {
      forkRoots.set(sig, `${s.provider}:${s.id}`);
    }
  }

  let indexed = 0;
  let incrementalAppends = 0;

  for (const s of sessions) {
    const key = `${s.provider}:${s.id}`;
    const normTitle = normalizeSessionTitle(s.title, s.id);
    const forkSig = `${s.provider}\0${s.cwd}\0${normTitle}`;
    const rootKey = forkRoots.get(forkSig);
    const forkParent = rootKey && rootKey !== key ? rootKey : '';

    let sig = { size: 0, mtimeMs: s.updatedAt || 0, prefixHash: '' };
    if (s.filePath) {
      sig = await readFilePrefixSignature(s.filePath).catch(() => sig);
    }

    const prev = selectMeta.get(key);
    if (prev && prev.prefix_hash === sig.prefixHash && prev.file_size === sig.size && prev.file_mtime_ms === sig.mtimeMs) {
      continue;
    }

    let canAppend = false;
    if (prev && s.filePath?.endsWith('.jsonl') && prev.byte_offset > 0 && sig.size > prev.byte_offset) {
      if (prev.byte_offset >= PREFIX_SAMPLE_BYTES) {
        canAppend = prev.prefix_hash === sig.prefixHash;
      } else {
        const prefixSig = await readFilePrefixSignature(s.filePath, prev.byte_offset).catch(() => null);
        canAppend = Boolean(prefixSig && prefixSig.prefixHash === prev.prefix_hash);
      }
    }

    if (canAppend) {
      const appendedTurns = await readAppendedJsonlTurns(s.filePath, prev.byte_offset, sig.size);
      db.exec('BEGIN');
      try {
        upsertSession.run(
          key, s.provider, s.id, normTitle, s.title || '', s.cwd || '', s.gitBranch || '', s.model || '',
          s.inputTokens || 0, s.outputTokens || 0, s.turnCount || 0, s.createdAt || 0, s.updatedAt || 0,
          s.resumeCommand || '', s.filePath || '', forkParent, sig.size, sig.prefixHash, sig.mtimeMs, sig.size,
        );
        let seq = Number(prev.turn_count || 0);
        for (const t of appendedTurns) {
          insertMsg.run(key, seq++, t.role, t.text, splitSearchIdentifiers(t.text), t.timestamp || 0);
        }
        const allBody = getMsgs.all(key).map((r) => r.search_text).join('\n');
        deleteFts.run(key);
        insertFts.run(key, splitSearchIdentifiers(normTitle), splitSearchIdentifiers(s.cwd || ''), s.gitBranch || '', allBody);
        db.exec('COMMIT');
        incrementalAppends += 1;
        indexed += 1;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      continue;
    }

    const detail = await readSessionTranscript(s.provider, s.id, { maxTurns: 500, ...scanOptions }).catch(() => null);
    const turns = detail?.turns || [];
    db.exec('BEGIN');
    try {
      upsertSession.run(
        key, s.provider, s.id, normTitle, s.title || '', s.cwd || '', s.gitBranch || '', s.model || '',
        s.inputTokens || 0, s.outputTokens || 0, s.turnCount || turns.length, s.createdAt || 0, s.updatedAt || 0,
        s.resumeCommand || '', s.filePath || '', forkParent, sig.size, sig.prefixHash, sig.mtimeMs, sig.size,
      );
      deleteMsgs.run(key);
      const bodies = [];
      turns.forEach((t, idx) => {
        const searchable = splitSearchIdentifiers(t.text);
        bodies.push(searchable);
        insertMsg.run(key, idx, t.role, t.text, searchable, t.timestamp || 0);
      });
      deleteFts.run(key);
      insertFts.run(key, splitSearchIdentifiers(normTitle), splitSearchIdentifiers(s.cwd || ''), s.gitBranch || '', bodies.join('\n'));
      db.exec('COMMIT');
      indexed += 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { total: sessions.length, indexed, incrementalAppends };
}
