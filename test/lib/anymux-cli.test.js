import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  collectSourceContext,
  formatRetryCommand,
  parsePaneArgs,
  parseSessionsArgs,
  parseTmuxServerPid,
  parseWorkspaceArgs,
  parseWorktreeArgs,
  runCli,
} from '../../bin/anymux.mjs';
import { buildRequestPlan, resolveServerId } from '../../lib/cli/client.js';
import {
  buildAgentContext,
  CLI_VERSION,
  formatCommandHelp,
  formatRootHelp,
  suggestCommands,
} from '../../lib/cli/specs.js';
import { createBrowserRouter } from '../../plugins/browser/index.js';

function createRunner(overrides = {}) {
  let out = '';
  let err = '';
  const calls = [];
  const pairing = overrides.pairing || {
    host: '127.0.0.1',
    port: 7681,
    tls: false,
    token: 'node-secret-token',
  };
  const transport = overrides.transport || (async (req) => {
    calls.push(req);
    return { status: 200, data: { success: true, data: { ok: true }, error: null } };
  });

  return {
    calls,
    get stdout() { return out; },
    get stderr() { return err; },
    async run(argv, extra = {}) {
      out = '';
      err = '';
      const code = await runCli(argv, {
        env: overrides.env || {},
        cwd: overrides.cwd || '/repo',
        pid: 4567,
        platform: 'darwin',
        scriptPath: '/opt/anymux/bin/anymux.mjs',
        readPairingFn: () => pairing,
        transport,
        writeOut: (chunk) => { out += chunk; },
        writeErr: (chunk) => { err += chunk; },
        ...extra,
      });
      return { code, stdout: out, stderr: err };
    },
  };
}

