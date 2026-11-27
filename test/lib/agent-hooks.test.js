import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHookManager, detectAgentCli, EVENT_SPECS } from '../../lib/agent-hooks.js';

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
const tempDirs = [];

async function makeTemp(prefix = 'agent-hooks-unit-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('AgentHookManager', () => {
  it('writes self-contained router script to stable dataDir and hook-endpoint.json to configDir', async () => {
    const root = await makeTemp();
    const dataDir = join(root, 'data');
    const configDir = join(root, 'config');
    const manager = new AgentHookManager({
      userHome: root,
      dataDir,
      configDir,
      panelUrl: 'http://127.0.0.1:7699/api/agent-events',
      tokenFileName: 'tokens.custom.json',
      detectCli: async () => ({ found: false, path: null }),
    });

    const paths = await manager.refreshManagedScript();
    expect(paths.scriptPath).toBe(join(dataDir, 'agent-hooks', 'agent-event-router.mjs'));
    const script = await readFile(paths.scriptPath, 'utf8');
    expect(script).toContain('anymux-managed-hook-router v6');
    if (process.platform !== 'win32') {
      const mode = (await stat(paths.scriptPath)).mode & 0o777;
      expect(mode & 0o100).toBe(0o100);
    }

    const endpoint = JSON.parse(await readFile(paths.endpointPath, 'utf8'));
    expect(endpoint).toMatchObject({
      url: 'http://127.0.0.1:7699/api/agent-events',
      configDir,
      tokenFileName: 'tokens.custom.json',
    });
  });

  it('detects installed agent CLIs across PATH and extra user directories', async () => {
    const root = await makeTemp();
    const localBin = join(root, '.local', 'bin');
    await mkdir(localBin, { recursive: true });
    const fakeClaude = join(localBin, 'claude');
    await writeFile(fakeClaude, '#!/bin/sh\nexit 0\n');
    await chmod(fakeClaude, 0o755);

    const claude = await detectAgentCli('claude', { home: root, env: { PATH: '/nonexistent' }, platform: 'linux' });
    const gemini = await detectAgentCli('gemini', { home: root, env: { PATH: '/nonexistent' }, platform: 'linux' });
    expect(claude).toEqual({ found: true, path: fakeClaude });
    expect(gemini).toEqual({ found: false, path: null });
  });

  it('reconciles only detected CLIs on startup, preserves third-party hooks, migrates legacy entries, and is idempotent', async () => {
    const root = await makeTemp();
    const dataDir = join(root, 'data');
    const configDir = join(root, 'config');
    await mkdir(join(root, '.claude'), { recursive: true });
    await mkdir(join(root, '.codex'), { recursive: true });
    await mkdir(join(root, '.gemini'), { recursive: true });

    // Seed third-party hooks (Orca + loongsuite) + legacy Anymux bell & tmux-web-panel entries
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/opt/orca/claude-hook.sh', timeout: 10 }] },
          { hooks: [{ type: 'command', command: "printf '\\a' > /dev/ttys001", timeout: 5 }] },
        ],
      },
    }));
    await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/opt/loongsuite.sh' }] },
          { matcher: '*', hooks: [{ type: 'command', command: '/old/scripts/agent-event-router.js', name: 'tmux-web-panel-codex-Stop' }] },
        ],
      },
    }));
    await writeFile(join(root, '.gemini', 'settings.json'), JSON.stringify({
      hooks: { BeforeTool: [{ matcher: '*', hooks: [{ type: 'command', command: '/keep/gemini.sh' }] }] },
    }));

    const manager = new AgentHookManager({
      userHome: root,
      dataDir,
      configDir,
      detectCli: async (agent) => (agent === 'claude' || agent === 'codex' ? { found: true, path: `/usr/bin/${agent}` } : { found: false, path: null }),
    });

    const first = await manager.reconcileOnStartup();
    expect(first.autoInstall).toBe(true);
    expect(first.results.map((r) => r.agent)).toEqual(['claude', 'codex']);

    const claudeCfg = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
    const codexCfg = JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'));
    const geminiCfg = JSON.parse(await readFile(join(root, '.gemini', 'settings.json'), 'utf8'));

    // Third-party hooks preserved; legacy bell & tmux-web-panel removed; all 11 lifecycle events installed
    expect(JSON.stringify(claudeCfg)).toContain('/opt/orca/claude-hook.sh');
    expect(JSON.stringify(claudeCfg)).not.toContain("printf '\\a'");
    expect(claudeCfg.hooks.Stop.flatMap((e) => e.hooks).some((h) => h.command.includes('agent-event-router.mjs') && !h.name)).toBe(true);
    expect(Object.keys(claudeCfg.hooks)).toEqual(expect.arrayContaining(EVENT_SPECS.map(([k]) => k)));

    expect(JSON.stringify(codexCfg)).toContain('/opt/loongsuite.sh');
    expect(JSON.stringify(codexCfg)).not.toContain('tmux-web-panel-codex-Stop');
    expect(codexCfg.hooks.Stop.flatMap((e) => e.hooks).some((h) => h.name === 'anymux-codex-Stop' && h.command.includes('agent-event-router.mjs'))).toBe(true);

    // Uninstalled CLI (.gemini) untouched
    expect(geminiCfg).toEqual({
      hooks: { BeforeTool: [{ matcher: '*', hooks: [{ type: 'command', command: '/keep/gemini.sh' }] }] },
    });

    // Status reflects exact state
    const st = await manager.status();
    expect(st.agents.find((a) => a.agent === 'claude').state).toBe('installed');
    expect(st.agents.find((a) => a.agent === 'codex').state).toBe('installed');
    expect(st.agents.find((a) => a.agent === 'gemini').state).toBe('not_installed');

    // Second reconcile creates ZERO backups and makes ZERO changes
    const claudeBefore = await readFile(join(root, '.claude', 'settings.json'), 'utf8');
    const second = await manager.reconcileOnStartup();
    expect(second.results.every((r) => r.added === 0 && r.backup === null)).toBe(true);
    expect(await readFile(join(root, '.claude', 'settings.json'), 'utf8')).toBe(claudeBefore);
    expect((await readdir(join(root, '.claude'))).filter((n) => n.includes('.bak-'))).toHaveLength(1);

    // Turning autoInstall off removes Anymux hooks while keeping Orca/loongsuite hooks
    const afterDisable = await manager.updateSettings({ autoInstall: false });
    expect(afterDisable.autoInstall).toBe(false);
    expect(afterDisable.agents.find((a) => a.agent === 'claude').state).toBe('not_installed');
    const claudeAfterDisable = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(claudeAfterDisable)).toContain('/opt/orca/claude-hook.sh');
    expect(JSON.stringify(claudeAfterDisable)).not.toContain('agent-event-router');
  });

  it('generated router script exits silently outside tmux and posts authenticated events inside tmux', async () => {
    const root = await makeTemp();
    const dataDir = join(root, 'data');
    const configDir = join(root, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'tokens.json'), JSON.stringify([['secret-test-token', { expiresAt: null }]]));

    const received = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
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

      // Outside tmux -> exits 0 cleanly with 0 HTTP calls, but honors --stdout-json for synchronous CLIs like agy
      const outRes = await runNodeScript(scriptPath, ['--agent', 'antigravity', '--event', 'agent_stop', '--stdout-json', '{"decision":""}'], {
        env: { PATH: process.env },
      });
      expect(outRes.stdout.trim()).toBe('{"decision":""}');
      expect(received).toHaveLength(0);

      // Inside tmux -> reads hook-endpoint.json + tokens.json + stdin JSON and posts payload
      const inRes = await runNodeScript(scriptPath, ['--agent', 'claude', '--event', 'user_prompt_submit', '--stdout-json', '{}'], {
        env: { PATH: process.env.PATH, TMUX: '/tmp/tmux-test,1,0', TMUX_PANE: '%42' },
        stdinText: JSON.stringify({ model: 'claude-opus-4-5', prompt: 'Hello router' }),
      });
      expect(inRes.stdout.trim()).toBe('{}');
      expect(received).toHaveLength(1);
      expect(received[0].auth).toBe('Bearer secret-test-token');
      expect(received[0].body).toMatchObject({
        agent: 'claude',
        event: 'user_prompt_submit',
        paneId: '%42',
        tmuxServerPid: '1',
        model: 'claude-opus-4-5',
        prompt: 'Hello router',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('installs, reconciles idempotently, and uninstalls Antigravity and DSH hooks while preserving third-party entries', async () => {
    const root = await makeTemp();
    const dataDir = join(root, 'data');
    const configDir = join(root, 'config');
    await mkdir(join(root, '.gemini', 'config'), { recursive: true });
    await mkdir(join(root, '.dsh'), { recursive: true });

    await writeFile(join(root, '.gemini', 'config', 'hooks.json'), JSON.stringify({
      'claude-mem': { SessionStart: [{ type: 'command', command: '/opt/claude-mem' }] },
      'orca-status': { Stop: [{ type: 'command', command: '/opt/orca/antigravity-hook.sh' }] },
    }, null, 2));

    await writeFile(join(root, '.dsh', 'cordis.patch.yml'), [
      '# >>> orca-managed-dsh-hooks (managed by Orca; do not edit) >>>',
      '- insert:',
      '    - id: orca-agent-hooks',
      "      name: '@deepseek-ai/dsh-hooks-claude-code'",
      '# <<< orca-managed-dsh-hooks <<<',
      '# >>> superpowers >>>',
      '- insert:',
      '    - id: superpowers-bootstrap',
      '# <<< superpowers <<<',
      '',
    ].join('\n'));

    const manager = new AgentHookManager({
      userHome: root,
      dataDir,
      configDir,
      detectCli: async (agent) => (agent === 'antigravity' || agent === 'dsh'
        ? { found: true, path: `/usr/bin/${agent}` }
        : { found: false, path: null }),
    });

    const first = await manager.reconcileOnStartup();
    expect(first.results.map((r) => r.agent)).toEqual(['antigravity', 'dsh']);

    const agyCfg = JSON.parse(await readFile(join(root, '.gemini', 'config', 'hooks.json'), 'utf8'));
    expect(agyCfg['claude-mem']).toBeTruthy();
    expect(agyCfg['orca-status']).toBeTruthy();
    expect(agyCfg['anymux-status']).toBeTruthy();
    expect(agyCfg['anymux-status'].SessionStart[0].command).toContain('--event session_start');
    expect(agyCfg['anymux-status'].SessionStart[0].command).toContain("--stdout-json '{}'");
    expect(agyCfg['anymux-status'].PreInvocation[0].command).toContain("--stdout-json '{}'");
    expect(agyCfg['anymux-status'].Stop[0].command).toContain('{"decision":""}');
    expect(agyCfg['anymux-status'].PreToolUse[0].matcher).toBe('*');
    expect(agyCfg['anymux-status'].PreToolUse[0].hooks[0].command).not.toContain('--stdout-json');

    const routerScript = await readFile(manager.scriptPath, 'utf8');
    expect(routerScript).toContain('ANTIGRAVITY_CONVERSATION_ID');

    const dshYml = await readFile(join(root, '.dsh', 'cordis.patch.yml'), 'utf8');
    expect(dshYml).toContain('orca-agent-hooks');
    expect(dshYml).toContain('superpowers-bootstrap');
    expect(dshYml).toContain('anymux-agent-hooks');
    expect(dshYml).toContain(manager.dshHooksPath);

    const dshJson = JSON.parse(await readFile(manager.dshHooksPath, 'utf8'));
    expect(dshJson.hooks.SessionStart[0].hooks[0].command).toContain('--agent dsh --event session_start');
    expect(dshJson.hooks.Stop[0].hooks[0].command).toContain('--agent dsh --event agent_stop');

    const st = await manager.status();
    expect(st.agents.find((a) => a.agent === 'antigravity')).toMatchObject({ state: 'installed', installedEvents: 6, totalEvents: 6 });
    expect(st.agents.find((a) => a.agent === 'dsh')).toMatchObject({ state: 'installed', installedEvents: 7, totalEvents: 7 });

    // Second reconcile makes zero changes and creates zero backups
    const second = await manager.reconcileOnStartup();
    expect(second.results.every((r) => r.added === 0 && r.backup === null)).toBe(true);
    expect((await readdir(join(root, '.gemini', 'config'))).filter((n) => n.includes('.bak-'))).toHaveLength(1);
    expect((await readdir(join(root, '.dsh'))).filter((n) => n.includes('.bak-'))).toHaveLength(1);

    // Uninstall removes only Anymux entries and cleans dsh-hooks.json
    await manager.uninstall('antigravity');
    await manager.uninstall('dsh');
    const agyAfter = JSON.parse(await readFile(join(root, '.gemini', 'config', 'hooks.json'), 'utf8'));
    expect(agyAfter['anymux-status']).toBeUndefined();
    expect(agyAfter['claude-mem']).toBeTruthy();
    expect(agyAfter['orca-status']).toBeTruthy();

    const dshAfter = await readFile(join(root, '.dsh', 'cordis.patch.yml'), 'utf8');
    expect(dshAfter).not.toContain('anymux-agent-hooks');
    expect(dshAfter).toContain('orca-agent-hooks');
    expect(dshAfter).toContain('superpowers-bootstrap');
    expect(await readdir(join(dataDir, 'agent-hooks'))).not.toContain('dsh-hooks.json');
  });
});
