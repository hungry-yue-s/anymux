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
} from '../../bin/anymux.mjs';
import { createBrowserRouter } from '../../plugins/browser/index.js';

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
