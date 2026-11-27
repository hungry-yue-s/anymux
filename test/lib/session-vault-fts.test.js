import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSessionVaultDb } from '../../lib/session-vault/db.js';
import { indexSessionVault, normalizeSessionTitle, splitSearchIdentifiers } from '../../lib/session-vault/indexer.js';
import { searchSessionVault } from '../../lib/session-vault/search.js';
import { buildHandoffPrompt, extractCitedPaths } from '../../lib/session-vault/handoff.js';
import { scanSessions } from '../../lib/session-vault/scanner.js';

const tempDirs = [];
const dbs = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Session Vault SQLite + FTS5 indexer, search, and handoff (Orca MIT port)', () => {
  it('normalizes pasted/ANSI titles and splits identifier tokens cleanly', () => {
    expect(normalizeSessionTitle('\x1b[32m<system-reminder>x</system-reminder> [Pasted text #1]  authTokenRefreshHandler \x1b[0m')).toBe('x authTokenRefreshHandler');
    const split = splitSearchIdentifiers('lib/worktrees/cleanupEvaluator.ts');
    expect(split).toContain('cleanup');
    expect(split).toContain('Evaluator');
    expect(split).toContain('worktrees');
  });

  it('indexes transcripts read-only, appends incrementally, repairs typos via fts5vocab, collapses forks, and builds handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anymux-sv-fts-'));
    tempDirs.push(root);
    const claudeDir = join(root, 'claude', 'proj');
    const codexDir = join(root, 'codex');
    const geminiDir = join(root, 'gemini');
    const opencodeDir = join(root, 'opencode');
    await Promise.all([
      mkdir(claudeDir, { recursive: true }),
      mkdir(codexDir, { recursive: true }),
      mkdir(geminiDir, { recursive: true }),
      mkdir(opencodeDir, { recursive: true }),
    ]);

    const c1 = join(claudeDir, 'c-1.jsonl');
    const c1Fork = join(claudeDir, 'c-2.jsonl');
    await writeFile(c1, [
      JSON.stringify({ type: 'user', sessionId: 'c-1', cwd: '/srv/app', gitBranch: 'feat/vault', timestamp: '2026-11-24T10:00:00Z', message: { role: 'user', content: 'Refactor sessionVaultIndexer SQLite indexing in lib/session-vault/db.js' } }),
      JSON.stringify({ type: 'assistant', sessionId: 'c-1', timestamp: '2026-11-24T10:01:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', content: 'Updated fts5vocab ranking.' } }),
    ].join('\n') + '\n');

    // Fork with same provider, cwd, and title created later
    await writeFile(c1Fork, [
      JSON.stringify({ type: 'user', sessionId: 'c-2', cwd: '/srv/app', gitBranch: 'feat/vault', timestamp: '2026-11-24T10:05:00Z', message: { role: 'user', content: 'Refactor sessionVaultIndexer SQLite indexing in lib/session-vault/db.js' } }),
      JSON.stringify({ type: 'assistant', sessionId: 'c-2', timestamp: '2026-11-24T10:06:00Z', message: { role: 'assistant', content: 'Branched exploration.' } }),
    ].join('\n') + '\n');

    await writeFile(join(opencodeDir, 'oc-1.json'), JSON.stringify({
      id: 'oc-1',
      directory: '/srv/oc',
      title: 'Inspect opencode session schema',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Verify opencode scanner parity' }],
    }));

    const scanOpts = { claudeDir: join(root, 'claude'), codexDir, geminiDir, opencodeDir };
    const beforeStat = await stat(c1);

    const vaultDb = openSessionVaultDb(join(root, 'vault.sqlite'));
    dbs.push(vaultDb);

    const first = await indexSessionVault(vaultDb, scanOpts);
    expect(first.total).toBe(3);
    expect(first.indexed).toBe(3);
    expect((await stat(c1)).mtimeMs).toBe(beforeStat.mtimeMs);

    // Split camelCase / path query hits via unicode61 + identifier expansion
    const camelHit = searchSessionVault(vaultDb, { q: 'cleanup', includeForks: false });
    expect(camelHit.results).toHaveLength(0);
    const hit = searchSessionVault(vaultDb, { q: 'Indexer', includeForks: false });
    expect(hit.results).toHaveLength(1); // fork collapsed
    expect(hit.results[0].forkCount).toBe(1);
    expect(hit.results[0].snippet).toContain('<mark>');

    // Include forks returns both
    const withForks = searchSessionVault(vaultDb, { q: 'Indexer', includeForks: true });
    expect(withForks.results).toHaveLength(2);

    // Typo tolerance via fts5vocab edit-distance fallback
    const typo = searchSessionVault(vaultDb, { q: 'sessonVaultIndexer' });
    expect(typo.correctedQuery).toBeTruthy();
    expect(typo.results.length).toBeGreaterThanOrEqual(1);

    // Incremental byte-offset append on JSONL transcript
    await appendFile(c1, JSON.stringify({
      type: 'user',
      sessionId: 'c-1',
      timestamp: '2026-11-24T10:10:00Z',
      message: { role: 'user', content: 'Check incrementalAppendKeyword42 in plugins/session-vault/index.js' },
    }) + '\n');
    const bump = new Date(Date.now() + 2000);
    await utimes(c1, bump, bump);

    const second = await indexSessionVault(vaultDb, scanOpts);
    expect(second.incrementalAppends).toBe(1);
    const incHit = searchSessionVault(vaultDb, { q: 'incrementalAppendKeyword42' });
    expect(incHit.results).toHaveLength(1);
    expect(incHit.results[0].session_id).toBe('c-1');

    // OpenCode scanner integration + handoff synthesis
    const scanned = await scanSessions(scanOpts);
    expect(scanned.some((s) => s.provider === 'opencode' && s.id === 'oc-1')).toBe(true);

    const turns = [
      { role: 'user', text: 'Inspect lib/session-vault/db.js and lib/session-vault/search.js' },
      { role: 'assistant', text: 'Completed BM25 tuning.' },
    ];
    expect(extractCitedPaths(turns)).toEqual(['lib/session-vault/db.js', 'lib/session-vault/search.js']);
    const handoff = buildHandoffPrompt({ session: hit.results[0], turns, targetAgent: 'codex' });
    expect(handoff).toContain('Cross-Agent Handoff (claude -> codex)');
    expect(handoff).toContain('lib/session-vault/db.js');
    expect(handoff).toContain('Completed BM25 tuning.');
  });
});
