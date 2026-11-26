import * as tmux from './tmux.js';
import { scanPorts } from './ports.js';
import {
  scanProcessTable,
  resolvePaneAgentFromProcesses,
  fusePaneAgentStatus,
  buildAgentStatusSnapshot,
} from './agent-status.js';

const PORT_CACHE_TTL_MS = 10_000;
const ACTIVE_STATES_BEFORE_DONE = new Set(['working', 'permission', 'monitoring']);

function stableSnapshotSignature(snapshot) {
  return JSON.stringify({
    hasAgents: snapshot.hasAgents,
    panes: snapshot.panes,
    windows: snapshot.windows,
    sessions: snapshot.sessions,
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
    this._borderConfigEnsured = false;
    /** serverId -> latest health status, replayed to new subscribers. */
    this._serverStatuses = new Map();
    this._polling = null;
    this._generation = 0;

    // Agent lifecycle & Orca-style fused sidebar status
    this._paneAgentStatuses = new Map(); // paneId -> fused status object
    this._paneMeta = new Map(); // paneId -> { sessionId, sessionName, windowId, windowIndex, windowName, command, title }
    this._lastSessions = [];
    this._ackedAtByPane = new Map(); // paneId -> timestamp
    this._agentSnapshot = { hasAgents: false, updatedAt: 0, panes: {}, windows: {}, sessions: {} };
    this._lastAgentSignature = null;
    this._lastAgentStatusSerialized = null;
    this._hadAgentStatus = false;
  }

  /**
   * Notices go to this store from now on; the returned
   * function stops that (both may come and go while the monitor runs).
   */
  useNotificationStore(store) {
    this._notificationStore = store;
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

  /** Fast-path update triggered immediately when an Agent Hook arrives over HTTP. */
  handleAgentEvent(ev) {
    if (!ev || !ev.paneId) return;
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
      pane: { id: paneId, command: meta.command || ev.command || '', title: meta.title || '' },
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
    try {
      const sessions = await tmux.listSessions();

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
          const windows = await tmux.listWindows(session.name);
          let paneCommands = [];
          try {
            paneCommands = await tmux.listPaneCommands(session.name);
          } catch {
            // Ignore — pane command fetch failure should not abort status
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

      for (const session of sessionsWithWindows) {
        const paneCommands = session._paneCommands || [];
        const pcByPane = new Map(paneCommands.map((pc) => [pc.paneId, pc]));

        for (const w of session.windowDetails) {
          for (const pane of w.panes) {
            const pc = pcByPane.get(pane.id) || { paneId: pane.id, command: pane.command, path: pane.path, pid: 0, title: '' };
            const meta = {
              sessionId: session.id || session.name,
              sessionName: session.name,
              windowId: w.id,
              windowIndex: w.index,
              windowName: w.name || '',
              command: pc.command || '',
              title: pc.title || '',
            };
            this._paneMeta.set(pane.id, meta);

            const processMatch = pc.pid > 0 ? resolvePaneAgentFromProcesses(pc.pid, processMap) : null;
            const hookState = this._agentEvents?.getPaneState?.(pane.id) || null;
            const prevStatus = this._paneAgentStatuses.get(pane.id) || null;

            const fused = fusePaneAgentStatus({
              pane: { id: pane.id, command: pc.command, title: pc.title || '' },
              hookState,
              processMatch,
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
        }

        snapshotSessions.push({
          id: session.id || session.name,
          name: session.name,
          windows: session.windowDetails,
        });
      }

      for (const paneId of this._paneMeta.keys()) {
        if (!livePaneIds.has(paneId)) this._paneMeta.delete(paneId);
      }
      for (const paneId of this._ackedAtByPane.keys()) {
        if (!livePaneIds.has(paneId)) this._ackedAtByPane.delete(paneId);
      }
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
      reason,
    });
  }

  _publishAgentSnapshot(sessions, now) {
    const snapshot = buildAgentStatusSnapshot({
      sessions,
      fusedPanes: this._paneAgentStatuses,
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
