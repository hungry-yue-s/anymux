// SQLite + FTS5 persistent store for Session Vault (Node >=22 built-in node:sqlite).
// Ported from stablyai/orca (MIT).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openSessionVaultDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      raw_title TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      git_branch TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      resume_command TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      fork_parent TEXT NOT NULL DEFAULT '',
      byte_offset INTEGER NOT NULL DEFAULT 0,
      prefix_hash TEXT NOT NULL DEFAULT '',
      file_mtime_ms REAL NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, seq);

    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      session_key UNINDEXED,
      title,
      cwd,
      git_branch,
      body,
      tokenize="unicode61 tokenchars '_.-/+'"
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts_vocab USING fts5vocab(session_fts, row);
  `);

  return {
    db,
    close() {
      try {
        db.close();
      } catch { /* already closed */ }
    },
  };
}
