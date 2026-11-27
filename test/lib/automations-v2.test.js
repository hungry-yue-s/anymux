import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationsService } from '../../lib/automations/service.js';
import { runPrecheck } from '../../lib/automations/precheck.js';
import { evaluateScheduleDrift } from '../../lib/automations/schedule-drift.js';
import { matchWebhookEvent, verifyWebhookSignature } from '../../lib/automations/webhook-matcher.js';
import { loadAutomationSoul } from '../../lib/automations/soul.js';

const tempDirs = [];
const services = [];

afterEach(async () => {
  for (const s of services.splice(0)) s.dispose();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Automations v2: precheck, drift tolerance, webhook matcher, and SOUL.md', () => {
  it('validates precheck gate, drift evaluator, HMAC webhook verifier, and soul loader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anymux-auto-v2-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'SOUL.md'), 'Keep reports concise and factual.\n');

    const soul = await loadAutomationSoul(dir);
    expect(soul.content).toContain('Keep reports concise');

    expect((await runPrecheck({ command: 'exit 2', cwd: dir })).passed).toBe(false);
    expect((await runPrecheck({ command: 'echo ok', cwd: dir })).passed).toBe(true);

    expect(evaluateScheduleDrift({ lastRunAt: 1000, expectedRunAt: 2000, now: 210_000, intervalMs: 60_000, graceMs: 30_000, maxMissed: 2 })).toMatchObject({
      shouldCatchUp: true,
      missed: 2,
    });
    expect(evaluateScheduleDrift({ lastRunAt: 3000, expectedRunAt: 2000, now: 210_000 })).toMatchObject({ shouldCatchUp: false });

    const payload = { repo: 'anymux', action: 'opened' };
    const sig = 'sha256=' + createHmac('sha256', 'topsecret').update(JSON.stringify(payload)).digest('hex');
    expect(verifyWebhookSignature({ secret: 'topsecret', payload, signatureHeader: sig })).toBe(true);
    expect(verifyWebhookSignature({ secret: 'topsecret', payload, signatureHeader: 'sha256=deadbeef' })).toBe(false);

    expect(matchWebhookEvent({ enabled: true, webhookEvent: 'pr', webhookFilter: { repo: 'anymux' } }, { event: 'pr', payload })).toBe(true);
    expect(matchWebhookEvent({ enabled: true, webhookEvent: 'pr', webhookFilter: { repo: 'other' } }, { event: 'pr', payload })).toBe(false);
  });

  it('skips main execution when precheckCommand fails and triggers signed webhooks with SOUL env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anymux-auto-svc-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'SOUL.md'), 'SOUL_CONTEXT_OK');

    const svc = new AutomationsService({ configDir: dir });
    services.push(svc);

    const skippedJob = await svc.create({
      name: 'gated',
      schedule: '0 0 * * *',
      cwd: dir,
      precheckCommand: 'exit 1',
      command: 'echo SHOULD_NOT_RUN',
    });
    const skippedRun = await svc.runNow(skippedJob.id);
    expect(skippedRun.status).toBe('skipped');

    const secret = 'hook-sec-123';
    const body = { env: 'prod' };
    const sig = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

    const hookJob = await svc.create({
      name: 'hook-job',
      schedule: '0 0 * * *',
      cwd: dir,
      webhookEvent: 'deploy',
      webhookSecret: secret,
      webhookFilter: { env: 'prod' },
      command: 'node -e "process.stdout.write(process.env.ANYMUX_AUTOMATION_SOUL || \'\')"',
    });

    await expect(svc.triggerWebhook({ event: 'deploy', payload: body, signature: 'sha256=bad' })).rejects.toMatchObject({ status: 401 });
    const res = await svc.triggerWebhook({ event: 'deploy', payload: body, signature: sig });
    expect(res.triggered).toHaveLength(1);
    expect(res.triggered[0].jobId).toBe(hookJob.id);
    expect(res.triggered[0].run.status).toBe('ok');
    expect(res.triggered[0].run.output).toContain('SOUL_CONTEXT_OK');
  });
});
