import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationsService, validateCronExpression } from '../../lib/automations/service.js';

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Croner Automations service', () => {
  it('validates cron expressions and persists/executes jobs cleanly without leaking timers', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'anymux-auto-test-'));
    dirs.push(configDir);

    expect(() => validateCronExpression('invalid cron')).toThrow();
    expect(validateCronExpression('*/5 * * * *')).toBe('*/5 * * * *');

    const notices = [];
    const svc = new AutomationsService({ configDir, onNotify: (n) => notices.push(n) });
    await svc.start();

    const job = await svc.create({
      name: 'echo check',
      schedule: '0 * * * *',
      cwd: configDir,
      command: 'echo hello-automation',
      notifyOnFinish: true,
    });
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0].nextRunAt).toBeGreaterThan(Date.now());

    const run = await svc.runNow(job.id);
    expect(run.status).toBe('ok');
    expect(run.output.trim()).toBe('hello-automation');
    expect(notices).toHaveLength(1);
    expect(notices[0].state).toBe('agent_stopped');

    // Reload from disk in fresh instance
    svc.dispose();
    expect(svc.crons.size).toBe(0);

    const reloaded = new AutomationsService({ configDir });
    await reloaded.start();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.runs(job.id)).toHaveLength(1);
    await reloaded.remove(job.id);
    expect(reloaded.list()).toHaveLength(0);
    reloaded.dispose();
  });
});
