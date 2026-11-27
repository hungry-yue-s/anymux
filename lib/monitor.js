import * as tmux from './tmux.js';
import { scanPorts } from './ports.js';
import {
  scanProcessTable,
  resolvePaneAgentFromProcesses,
  matchAgentFromCommand,
  detectAgentFromScreen,
  fusePaneAgentStatus,
  buildAgentStatusSnapshot,
  normalizeDirPath,
} from './agent-status.js';

function parseServerInstance(instanceId) {
  const match = String(instanceId || '').trim().match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return {
    instanceId: `${match[1]}:${match[2]}`,
    pid: match[1],
    startedAtMs: Number(match[2]) * 1000,
  };
}

const PORT_CACHE_TTL_MS = 10_000;
const ACTIVE_STATES_BEFORE_DONE = new Set(['working', 'permission', 'monitoring']);

function pickSemanticMap(entries) {
  const out = Object.create(null);
  if (!entries || typeof entries !== 'object') return out;
  for (const key of Object.keys(entries)) {
    const e = entries[key];
    if (!e) continue;
    out[key] = {
      status: e.status || '',
      agentType: e.agentType || '',
      appKind: e.appKind || '',
      label: e.label || '',
      prompt: e.prompt || '',
      shortModel: e.shortModel || '',
      subagentCount: Number(e.subagentCount || 0),
      unread: Boolean(e.unread),
      agentCount: Number(e.agentCount || 0),
      command: e.command || '',
      sessionName: e.sessionName || '',
      windowId: e.windowId || '',
    };
  }
  return out;
}

function stableSnapshotSignature(snapshot) {
  return JSON.stringify({
    hasAgents: Boolean(snapshot.hasAgents),
    serverInstance: snapshot.serverInstance || '',
    panes: pickSemanticMap(snapshot.panes),
    windows: pickSemanticMap(snapshot.windows),
    sessions: pickSemanticMap(snapshot.sessions),
  });
}

export class StatusMonitor {
  /**
   * @param {{ notificationStore?: import('./notifications.js').NotificationStore, agentEvents?: import('./agent-events.js').AgentEventService, scanProcesses?: Function }} [options]
   */
  constructor(options = {}) {
    this.subscribers = new Set();
    this.previousState = null;
    this.interval = null;
    this._portCache = new Map(); // paneId → { pid, ports, timestamp }
    this._lastPaneCmds = new Map(); // paneId → cmd (for pane-cmd broadcasts)
    this._notificationStore = options.notificationStore || null;
    this._agentEvents = options.agentEvents || null;
    this._scanProcesses = options.scanProcesses || scanProcessTable;
    let captureFn = options.capturePaneTails || null;
    if (!captureFn) {
      try {
        captureFn = typeof tmux.capturePaneTails === 'function' ? tmux.capturePaneTails : null;
      } catch {
        captureFn = null;
      }
    }
    this._capturePaneTails = captureFn;
    let snapshotFn = options.snapshotServerState || null;
    if (!snapshotFn) {
      try {
        snapshotFn = typeof tmux.snapshotServerState === 'function' ? tmux.snapshotServerState : null;
      } catch {
        snapshotFn = null;
      }
    }
    this._snapshotServerState = snapshotFn;
    this._borderConfigEnsured = false;
    /** serverId -> latest health status, replayed to new subscribers. */
    this._serverStatuses = new Map();
    this._polling = null;
    this._generation = 0;

    // Agent lifecycle & Orca-style fused sidebar status
    this._paneAgentStatuses = new Map(); // paneId -> fused status object
    this._paneMeta = new Map(); // paneId -> { sessionId, sessionName, windowId, windowIndex, windowName, command, title, pid, path, seenAt }
    this._lastSessions = [];
    this._ackedAtByPane = new Map(); // paneId -> timestamp
    this._agentSnapshot = { hasAgents: false, serverInstance: '', updatedAt: 0, panes: {}, windows: {}, sessions: {} };
    this._lastAgentSignature = null;
    this._lastAgentStatusSerialized = null;
    this._hadAgentStatus = false;
    this._serverInstance = null;
    this._serverPid = '';
    this._serverStartedAtMs = 0;
    this._onServerRestart = typeof options.onServerRestart === 'function' ? options.onServerRestart : null;
    this._onServerInstance = typeof options.onServerInstance === 'function' ? options.onServerInstance : null;
  }

