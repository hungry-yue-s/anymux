// Bounded shell precheck gate for Automations v2.
// Ported from stablyai/orca (MIT).

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function runPrecheck({
  command,
  cwd,
  timeoutMs = 15_000,
} = {}) {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed) return { passed: true, exitCode: 0, output: '' };
  try {
    const { stdout = '', stderr = '' } = await execAsync(trimmed, {
      cwd,
      timeout: Math.max(500, Math.min(120_000, Number(timeoutMs) || 15_000)),
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    return {
      passed: true,
      exitCode: 0,
      output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(),
    };
  } catch (err) {
    return {
      passed: false,
      exitCode: typeof err?.code === 'number' ? err.code : 1,
      output: String(err?.stderr || err?.stdout || err?.message || 'precheck failed').trim(),
    };
  }
}
