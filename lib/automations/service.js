import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Cron } from 'croner';
import { replaceFile } from '../atomic-file.js';
import { AppError, ErrorCode } from '../servers/errors.js';

const MAX_RUN_HISTORY = 20;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function validation(message) {
  return new AppError(ErrorCode.VALIDATION_ERROR, message);
}

export function validateCronExpression(schedule) {
  if (typeof schedule !== 'string' || !schedule.trim()) {
    throw validation('Cron 表达式不能为空');
  }
  const trimmed = schedule.trim();
  try {
    const job = new Cron(trimmed, { paused: true });
    job.stop();
  } catch (err) {
    throw validation('无效的 Cron 表达式: ' + (err?.message || trimmed));
  }
  return trimmed;
}

export class AutomationsService {
  constructor({ configDir, tmux = null, workspace = null, onNotify = null } = {}) {
    this.storePath = join(configDir, 'automations.json');
    this.tmux = tmux;
    this.workspace = workspace;
    this.onNotify = onNotify;
    this.jobs = new Map();
    this.crons = new Map();
    this.running = new Map();
    this.writeQueue = Promise.resolve();
    this.started = false;
    this.disposed = false;
  }

  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.jobs)) {
        for (const item of parsed.jobs) {
          if (item && item.id) {
            this.jobs.set(item.id, item);
            this._armJob(item);
          }
        }
      }
    } catch {
      /* start with empty schedule when store does not exist yet */
    }
  }

  dispose() {
    this.disposed = true;
    for (const cron of this.crons.values()) {
      try { cron.stop(); } catch { /* ignore */ }
    }
    this.crons.clear();
  }

  _persist() {
    const snapshot = JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await replaceFile(tmp, this.storePath);
    });
    return this.writeQueue;
  }

  _armJob(job) {
    const prev = this.crons.get(job.id);
    if (prev) {
      try { prev.stop(); } catch { /* ignore */ }
      this.crons.delete(job.id);
    }
    if (this.disposed || !job.enabled) return;
    const task = new Cron(job.schedule, () => {
      this.runNow(job.id).catch(() => {});
    });
    this.crons.set(job.id, task);
  }

  list() {
    return [...this.jobs.values()].map((job) => ({
      ...job,
      nextRunAt: this.crons.get(job.id)?.nextRun()?.getTime?.() || null,
    }));
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, '自动化任务不存在');
    return job;
  }

  async create(input) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const command = typeof input?.command === 'string' ? input.command.trim() : '';
    if (!name || name.length > 120) throw validation('任务名称需为 1–120 个字符');
    if (!command || command.length > 4000) throw validation('命令不能为空且不超过 4000 字符');
    const schedule = validateCronExpression(input.schedule);
    const target = input.target === 'new-window' ? 'new-window' : 'shell';
    const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : homedir();
    const now = Date.now();
    const job = {
      id: 'auto_' + randomUUID().slice(0, 8),
      name,
      schedule,
      enabled: input.enabled !== false,
      cwd,
      command,
      target,
      sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      timeoutMs: Math.max(1000, Math.min(600_000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS)),
      notifyOnFinish: Boolean(input.notifyOnFinish),
      notifyOnFailure: input.notifyOnFailure !== false,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastStatus: null,
      runs: [],
    };
    this.jobs.set(job.id, job);
    this._armJob(job);
    await this._persist();
    return job;
  }

  async update(id, patch = {}) {
    const job = this.get(id);
    const next = { ...job };
    if (patch.name !== undefined) {
      const name = String(patch.name || '').trim();
      if (!name || name.length > 120) throw validation('任务名称无效');
      next.name = name;
    }
    if (patch.schedule !== undefined) next.schedule = validateCronExpression(patch.schedule);
    if (patch.command !== undefined) {
      const cmd = String(patch.command || '').trim();
      if (!cmd) throw validation('命令不能为空');
      next.command = cmd;
    }
    if (patch.cwd !== undefined) next.cwd = String(patch.cwd || homedir()).trim() || homedir();
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.target === 'shell' || patch.target === 'new-window') next.target = patch.target;
    if (patch.notifyOnFinish !== undefined) next.notifyOnFinish = Boolean(patch.notifyOnFinish);
    if (patch.notifyOnFailure !== undefined) next.notifyOnFailure = Boolean(patch.notifyOnFailure);
    next.updatedAt = Date.now();
    this.jobs.set(id, next);
    this._armJob(next);
    await this._persist();
    return next;
  }

  async remove(id) {
    this.get(id);
    const cron = this.crons.get(id);
    if (cron) {
      try { cron.stop(); } catch { /* ignore */ }
      this.crons.delete(id);
    }
    this.jobs.delete(id);
    await this._persist();
    return { removed: true, id };
  }

  runs(id) {
    return this.get(id).runs || [];
  }

  async runNow(id) {
    const job = this.get(id);
    if (this.running.has(id)) return this.running.get(id);
    const task = this._executeJob(job).finally(() => {
      if (this.running.get(id) === task) this.running.delete(id);
    });
    this.running.set(id, task);
    return task;
  }

  async _executeJob(job) {
    const startedAt = Date.now();
    let result;
    if (job.target === 'new-window') {
      if (!this.tmux?.run) {
        result = { status: 'failed', exitCode: 1, output: 'tmux 不可用' };
      } else {
        try {
          let targetSession = job.sessionId;
          if (!targetSession && this.workspace?.getWorkspace) {
            const tree = await this.workspace.getWorkspace().catch(() => null);
            targetSession = tree?.sessions?.[0]?.id || null;
          }
          const args = ['new-window', '-d', '-P', '-F', '#{window_id}|#{pane_id}', '-n', job.name.slice(0, 24), '-c', job.cwd];
          if (targetSession) args.push('-t', targetSession);
          args.push(job.command);
          const out = String(await this.tmux.run(args)).trim();
          this.workspace?.invalidate?.();
          result = { status: 'ok', exitCode: 0, output: `created window ${out}` };
        } catch (err) {
          result = { status: 'failed', exitCode: 1, output: String(err?.message || err) };
        }
      }
    } else {
      result = await this._runShell(job.command, job.cwd, job.timeoutMs || DEFAULT_TIMEOUT_MS);
    }

    const finishedAt = Date.now();
    const record = {
      id: 'run_' + randomUUID().slice(0, 8),
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
    };

    const current = this.jobs.get(job.id);
    if (current) {
      current.lastRunAt = finishedAt;
      current.lastStatus = record.status;
      current.runs = [record, ...(current.runs || [])].slice(0, MAX_RUN_HISTORY);
      await this._persist();
    }

    const shouldNotify = (record.status === 'failed' && job.notifyOnFailure) || (record.status === 'ok' && job.notifyOnFinish);
    if (shouldNotify && typeof this.onNotify === 'function') {
      try {
        this.onNotify({
          id: 'automation-' + record.id,
          type: 'agent-event',
          source: 'automation',
          state: record.status === 'failed' ? 'failed' : 'agent_stopped',
          windowName: job.name,
          reason: record.status === 'failed'
            ? `定时任务「${job.name}」执行失败 (exit ${record.exitCode})`
            : `定时任务「${job.name}」执行完成`,
          timestamp: finishedAt,
          read: false,
        });
      } catch { /* notification failure never breaks automation state */ }
    }
    return record;
  }

  _runShell(command, cwd, timeoutMs) {
    return new Promise((resolveRun) => {
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
      const child = spawn(shell, args, { cwd, windowsHide: true });
      const chunks = [];
      let total = 0;
      let timedOut = false;

      const append = (chunk) => {
        if (total >= MAX_OUTPUT_BYTES) return;
        const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - total);
        chunks.push(slice);
        total += slice.length;
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* ignore */ }
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (err) => {
        clearTimeout(timer);
        resolveRun({ status: 'failed', exitCode: 1, output: String(err?.message || err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf8');
        if (timedOut) resolveRun({ status: 'failed', exitCode: code ?? 124, output: output + '\n[timed out]' });
        else resolveRun({ status: code === 0 ? 'ok' : 'failed', exitCode: code ?? 0, output });
      });
    });
  }
}
