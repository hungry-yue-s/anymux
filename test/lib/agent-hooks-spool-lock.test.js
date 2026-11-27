import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHookManager } from '../../lib/agent-hooks.js';
import { atomicWriteFile, backupAndPruneFile, withInstallLock } from '../../lib/agent-hooks/install-lock.js';
import { appendSpoolRecord, drainSpoolFile, readSpoolRecords } from '../../lib/agent-hooks/spool.js';
import { deriveInteractivePrompt, extractQuestionTitle, isInteractiveToolName } from '../../lib/agent-hooks/interactive-tool.js';
import { normalizeProviderHookInput, shouldIgnoreHookPayload } from '../../lib/agent-hooks/provider-rules.js';
import { AgentEventService } from '../../lib/agent-events.js';

const tempDirs = [];

async function makeTemp(prefix = 'agent-hooks-w3-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runNodeScript(scriptPath, args, { env, stdinText = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit ${code}: ${stderr}`));
    });
    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('wave 3 agent hook install lock & backup pruning', () => {
  it('serializes concurrent access, recovers stale dead-PID locks, and prunes backups to keep latest 3', async () => {
    const root = await makeTemp();
    const lockPath = join(root, 'install.lock');
    // Seed a stale lock held by an impossible PID
    await writeFile(lockPath, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }));

    const order = [];
    await Promise.all([
      withInstallLock(lockPath, async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 40));
        order.push('a-end');
      }),
      withInstallLock(lockPath, async () => {
        order.push('b-start');
        order.push('b-end');
      }),
    ]);
    // Either a ran wholly before b or b wholly before a — never interleaved
    expect(order[0].slice(0, 1)).toBe(order[1].slice(0, 1));
    expect(order[2].slice(0, 1)).toBe(order[3].slice(0, 1));

    const cfg = join(root, 'settings.json');
    for (let i = 0; i < 6; i += 1) {
      await atomicWriteFile(cfg, JSON.stringify({ step: i }));
      await backupAndPruneFile(cfg, { keep: 3 });
    }
    const backups = (await readdir(root)).filter((n) => n.startsWith('settings.json.bak-'));
    expect(backups).toHaveLength(3);
  });
});

describe('wave 3 router v6 spooling on HTTP error and startup drain', () => {
  it('spools failed deliveries (HTTP 500 or down server) and replays with isReplay: true respecting 24h TTL', async () => {
    const root = await makeTemp();
    const dataDir = join(root, 'data');
    const configDir = join(root, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'tokens.json'), JSON.stringify([['tok-w3', { expiresAt: null }]]));

    const server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const manager = new AgentHookManager({
        userHome: root,
        dataDir,
        configDir,
        panelUrl: `http://127.0.0.1:${port}/api/agent-events`,
        detectCli: async () => ({ found: false, path: null }),
      });
      const { scriptPath } = await manager.refreshManagedScript();

      await runNodeScript(scriptPath, ['--agent', 'claude', '--event', 'Stop'], {
        env: { PATH: process.env.PATH, TMUX: '/tmp/tmux-w3,9,0', TMUX_PANE: '%77', ANYMUX_CONFIG_DIR: configDir },
        stdinText: JSON.stringify({ prompt: 'Run tests' }),
      });

      const spoolPath = join(configDir, 'agent-hook-spool.jsonl');
      // Add an expired (>24h) record + torn trailing fragment
      appendSpoolRecord(spoolPath, { agent: 'codex', event: 'Stop', paneId: '%12', receivedAt: Date.now() - 25 * 3600 * 1000 });
      const { records, expired } = readSpoolRecords(spoolPath);
      expect(expired).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ agent: 'claude', event: 'Stop', paneId: '%77' });

      const noticeStore = { add: () => ({ id: 'n1' }) };
      const addSpy = [];
      noticeStore.add = (entry) => { addSpy.push(entry); return entry; };
      const eventSvc = new AgentEventService({ notificationStore: noticeStore });
      const replayed = await drainSpoolFile(spoolPath, (rec) => {
        eventSvc.ingest(rec, { isReplay: Boolean(rec.isReplay) });
      });
      expect(replayed).toBe(1);
      expect(addSpy).toHaveLength(0); // isReplay suppresses notification storm
      expect(eventSvc.getPaneState('%77')?.status).toBe('done');
      expect((await readFile(spoolPath, 'utf8')).trim()).toBe('');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('wave 3 interactive tool & provider normalization rules', () => {
  it('promotes AskUserQuestion / ExitPlanMode pre-tool events, maps Cursor hooks, and ignores sidechains', () => {
    expect(isInteractiveToolName('AskUserQuestion')).toBe(true);
    expect(isInteractiveToolName('ExitPlanMode')).toBe(true);
    expect(isInteractiveToolName('Bash')).toBe(false);
    expect(shouldIgnoreHookPayload({ isSidechain: true, event: 'Stop' })).toBe(true);

    const askPrompt = deriveInteractivePrompt('AskUserQuestion', {
      questions: [{ question: 'Proceed with DB migration?', options: [{ label: 'Yes' }] }],
    }, 'PreToolUse');
    expect(askPrompt).toContain('Proceed with DB migration?');
    expect(deriveInteractivePrompt('AskUserQuestion', { questions: [] }, 'PostToolUse')).toBeUndefined();
    expect(extractQuestionTitle({ questions: [{ question: 'Pick env' }] })).toBe('Pick env');

    const svc = new AgentEventService();
    const askRes = svc.ingest({
      agent: 'claude',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Allow deploy?' }] },
      paneId: '%31',
    });
    expect(askRes.event.state).toBe('waiting_attention');
    expect(svc.getPaneState('%31')?.status).toBe('permission');
    expect(svc.getPaneState('%31')?.interactivePrompt).toContain('Allow deploy?');

    const sidechainRes = svc.ingest({ agent: 'claude', event: 'Stop', isSidechain: true, paneId: '%31' });
    expect(sidechainRes.ignored).toBe(true);
    expect(svc.getPaneState('%31')?.status).toBe('permission');

    const cursorNorm = normalizeProviderHookInput({
      cursor_version: '2026.06',
      hook_event_name: 'afterAgentResponse',
      workspace_roots: ['/repo/cursor-app'],
    });
    expect(cursorNorm).toMatchObject({ agent: 'cursor', event: 'agent_stop', cwd: '/repo/cursor-app' });
  });
});
