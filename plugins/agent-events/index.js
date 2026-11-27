// `ctx.agentEvents`: what agent hooks report (/api/agent-events, written by
// scripts/agent-event-router.js from Claude, Codex and Qoder hooks): a pane's
// agent stopped, waits for permission or failed (lib/agent-events.js). The
// status monitor uses them for pane state; with the notifications plugin
// loaded they also become notices.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentEventService } from '../../lib/agent-events.js';
import { createAgentEventsRouter } from '../../lib/api/agent-events.js';
import { canonicalAgentType, isSafeAgentSessionId } from '../../lib/session-protection/catalog.js';

const execFileAsync = promisify(execFile);

export const name = 'agent-events';

export const inject = ['http'];

export async function syncPaneAgentBinding(tmux, event, boundMap = null) {
  if (!tmux || typeof tmux.run !== 'function' || !event?.paneId || !/^%\d+$/.test(String(event.paneId))) {
    return false;
  }
  const paneId = String(event.paneId);
  if (event.state === 'session_ended' || event.state === 'process_exited') {
    boundMap?.delete(paneId);
    await tmux.run([
      'set-option', '-p', '-u', '-t', paneId, '@anymux_agent_type', ';',
      'set-option', '-p', '-u', '-t', paneId, '@anymux_agent_session',
    ]).catch(() => {});
    return true;
  }
  const agentType = canonicalAgentType(event.agentType || event.source);
  const sessionId = String(event.sessionId || '').trim();
  if (!agentType || !isSafeAgentSessionId(sessionId)) return false;
  const sig = `${agentType}\0${sessionId}`;
  if (boundMap && boundMap.get(paneId) === sig) return false;
  boundMap?.set(paneId, sig);
  try {
    await tmux.run([
      'set-option', '-p', '-t', paneId, '@anymux_agent_type', agentType, ';',
      'set-option', '-p', '-t', paneId, '@anymux_agent_session', sessionId,
    ]);
    return true;
  } catch {
    boundMap?.delete(paneId);
    return false;
  }
}

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
  let activeTmux = options.tmux || null;
  const boundPaneAgents = new Map();
  ctx.inject(['tmux'], (innerCtx) => {
    activeTmux = innerCtx.tmux;
    innerCtx.effect(() => () => {
      if (activeTmux === innerCtx.tmux) activeTmux = null;
    }, 'agent-events.tmux');
  });
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
      if (!ev) return;
      syncPaneAgentBinding(activeTmux, ev, boundPaneAgents).catch(() => {});
      if (!result?.duplicate) {
        ctx.emit('status/agent-state', ev);
      }
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