  /**
   * Notices go to this store from now on; the returned
   * function stops that (both may come and go while the monitor runs).
   */
  useNotificationStore(store) {
    this._notificationStore = store;
    if (this._serverInstance && typeof store?.invalidateForServer === 'function') {
      store.invalidateForServer(this._serverInstance);
    }
    return () => { if (this._notificationStore === store) this._notificationStore = null; };
  }

  /** Agent hook events decide pane state from now on; the returned function stops that. */
  useAgentEvents(agentEvents) {
    this._agentEvents = agentEvents;
    return () => { if (this._agentEvents === agentEvents) this._agentEvents = null; };
  }

  start(intervalMs) {
    if (this.interval) {
      this.stop();
    }
    this.poll();
    this.interval = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // A round still running must not report after this.
    this._generation += 1;
    this._polling = null;
  }

  subscribe(ws) {
    this.subscribers.add(ws);
    if (this.previousState) {
      this._send(ws, this.previousState);
    }
    // Server status is edge-triggered, so replay the latest per server or a new
    // tab would show nothing until something changes.
    for (const status of this._serverStatuses.values()) {
      this._send(ws, JSON.stringify({ type: 'server-status', serverId: status.serverId, data: status }));
    }
    if (this._hadAgentStatus && this._lastAgentStatusSerialized) {
      this._send(ws, this._lastAgentStatusSerialized);
    }
  }

  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }

  /** Health result for one server. */
  broadcastServerStatus(status) {
    if (!status || !status.serverId) return;
    this._serverStatuses.set(status.serverId, status);
    this._broadcast(JSON.stringify({ type: 'server-status', serverId: status.serverId, data: status }));
  }

  broadcastNotifications(notifications) {
    if (!Array.isArray(notifications) || notifications.length === 0) return;
    this._broadcast(JSON.stringify({ type: 'notifications', data: notifications }));
  }

  /** A request from a pane (e.g. `anymux open`) for the browsers watching this machine. */
  broadcastEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    this._broadcast(JSON.stringify(event));
  }

  /** One server's workspace tree changed; clients refetch by revision. */
  broadcastWorkspaceChanged(revision) {
    this._broadcast(JSON.stringify({ type: 'workspace-changed', revision }));
  }

  getAgentStatus() {
    return this._agentSnapshot;
  }

  _resetServerBoundState({ serverPid = '', startedAtMs = 0, strict = true, prevInstance = null, nextInstance = null } = {}) {
    this._paneAgentStatuses.clear();
    this._paneMeta.clear();
    this._ackedAtByPane.clear();
    this._lastPaneCmds.clear();
    this._portCache.clear();
    this._borderConfigEnsured = false;

    if (this._agentEvents) {
      if (typeof this._agentEvents.resetForServer === 'function') {
        this._agentEvents.resetForServer({ serverPid, startedAtMs, strict });
      } else if (typeof this._agentEvents.resetPaneStates === 'function') {
        this._agentEvents.resetPaneStates();
      }
    }

    if (this._onServerRestart) {
      try {
        this._onServerRestart({ prevInstance, nextInstance });
      } catch {
        // Ignore restart listener failures.
      }
    }
  }

  /** Fast-path update triggered immediately when an Agent Hook arrives over HTTP. */
  handleAgentEvent(ev) {
    if (!ev || !ev.paneId) return;
    if (ev.tmuxServerPid && this._serverPid && String(ev.tmuxServerPid) !== this._serverPid) {
      void this.poll();
      return;
    }
    const now = Date.now();
    const paneId = ev.paneId;
    const meta = this._paneMeta.get(paneId) || {
      sessionId: ev.session || ev.sessionId || '',
      sessionName: ev.session || '',
      windowId: ev.windowId || '',
      windowIndex: ev.windowIndex ?? 0,
      windowName: ev.windowName || '',
      command: ev.command || '',
      title: '',
      path: '',
    };

    if (ev.state === 'agent_running') {
      this._ackedAtByPane.delete(paneId);
      if (this._notificationStore?.markReadByPane) {
        this._notificationStore.markReadByPane(paneId);
      }
    }

    if (!this._paneMeta.has(paneId) && meta.windowId) {
      this._paneMeta.set(paneId, meta);
    }

    const hookState = this._agentEvents?.getPaneState?.(paneId) || {
      ...ev,
      updatedAt: ev.timestamp || now,
    };
    const prevStatus = this._paneAgentStatuses.get(paneId) || null;
    const processMatch = prevStatus?.agentType
      ? { agentType: prevStatus.agentType, command: prevStatus.command || meta.command || '' }
      : null;

    const fused = fusePaneAgentStatus({
      pane: {
        id: paneId,
        command: meta.command || ev.command || '',
        title: meta.title || '',
        path: meta.path || '',
        windowId: meta.windowId || '',
      },
      hookState,
      processMatch,
      prevStatus,
      now,
    });

    if (fused) {
      if (fused.status === 'done' && (this._ackedAtByPane.get(paneId) || 0) >= (fused.updatedAt || 0)) {
        fused.unread = false;
      }
      this._paneAgentStatuses.set(paneId, fused);
    } else {
      this._paneAgentStatuses.delete(paneId);
    }

    this._publishAgentSnapshot(this._sessionsForSnapshot(), now);
  }

  _sessionsForSnapshot() {
    if (this._lastSessions.length > 0) return this._lastSessions;
    const bySession = new Map();
    for (const [paneId, meta] of this._paneMeta.entries()) {
      if (!meta.windowId) continue;
      const sessKey = meta.sessionId || meta.sessionName || 'default';
      let sess = bySession.get(sessKey);
      if (!sess) {
        sess = { id: sessKey, name: meta.sessionName || sessKey, windows: [] };
        bySession.set(sessKey, sess);
      }
      let win = sess.windows.find((w) => w.id === meta.windowId);
      if (!win) {
        win = { id: meta.windowId, index: meta.windowIndex ?? 0, name: meta.windowName || '', panes: [] };
        sess.windows.push(win);
      }
      win.panes.push({ id: paneId, command: meta.command || '' });
    }
    return [...bySession.values()];
  }

  /** Acknowledge finished / unread indicators for a pane, window, or session when viewed. */
  acknowledgePane({ paneId, windowId, sessionId } = {}) {
    const now = Date.now();
    let changed = false;

    for (const [id, entry] of this._paneAgentStatuses.entries()) {
      const meta = this._paneMeta.get(id);
      const matchesPane = paneId && id === paneId;
      const matchesWindow = windowId && meta?.windowId === windowId;
      const matchesSession = sessionId && (meta?.sessionId === sessionId || meta?.sessionName === sessionId);
      if (!matchesPane && !matchesWindow && !matchesSession) continue;

      if (entry.status === 'done' && entry.unread) {
        entry.unread = false;
        this._ackedAtByPane.set(id, now);
        changed = true;
      }
      if (this._notificationStore?.markReadByPane && matchesPane) {
        this._notificationStore.markReadByPane(id);
      }
    }

    if (changed) {
      this._publishAgentSnapshot(this._sessionsForSnapshot(), now);
    }
    return changed;
  }

  /** A slow round does not pile up behind the interval: the next tick joins it. */
  poll() {
    if (this._polling) return this._polling;
    const running = this._poll().finally(() => {
      if (this._polling === running) this._polling = null;
    });
    this._polling = running;
    return running;
  }

  async _poll() {
    const generation = this._generation;
    const pollStartedAt = Date.now();
    try {
      const batched = this._snapshotServerState ? await this._snapshotServerState() : null;
      const canUseBatch = Boolean(
        batched
        && Array.isArray(batched.sessions)
        && batched.sessions.every((session) => session.id),
      );
      const serverInstance = canUseBatch ? (batched.serverInstance || null) : null;
      const sessions = canUseBatch ? batched.sessions : await tmux.listSessions();
      if (generation !== this._generation) return;

      if (serverInstance) {
        const parsed = parseServerInstance(serverInstance);
        if (parsed) {
          const prevServerInstance = this._serverInstance;
          if (prevServerInstance && prevServerInstance !== serverInstance) {
            this._resetServerBoundState({
              serverPid: parsed.pid,
              startedAtMs: parsed.startedAtMs,
              strict: true,
              prevInstance: prevServerInstance,
              nextInstance: serverInstance,
            });
          } else {
            this._agentEvents?.resetForServer?.({
              serverPid: parsed.pid,
              startedAtMs: parsed.startedAtMs,
              strict: false,
            });
          }
          this._serverInstance = serverInstance;
          this._serverPid = parsed.pid;
          this._serverStartedAtMs = parsed.startedAtMs;
          if (prevServerInstance !== serverInstance && this._onServerInstance) {
            try {
              this._onServerInstance(serverInstance);
            } catch {
              // Ignore server instance listener failures.
            }
          }
        }
      } else if (sessions.length === 0) {
        if (this._serverInstance || this._paneMeta.size > 0 || this._paneAgentStatuses.size > 0) {
          this._resetServerBoundState({
            strict: true,
            prevInstance: this._serverInstance,
            nextInstance: null,
          });
        }
        this._serverInstance = null;
        this._serverPid = '';
        this._serverStartedAtMs = 0;
      }

      // Re-apply the global pane-border config once whenever a tmux server
      // (re)appears — options are runtime-only and reset on tmux restart.
      if (sessions.length > 0) {
        if (!this._borderConfigEnsured) {
          this._borderConfigEnsured = true;
          // On a transient failure, re-arm so the next poll retries.
          tmux.ensurePaneBorderConfig().catch(() => { this._borderConfigEnsured = false; });
          // The same moment for the environment new panes start from. On its
          // own and without a retry: pane labels do not depend on it.
          tmux.ensureHyperlinkEnvironment().catch(() => {});
        }
      } else {
        this._borderConfigEnsured = false;
      }

      const sessionsWithWindows = await Promise.all(
        sessions.map(async (session) => {
          const windows = canUseBatch
            ? (batched.windowsBySession.get(session.id) || [])
            : await tmux.listWindows(session.name);
          let paneCommands = [];
          if (canUseBatch) {
            paneCommands = batched.paneCommandsBySession.get(session.id) || [];
          } else {
            try {
              paneCommands = await tmux.listPaneCommands(session.name);
            } catch {
              // Ignore — pane command fetch failure should not abort status
            }
          }

          // Build panePids map for port scanning, with cache support
          const panePids = new Map();
          const now = Date.now();
          for (const pc of paneCommands) {
            const cached = this._portCache.get(pc.paneId);
            const isStale = !cached ||
              cached.pid !== pc.pid ||
              (now - cached.timestamp) >= PORT_CACHE_TTL_MS;
            if (isStale && pc.pid > 0) {
              panePids.set(pc.paneId, pc.pid);
            }
          }

          // Scan ports for panes that need refreshing
          let newPortMap = new Map();
          if (panePids.size > 0) {
            try {
              newPortMap = await scanPorts(panePids);
            } catch {
              // Port scan failure should not abort status
            }
            // Update cache with newly scanned results
            for (const [paneId, ports] of newPortMap) {
              const pid = panePids.get(paneId);
              this._portCache.set(paneId, { pid, ports, timestamp: now });
            }
          }

          const windowsWithPanes = windows.map((w) => {
            const panes = paneCommands
              .filter((pc) => pc.windowIndex === w.index)
              .map((pc) => {
                const cached = this._portCache.get(pc.paneId);
                const ports = cached ? cached.ports : [];
                return { id: pc.paneId, command: pc.command, path: pc.path, ports };
              });
            return { ...w, panes };
          });
          return { ...session, windowDetails: windowsWithPanes, _paneCommands: paneCommands };
        }),
      );
      if (generation !== this._generation) return;

      const totalSessions = sessionsWithWindows.length;
      const totalWindows = sessionsWithWindows.reduce(
        (sum, s) => sum + s.windows,
        0,
      );

      // Prune _portCache entries for panes that no longer exist
      const livePaneIds = new Set(
        sessionsWithWindows.flatMap((s) => (s._paneCommands || []).map((pc) => pc.paneId)),
      );
      for (const cachedId of this._portCache.keys()) {
        if (!livePaneIds.has(cachedId)) {
          this._portCache.delete(cachedId);
        }
      }

      // Broadcast pane-cmd on any foreground process change
      const currentPaneCmds = new Map();
      for (const session of sessionsWithWindows) {
        for (const pc of (session._paneCommands || [])) {
          currentPaneCmds.set(pc.paneId, pc.command);
        }
      }
      const hasBaseline = this._lastPaneCmds.size > 0;
      if (hasBaseline) {
        for (const [paneId, cmd] of currentPaneCmds) {
          if (this._lastPaneCmds.get(paneId) !== cmd) {
            this._broadcast(JSON.stringify({ type: 'pane-cmd', paneId, cmd }));
          }
        }
        for (const paneId of this._lastPaneCmds.keys()) {
          if (!currentPaneCmds.has(paneId)) this._lastPaneCmds.delete(paneId);
        }
      }
      this._lastPaneCmds = currentPaneCmds;

      // Scan host process tree only when at least one pane exists with a pid
      const hasAnyPid = sessionsWithWindows.some((s) => (s._paneCommands || []).some((pc) => pc.pid > 0));
      let processMap = new Map();
      if (hasAnyPid) {
        try {
          processMap = await this._scanProcesses();
        } catch {
          processMap = new Map();
        }
      }
      if (generation !== this._generation) return;

      const pollNow = Date.now();
      const addedNotifications = [];
      const nextFusedPanes = new Map();
      const snapshotSessions = [];
      const pendingPanes = [];
      const screenCandidateIds = [];

      for (const session of sessionsWithWindows) {
        const paneCommands = session._paneCommands || [];
        const pcByPane = new Map(paneCommands.map((pc) => [pc.paneId, pc]));

        for (const w of session.windowDetails) {
          for (const pane of w.panes) {
            const pc = pcByPane.get(pane.id) || { paneId: pane.id, command: pane.command, path: pane.path, pid: 0, title: '' };
            const paneLabel = pc.label || pane.label || '';
            const prevMeta = this._paneMeta.get(pane.id) || null;
            const meta = {
              sessionId: session.id || session.name,
              sessionName: session.name,
              windowId: w.id,
              windowIndex: w.index,
              windowName: w.name || '',
              command: pc.command || '',
              title: pc.title || '',
              label: paneLabel,
              pid: pc.pid || 0,
              path: pc.path || '',
              seenAt: pollNow,
            };
            this._paneMeta.set(pane.id, meta);

            const processMatch = pc.pid > 0 ? resolvePaneAgentFromProcesses(pc.pid, processMap) : null;
            const hasLiveProcess = Boolean(processMatch?.agentType || matchAgentFromCommand(pc.command));
            let hookState = this._agentEvents?.getPaneState?.(pane.id) || null;
            let prevStatus = this._paneAgentStatuses.get(pane.id) || null;

            const pidChanged = Boolean(prevMeta?.pid > 0 && pc.pid > 0 && prevMeta.pid !== pc.pid);
            if (pidChanged) {
              prevStatus = null;
              this._ackedAtByPane.delete(pane.id);
              if (hookState && (hookState.updatedAt || 0) <= (prevMeta.seenAt || 0)) {
                this._agentEvents?.clearPaneState?.(pane.id);
                hookState = null;
              }
            }

            if (hookState) {
              const wrongServerPid = Boolean(hookState.tmuxServerPid && this._serverPid && hookState.tmuxServerPid !== this._serverPid);
              const predatesServer = Boolean(
                this._serverStartedAtMs > 0
                && (hookState.updatedAt || 0) > 0
                && hookState.updatedAt < this._serverStartedAtMs - 2000,
              );
              const crossWindowOrCwd = !hasLiveProcess && (
                (hookState.windowId && w.id && hookState.windowId !== w.id)
                || (hookState.cwd && pc.path && normalizeDirPath(hookState.cwd) !== normalizeDirPath(pc.path))
              );
              if (wrongServerPid || predatesServer || crossWindowOrCwd) {
                this._agentEvents?.clearPaneState?.(pane.id);
                hookState = null;
              }
            }

            const hintAgent = processMatch?.agentType || matchAgentFromCommand(pc.command) || hookState?.agentType || prevStatus?.agentType || '';
            if (hasLiveProcess) {
              screenCandidateIds.push(pane.id);
            }
            pendingPanes.push({ pane, pc, paneLabel, meta, processMatch, hookState, prevStatus, hintAgent, windowId: w.id });
          }
        }

        snapshotSessions.push({
          id: session.id || session.name,
          name: session.name,
          windows: session.windowDetails,
        });
      }

      let screenTailMap = new Map();
      if (screenCandidateIds.length > 0 && this._capturePaneTails) {
        try {
          const captured = await this._capturePaneTails(screenCandidateIds);
          if (captured instanceof Map) screenTailMap = captured;
        } catch {
          screenTailMap = new Map();
        }
        if (generation !== this._generation) return;
      }

      for (const { pane, pc, paneLabel, meta, processMatch, hookState, prevStatus, hintAgent, windowId } of pendingPanes) {
        const screenText = screenTailMap.get(pane.id) || '';
        const screenMatch = screenText ? detectAgentFromScreen(screenText, hintAgent) : null;

        const fused = fusePaneAgentStatus({
          pane: { id: pane.id, command: pc.command, title: pc.title || '', label: paneLabel, path: pc.path || '', windowId },
          hookState,
          processMatch,
          screenMatch,
          prevStatus,
          now: pollNow,
        });

        if (fused) {
          if (fused.status === 'done' && (this._ackedAtByPane.get(pane.id) || 0) >= (fused.updatedAt || 0)) {
            fused.unread = false;
          }
          if (fused.source !== 'hook' && fused.agentType) {
            const notice = this._maybeRecordAgentNotification(fused, prevStatus, meta);
            if (notice) addedNotifications.push(notice);
          }
          nextFusedPanes.set(pane.id, fused);
        }
      }

      for (const paneId of this._paneMeta.keys()) {
        if (!livePaneIds.has(paneId)) this._paneMeta.delete(paneId);
      }
      for (const paneId of this._ackedAtByPane.keys()) {
        if (!livePaneIds.has(paneId)) this._ackedAtByPane.delete(paneId);
      }
      this._agentEvents?.pruneMissingPanes?.(livePaneIds, { beforeTimestamp: pollStartedAt - 1000 });
      this._paneAgentStatuses = nextFusedPanes;
      this._lastSessions = snapshotSessions;

      this.broadcastNotifications(addedNotifications);

      // Strip internal _paneCommands before broadcasting status
      const sessionsForPayload = sessionsWithWindows.map(({ _paneCommands: _, ...rest }) => rest);
      const statusMessage = {
        type: 'status',
        data: { sessions: sessionsForPayload, totalSessions, totalWindows },
      };
      const serialized = JSON.stringify(statusMessage);
      if (serialized !== this.previousState) {
        this.previousState = serialized;
        this._broadcast(serialized);
      }

      this._publishAgentSnapshot(snapshotSessions, pollNow);
    } catch (err) {
      if (generation !== this._generation) return;
      const errorMessage = {
        type: 'error',
        data: { message: err.message },
      };
      this._broadcast(JSON.stringify(errorMessage));
    }
  }

  _maybeRecordAgentNotification(fused, prevStatus, meta) {
    if (!this._notificationStore && !this._agentEvents) return null;
    let state = null;
    let event = null;
    if (fused.status === 'permission' && prevStatus?.status !== 'permission') {
      state = 'waiting_attention';
      event = 'permission_wait';
    } else if (fused.status === 'failed' && prevStatus?.status !== 'failed') {
      state = 'failed';
      event = 'stop_failure';
    } else if (fused.status === 'done' && prevStatus && ACTIVE_STATES_BEFORE_DONE.has(prevStatus.status)) {
      state = 'agent_stopped';
      event = 'agent_stop';
    }
    if (!state) return null;

    const reason = fused.lastMessage || fused.prompt || (fused.label !== fused.command ? fused.label : '');
    if (this._agentEvents) {
      const result = this._agentEvents.ingest({
        source: fused.agentType,
        agent: fused.agentType,
        event,
        state,
        session: meta.sessionName,
        windowIndex: meta.windowIndex,
        windowId: meta.windowId,
        windowName: meta.windowName,
        paneId: fused.paneId,
        serverInstance: this._serverInstance || '',
        prevCommand: fused.command,
        reason,
      }, { notify: true });
      return result.notification;
    }

    return this._notificationStore.add({
      type: 'agent-event',
      state,
      source: fused.agentType,
      event,
      session: meta.sessionName,
      windowIndex: meta.windowIndex,
      windowId: meta.windowId,
      windowName: meta.windowName,
      prevCommand: fused.command,
      paneId: fused.paneId,
      serverInstance: this._serverInstance || '',
      reason,
    });
  }

  _publishAgentSnapshot(sessions, now) {
    const snapshot = buildAgentStatusSnapshot({
      sessions,
      fusedPanes: this._paneAgentStatuses,
      serverInstance: this._serverInstance || '',
      updatedAt: now,
    });
    this._agentSnapshot = snapshot;

    const sig = stableSnapshotSignature(snapshot);
    if (snapshot.hasAgents) {
      if (sig !== this._lastAgentSignature) {
        this._lastAgentSignature = sig;
        const msg = JSON.stringify({ type: 'agent-status', data: snapshot });
        this._lastAgentStatusSerialized = msg;
        this._hadAgentStatus = true;
        this._broadcast(msg);
      }
    } else if (this._hadAgentStatus) {
      this._hadAgentStatus = false;
      this._lastAgentSignature = null;
      this._lastAgentStatusSerialized = null;
      this._broadcast(JSON.stringify({ type: 'agent-status', data: snapshot }));
    }
  }

  _send(ws, serialized) {
    if (ws.readyState === 1) {
      ws.send(serialized);
    }
  }

  _broadcast(serialized) {
    for (const ws of this.subscribers) {
      if (ws.readyState > 1) {
        // CLOSING or CLOSED — remove stale subscriber
        this.subscribers.delete(ws);
        continue;
      }
      this._send(ws, serialized);
    }
  }
}
