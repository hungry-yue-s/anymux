// Bounded shell runner for worktree setupScript / teardownScript hooks.
// Ported from stablyai/orca (MIT).

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function runWorktreeHook({
  script,
  cwd,
  env = {},
  timeoutMs = 30_000,
} = {}) {
  const command = typeof script === 'string' ? script.trim() : '';
  if (!command) return { ran: false, ok: true, stdout: '', stderr: '' };

  try {
    const { stdout = '', stderr = '' } = await execAsync(command, {
      cwd,
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    return { ran: true, ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      ran: true,
      ok: false,
      stdout: String(err.stdout || '').trim(),
      stderr: String(err.stderr || err.message || '').trim(),
      code: err.code ?? null,
    };
  }
}
