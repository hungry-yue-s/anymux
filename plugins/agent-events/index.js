// `ctx.agentEvents`: what agent hooks report (/api/agent-events, written by
// scripts/agent-event-router.js from Claude, Codex and Qoder hooks): a pane's
// agent stopped, waits for permission or failed (lib/agent-events.js). The
// status monitor uses them for pane state; with the notifications plugin
// loaded they also become notices.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentEventService, extractTmuxServerPid } from '../../lib/agent-events.js';
import { createAgentEventsRouter } from '../../lib/api/agent-events.js';
import { canonicalAgentType, isSafeAgentSessionId } from '../../lib/session-protection/catalog.js';

const execFileAsync = promisify(execFile);

export const name = 'agent-events';

export const inject = ['http'];

export function createTmuxEventValidator({ getTmux, now = () => Date.now(), cacheTtlMs = 2000 } = {}) {
  let cachedInstance = null;
  let cachedAt = 0;

  return {
    invalidate() {
      cachedInstance = null;
      cachedAt = 0;
    },
    async validate(body) {
      const incomingPid = extractTmuxServerPid(body);
      const tmux = typeof getTmux === 'function' ? getTmux() : null;
      if (!tmux || typeof tmux.getServerInstance !== 'function') {
        return { ignore: false, patch: null };
      }
      const currentNow = now();
      const cachedPid = cachedInstance ? cachedInstance.split(':')[0] : '';
      const staleCache = !cachedInstance || (currentNow - cachedAt >= cacheTtlMs);
      const pidMismatch = Boolean(incomingPid && cachedPid && incomingPid !== cachedPid);
      if (staleCache || pidMismatch) {
        cachedInstance = await tmux.getServerInstance().catch(() => null);
        cachedAt = now();
      }
      const livePid = cachedInstance ? cachedInstance.split(':')[0] : '';
      if (incomingPid && (!livePid || incomingPid !== livePid)) {
        return { ignore: true, reason: 'tmux_server_mismatch' };
      }
      return { ignore: false, patch: cachedInstance ? { serverInstance: cachedInstance } : null };
    },
  };
}

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
  const validator = createTmuxEventValidator({ getTmux: () => activeTmux });
  ctx.inject(['tmux'], (innerCtx) => {
    activeTmux = innerCtx.tmux;
    validator.invalidate();
    innerCtx.effect(() => () => {
      if (activeTmux === innerCtx.tmux) {
        activeTmux = null;
        validator.invalidate();
      }
    }, 'agent-events.tmux');
  });
  ctx.inject(['notifications'], (ctx) => {
    service.notificationStore = ctx.notifications;
    ctx.effect(() => () => {
      if (service.notificationStore === ctx.notifications) service.notificationStore = null;
    }, 'agent-events.notices');
  });
  ctx.on('status/tmux-restarted', () => {
    boundPaneAgents.clear();
    validator.invalidate();
  });
  ctx.http.mount('/api/agent-events', createAgentEventsRouter(service, {
    onNotifications: (notifications) => ctx.emit('status/notifications', notifications),
    validateEvent: (body) => validator.validate(body),
    onEvent: async (result, rawPayload) => {
      const ev = result?.event;
      if (!ev) return;
      ctx.emit('agent-events/raw', { event: ev, raw: rawPayload || {} });
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
