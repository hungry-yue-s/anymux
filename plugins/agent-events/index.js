// `ctx.agentEvents`: what agent hooks report (/api/agent-events, written by
// scripts/agent-event-router.js from Claude, Codex and Qoder hooks): a pane's
// agent stopped, waits for permission or failed (lib/agent-events.js). The
// status monitor uses them for pane state; with the notifications plugin
// loaded they also become notices.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentEventService } from '../../lib/agent-events.js';
import { createAgentEventsRouter } from '../../lib/api/agent-events.js';

const execFileAsync = promisify(execFile);

export const name = 'agent-events';

export const inject = ['http'];

export async function inspectDirtyWorktree(cwd, exec = execFileAsync) {
  if (!cwd) return null;
  try {
    const { stdout: rootOut } = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 2000 });
    const repoRoot = String(rootOut || '').trim();
    if (!repoRoot) return null;
    const { stdout: statusOut } = await exec('git', ['-C', repoRoot, 'status', '--porcelain'], { timeout: 2000 });
    const lines = String(statusOut || '').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return { repoRoot, dirtyCount: lines.length };
  } catch {
    return null;
  }
}

export function apply(ctx, options = {}) {
  const service = new AgentEventService();
  const inspectWorktree = options.inspectDirtyWorktree || inspectDirtyWorktree;
  ctx.inject(['notifications'], (ctx) => {
    service.notificationStore = ctx.notifications;
    ctx.effect(() => () => {
      if (service.notificationStore === ctx.notifications) service.notificationStore = null;
    }, 'agent-events.notices');
  });
  ctx.http.mount('/api/agent-events', createAgentEventsRouter(service, {
    onNotifications: (notifications) => ctx.emit('status/notifications', notifications),
    onEvent: async (result) => {
      const ev = result?.event;
      if (result?.duplicate || !ev?.cwd) return;
      if (ev.state !== 'agent_stopped' && ev.state !== 'waiting_attention') return;
      const dirty = await inspectWorktree(ev.cwd);
      if (!dirty) return;
      ctx.emit('status/event', {
        type: 'open-git',
        path: dirty.repoRoot,
        commit: 'WORKTREE',
        dirtyCount: dirty.dirtyCount,
        paneId: ev.paneId || undefined,
        windowId: ev.windowId || undefined,
        activate: false,
      });
    },
  }));
  ctx.provide('agentEvents', service);
}