describe('anymux orchestration CLI & agent-browser bridge', () => {
  it('collects tmux server pid, pane provenance, codex thread id, and retry commands', () => {
    expect(parseTmuxServerPid('/private/tmp/tmux-501/default,18130,3')).toBe('18130');
    expect(parseTmuxServerPid('/tmp/sock,0,1')).toBeNull();
    expect(parseTmuxServerPid('')).toBeNull();

    expect(collectSourceContext({
      explicitPane: '%33',
      env: { TMUX: '/tmp/sock,1873,0', TMUX_PANE: '%0', CODEX_THREAD_ID: 'thread-123' },
      pid: 4567,
    })).toEqual({
      paneId: '%33',
      paneSource: 'arg',
      tmuxServerPid: '1873',
      callerPid: 4567,
      codexThreadId: 'thread-123',
    });

    expect(collectSourceContext({
      explicitPane: null,
      env: { TMUX: '/tmp/sock,1873,0', TMUX_PANE: '%0', CODEX_SESSION_ID: 'sess_abc' },
      pid: 4567,
    })).toEqual({
      paneId: '%0',
      paneSource: 'env',
      tmuxServerPid: '1873',
      callerPid: 4567,
      codexThreadId: 'sess_abc',
    });

    expect(collectSourceContext({ explicitPane: null, env: {}, pid: 4567 })).toEqual({
      paneSource: 'none',
      callerPid: 4567,
    });

    expect(formatRetryCommand(['open', '--dock', '--pane', '<PANE_ID>', '/tmp/my doc.md'], { scriptPath: '/opt/anymux/bin/anymux.mjs' }))
      .toBe("node /opt/anymux/bin/anymux.mjs open --dock --pane '<PANE_ID>' '/tmp/my doc.md'");
  });

  it('parses workspace, worktree, sessions, and pane CLI options accurately', () => {
    expect(parseWorkspaceArgs(['new', '--name', 'dev', '--cwd', '/repo', '--session', '$2'])).toEqual({
      sub: 'new', name: 'dev', cwd: '/repo', session: '$2',
    });
    expect(parseWorktreeArgs(['new', 'feat/abc', '--repo', '/repo', '--base', 'main', '--open'])).toEqual({
      sub: 'new', repo: '/repo', baseRef: 'main', openWindow: true, force: false, target: 'feat/abc',
    });
    expect(parseWorktreeArgs(['remove', '/tmp/wt', '--force'], '/fallback')).toEqual({
      sub: 'remove', repo: '/fallback', baseRef: null, openWindow: false, force: true, target: '/tmp/wt',
    });
    expect(parseSessionsArgs(['--provider', 'codex', '--q', 'seam', '--limit', '20'])).toEqual({
      provider: 'codex', q: 'seam', limit: 20,
    });
    expect(parsePaneArgs(['rename', 'Worker', '1', '--pane', '%5'], '%1')).toEqual({
      sub: 'rename', pane: '%5', windowId: null, dir: 'horizontal', label: 'Worker 1',
    });
    expect(parsePaneArgs(['open', 'browser', '--url', 'https://example.com', '--dir', 'v', '--window', '@2'], '%1')).toEqual({
      sub: 'open', pane: '%1', windowId: '@2', dir: 'v', label: '', kind: 'browser', payload: '{"url":"https://example.com"}',
    });
    expect(parsePaneArgs(['set-kind', 'terminal', '--pane', '%9'], '%1')).toEqual({
      sub: 'set-kind', pane: '%9', windowId: null, dir: 'horizontal', label: '', kind: 'terminal', payload: '',
    });
  });

  it('probes agent-browser availability gracefully and rejects unwhitelisted commands', async () => {
    const app = express();
    app.use('/api/browser', express.json(), createBrowserRouter({
      exec: async (_bin, args) => {
        if (args[0] === '--version') {
          const err = new Error('not found');
          err.code = 'ENOENT';
          throw err;
        }
        return { stdout: '', stderr: '' };
      },
    }));

    const probe = await request(app).get('/api/browser/agent-browser').expect(200);
    expect(probe.body.data).toMatchObject({ available: false, installHint: 'npm install -g agent-browser' });

    const invalid = await request(app).post('/api/browser/agent-browser').send({ command: 'eval' }).expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('declarative specs, multi-server auth isolation, and CLI execution', () => {
  it('builds machine-readable agent-context, help text, and command suggestions', () => {
    const schema = buildAgentContext();
    expect(schema.schemaVersion).toBe(1);
    expect(schema.cliVersion).toBe(CLI_VERSION);
    expect(schema.commandCount).toBe(schema.commands.length);
    expect(schema.commands.some((c) => c.command === 'status')).toBe(true);
    expect(schema.commands.some((c) => c.command === 'skills get')).toBe(true);
    expect(formatRootHelp()).toContain('Global Options:');
    expect(formatCommandHelp(['skills'])).toContain('skills get');
    expect(formatCommandHelp(['workspace', 'list'])).toContain('Usage:');
    expect(suggestCommands('worktre')).toContain('worktree');
  });

  it('isolates pairing.token from Hub routes and /n/:serverId relay calls', () => {
    const pairing = { host: '127.0.0.1', port: 7681, token: 'node-secret' };

    expect(resolveServerId({ flagValue: null, env: {} })).toBe('local');
    expect(resolveServerId({ flagValue: null, env: { ANYMUX_SERVER: 'prod-1' } })).toBe('prod-1');
    expect(resolveServerId({ flagValue: 'local', env: { ANYMUX_SERVER: 'prod-1' } })).toBe('local');
    expect(() => resolveServerId({ flagValue: 'bad/id' })).toThrowError(/Invalid server id/);

    const localNode = buildRequestPlan({
      method: 'GET', path: '/api/workspace', serverId: 'local', scope: 'node', pairing,
    });
    expect(localNode).toEqual({
      method: 'GET',
      path: '/api/workspace',
      headers: { Authorization: 'Bearer node-secret' },
    });

    const remoteLoopback = buildRequestPlan({
      method: 'GET', path: '/api/workspace', serverId: 'prod', scope: 'node', pairing,
    });
    expect(remoteLoopback).toEqual({
      method: 'GET',
      path: '/n/prod/api/workspace',
      headers: {},
    });

    const remoteWithToken = buildRequestPlan({
      method: 'GET', path: '/api/workspace', serverId: 'prod', scope: 'node', pairing, authToken: 'hub-login-tok',
    });
    expect(remoteWithToken).toEqual({
      method: 'GET',
      path: '/n/prod/api/workspace',
      headers: { Authorization: 'Bearer hub-login-tok' },
    });

    const hubPlan = buildRequestPlan({
      method: 'GET', path: '/api/servers', serverId: 'local', scope: 'hub', pairing,
    });
    expect(hubPlan).toEqual({ method: 'GET', path: '/api/servers', headers: {} });

    expect(() => buildRequestPlan({
      method: 'GET',
      path: '/api/servers',
      serverId: 'local',
      scope: 'hub',
      pairing: { host: '10.0.0.5', port: 7681, token: 'node-secret' },
    })).toThrowError(/Hub authentication token required/);
  });

  it('executes discovery, help, version, status, and remote workspace commands via runCli', async () => {
    const runner = createRunner({
      transport: async (req) => {
        runner.calls.push(req);
        if (req.path === '/api/node/info') {
          return {
            status: 200,
            data: { success: true, data: { version: '1.0.0', protocol: 1, hostname: 'mac', platform: 'darwin', arch: 'arm64', tmux: { available: true, version: 'tmux 3.5a' }, plugins: ['workbench', 'worktrees'] } },
          };
        }
        if (req.path === '/api/agent-status') {
          return { status: 200, data: { success: true, data: { panes: { '%1': { paneId: '%1', status: 'working' } } } } };
        }
        if (req.path === '/api/servers') {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                servers: [
                  { id: 'local', name: '本机', status: { state: 'online', workspace: { transport: 'local' } } },
                  { id: 'prod', status: { state: 'online', workspace: { transport: 'ssh' }, node: { installed: true } } },
                ],
              },
            },
          };
        }
        if (req.path === '/n/prod/api/workspace') {
          return { status: 200, data: { success: true, data: { sessions: [{ id: '$0', name: 'main' }] } } };
        }
        return { status: 200, data: { success: true, data: {} } };
      },
    });

    const ver = await runner.run(['--version']);
    expect(ver.code).toBe(0);
    expect(ver.stdout.trim()).toBe(CLI_VERSION);

    const help = await runner.run(['skills', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('skills get');

    const ctxRes = await runner.run(['agent-context', '--json']);
    expect(ctxRes.code).toBe(0);
    const ctxJson = JSON.parse(ctxRes.stdout);
    expect(ctxJson.ok).toBe(true);
    expect(ctxJson.data.schemaVersion).toBe(1);

    const statusRes = await runner.run(['status', '--json']);
    expect(statusRes.code).toBe(0);
    const statusJson = JSON.parse(statusRes.stdout);
    expect(statusJson.ok).toBe(true);
    expect(statusJson.data.plugins).toEqual(['workbench', 'worktrees']);
    expect(Object.keys(statusJson.data.agentStatus.panes)).toHaveLength(1);

    const statusText = await runner.run(['status']);
    expect(statusText.code).toBe(0);
    expect(statusText.stdout).toContain('agents:   1 tracked pane(s)');

    const srvText = await runner.run(['server', 'list']);
    expect(srvText.code).toBe(0);
    expect(srvText.stdout).toContain('local (本机): online [local]');
    expect(srvText.stdout).toContain('prod: online [ssh]');

    const srvRes = await runner.run(['server', 'list', '--json']);
    expect(srvRes.code).toBe(0);
    expect(JSON.parse(srvRes.stdout).data.servers).toHaveLength(2);
    expect(runner.calls.at(-1).headers.Authorization).toBeUndefined();

    const wsRes = await runner.run(['workspace', 'list', '--server', 'prod', '--json']);
    expect(wsRes.code).toBe(0);
    expect(JSON.parse(wsRes.stdout)).toEqual({ ok: true, data: { sessions: [{ id: '$0', name: 'main' }] } });
    expect(runner.calls.at(-1).path).toBe('/n/prod/api/workspace');
    expect(runner.calls.at(-1).headers.Authorization).toBeUndefined();
  });

  it('returns structured errors with nextSteps and enforces local-only boundaries', async () => {
    const runner = createRunner({
      transport: async (req) => {
        if (req.path === '/n/missing/api/workspace') {
          return { status: 404, data: { success: false, error: { code: 'SERVER_NOT_FOUND', message: 'Server missing is not registered' } } };
        }
        if (req.path === '/api/servers') {
          return { status: 401, data: { success: false, error: 'Authentication required' } };
        }
        if (req.path === '/api/open') {
          return { status: 409, data: { success: false, error: 'preview_source_ambiguous: pass --pane %31' } };
        }
        return { status: 200, data: { success: true, data: {} } };
      },
    });

    const missing = await runner.run(['workspace', 'list', '--server', 'missing', '--json']);
    expect(missing.code).toBe(1);
    const missingBody = JSON.parse(missing.stdout);
    expect(missingBody.ok).toBe(false);
    expect(missingBody.error.code).toBe('server_not_found');
    expect(missingBody.error.nextSteps[0]).toContain('anymux server list --json');

    const unauth = await runner.run(['server', 'list', '--json']);
    expect(unauth.code).toBe(1);
    expect(JSON.parse(unauth.stdout).error.code).toBe('auth_required');

    const ambiguous = await runner.run(['open', '--dock', '/tmp/note.md']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain('Retry command:');
    expect(ambiguous.stderr).toContain("open --dock --pane '<PANE_ID>' /tmp/note.md");

    const remoteSplit = await runner.run(['split', '--server', 'prod', '--json']);
    expect(remoteSplit.code).toBe(2);
    expect(JSON.parse(remoteSplit.stdout).error.code).toBe('unsupported_remote');

    const unknown = await runner.run(['worktre', '--json']);
    expect(unknown.code).toBe(2);
    const unknownBody = JSON.parse(unknown.stdout);
    expect(unknownBody.error.code).toBe('unknown_command');
    expect(unknownBody.error.data.suggestions).toContain('worktree');
  });
});
