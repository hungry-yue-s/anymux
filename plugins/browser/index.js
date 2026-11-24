// The browser block: a page of this machine's localhost, or any URL, beside
// the terminal (client/js/browser-block.js), plus an optional `agent-browser`
// CLI bridge (/api/browser/agent-browser) reusing `vercel-labs/agent-browser`.
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, ErrorCode, handle } from '../../lib/servers/errors.js';
import { requireSameOrigin } from '../../lib/api/same-origin.js';

const execFileAsync = promisify(execFile);
const ALLOWED_SUBCOMMANDS = new Set(['open', 'snapshot', 'screenshot', 'get-url', 'close']);

export function createBrowserRouter({ exec = execFileAsync } = {}) {
  const router = express.Router();

  router.get('/agent-browser', handle(async () => {
    try {
      const { stdout } = await exec('agent-browser', ['--version'], { timeout: 3000 });
      return { available: true, version: String(stdout || '').trim(), installHint: 'npm install -g agent-browser' };
    } catch {
      return { available: false, version: null, installHint: 'npm install -g agent-browser' };
    }
  }));

  router.post('/agent-browser', requireSameOrigin, handle(async (req) => {
    const body = req.body || {};
    const cmd = typeof body.command === 'string' ? body.command.trim() : '';
    if (!ALLOWED_SUBCOMMANDS.has(cmd)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported agent-browser subcommand');
    }
    const args = [cmd, ...(Array.isArray(body.args) ? body.args.map(String) : [])];
    try {
      const { stdout, stderr } = await exec('agent-browser', args, { timeout: 15_000, maxBuffer: 512 * 1024 });
      return { ok: true, command: cmd, stdout: String(stdout || ''), stderr: String(stderr || '') };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        const error = new AppError(ErrorCode.UNSUPPORTED, '未安装 agent-browser，请先运行 npm install -g agent-browser');
        error.status = 503;
        throw error;
      }
      throw new AppError(ErrorCode.INTERNAL, String(err?.stderr || err?.message || 'agent-browser 执行失败'));
    }
  }));

  return router;
}

export const name = 'browser';

export const inject = ['http'];

export function apply(ctx) {
  ctx.http.mount('/api/browser', createBrowserRouter());
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
