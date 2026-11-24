import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSessionTranscript, scanSessions, summarizeVault } from '../../lib/session-vault/scanner.js';

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setupVault() {
  const root = await mkdtemp(join(tmpdir(), 'anymux-vault-test-'));
  dirs.push(root);
  const claudeDir = join(root, 'claude');
  const codexDir = join(root, 'codex');
  const geminiDir = join(root, 'gemini');
  await mkdir(join(claudeDir, 'proj-a'), { recursive: true });
  await mkdir(join(codexDir, '2026', '11'), { recursive: true });
  await mkdir(join(geminiDir, 'hash1', 'chats'), { recursive: true });

  await writeFile(join(claudeDir, 'proj-a', 'c-1.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 'c-1', cwd: '/srv/repo-a', gitBranch: 'main', timestamp: '2026-11-24T10:00:00Z', message: { role: 'user', content: 'Fix auth token refresh bug' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'c-1', timestamp: '2026-11-24T10:01:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30 }, content: [{ type: 'text', text: 'Patched token refresh.' }] } }),
  ].join('\n'));

  await writeFile(join(codexDir, '2026', '11', 'rollout-1.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-11-24T11:00:00Z', payload: { id: 'x-1', cwd: '/srv/repo-b', model: 'gpt-5-codex' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-11-24T11:00:05Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add Seam divider resize' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-11-24T11:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 80 } } } }),
  ].join('\n'));

  await writeFile(join(geminiDir, 'hash1', 'chats', 'session-g1.json'), JSON.stringify({
    sessionId: 'g-1',
    cwd: '/srv/repo-c',
    startTime: '2026-11-24T12:00:00Z',
    lastUpdated: '2026-11-24T12:02:00Z',
    messages: [
      { type: 'user', content: 'Audit CSS themes', timestamp: '2026-11-24T12:00:00Z' },
      { type: 'gemini', model: 'gemini-2.5-pro', content: 'All 4 themes validated.', tokens: { input: 90, output: 25 }, timestamp: '2026-11-24T12:02:00Z' },
    ],
  }));

  return { claudeDir, codexDir, geminiDir };
}

describe('Session Vault read-only scanner', () => {
  it('scans Claude, Codex, and Gemini transcripts, filters cleanly, and aggregates token summary without modifying source files', async () => {
    const dirs = await setupVault();
    const claudeFile = join(dirs.claudeDir, 'proj-a', 'c-1.jsonl');
    const beforeMtime = (await stat(claudeFile)).mtimeMs;

    const all = await scanSessions(dirs);
    expect(all.map((s) => `${s.provider}:${s.id}`)).toEqual(['gemini:g-1', 'codex:x-1', 'claude:c-1']);

    const filtered = await scanSessions({ ...dirs, q: 'auth token' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: 'c-1', gitBranch: 'main', resumeCommand: 'claude --resume c-1' });

    const detail = await readSessionTranscript('gemini', 'g-1', dirs);
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0].text).toBe('Audit CSS themes');

    const summary = await summarizeVault(dirs);
    expect(summary.totalSessions).toBe(3);
    expect(summary.totalInputTokens).toBe(150 + 250 + 90);
    expect(summary.totalOutputTokens).toBe(45 + 80 + 25);
    expect((await stat(claudeFile)).mtimeMs).toBe(beforeMtime);
  });
});
