import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentEventService } from '../../lib/agent-events.js';
import { StatusMonitor } from '../../lib/monitor.js';

// Mock tmux module
vi.mock('../../lib/tmux.js', () => ({
  listSessions: vi.fn(),
  listWindows: vi.fn(),
  listPaneCommands: vi.fn(),
  ensurePaneBorderConfig: vi.fn(() => Promise.resolve()),
  ensureHyperlinkEnvironment: vi.fn(() => Promise.resolve()),
}));

// Import mocked module
const tmux = await import('../../lib/tmux.js');

function createMockWs(readyState = 1) {
  return {
    readyState,
    send: vi.fn(),
  };
}

describe('StatusMonitor', () => {
  let monitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new StatusMonitor();
    tmux.listSessions.mockReset();
    tmux.listWindows.mockReset();
    tmux.listPaneCommands.mockReset();
    tmux.ensurePaneBorderConfig.mockClear();
    tmux.ensureHyperlinkEnvironment.mockReset();
    tmux.ensureHyperlinkEnvironment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('subscribe / unsubscribe', () => {
    it('adds a WebSocket client to subscribers', () => {
      const ws = createMockWs();
      monitor.subscribe(ws);
      expect(monitor.subscribers.has(ws)).toBe(true);
    });

    it('removes a WebSocket client from subscribers', () => {
      const ws = createMockWs();
      monitor.subscribe(ws);
      monitor.unsubscribe(ws);
      expect(monitor.subscribers.has(ws)).toBe(false);
    });

    it('sends cached state immediately on subscribe if available', () => {
      const ws = createMockWs();
      const cachedState = JSON.stringify({ type: 'status', data: {} });
      monitor.previousState = cachedState;
      monitor.subscribe(ws);
      expect(ws.send).toHaveBeenCalledWith(cachedState);
    });

    it('does not send anything on subscribe if no previous state', () => {
      const ws = createMockWs();
      monitor.subscribe(ws);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not send to closed WebSocket on subscribe', () => {
      const ws = createMockWs(3); // CLOSED
      monitor.previousState = '{}';
      monitor.subscribe(ws);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('poll under a slow tmux', () => {
    const SESSION = { name: 'main', windows: 1, attached: true, lastActivity: '12345' };

    function slowRound() {
      let finish;
      tmux.listSessions.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);
      return (sessions = [SESSION]) => finish(sessions);
    }

    it('does not start a round while the last one is still running', async () => {
      const finish = slowRound();
      monitor.start(3000);
      await vi.advanceTimersByTimeAsync(30000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);

      finish();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(2);
    });

    it('lets callers wait for the round already running', async () => {
      const finish = slowRound();
      const first = monitor.poll();
      const second = monitor.poll();
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);
      finish();
      await Promise.all([first, second]);
    });

    it('keeps polling after a round fails', async () => {
      tmux.listSessions.mockRejectedValueOnce(new Error('tmux gone')).mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);
      await monitor.poll();
      await monitor.poll();
      expect(tmux.listSessions).toHaveBeenCalledTimes(2);
    });

    it('reports nothing from a round that outlives stop()', async () => {
      const finish = slowRound();
      const ws = createMockWs();
      monitor.subscribe(ws);
      const running = monitor.poll();
      monitor.stop();
      finish();
      await running;
      expect(ws.send).not.toHaveBeenCalled();
      expect(monitor.previousState).toBeNull();
    });

    it('reports no failure from a round that outlives stop() either', async () => {
      let fail;
      tmux.listSessions.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
      const ws = createMockWs();
      monitor.subscribe(ws);
      const running = monitor.poll();
      monitor.stop();
      fail(new Error('tmux gone'));
      await running;
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('can start again at once after stop(), with the old round still running', async () => {
      const finish = slowRound();
      const old = monitor.poll();
      monitor.stop();
      tmux.listSessions.mockResolvedValue([]);
      await monitor.poll();
      expect(tmux.listSessions).toHaveBeenCalledTimes(2);
      finish();
      await old;
    });
  });

  describe('poll', () => {
    it('fetches sessions and windows and broadcasts to subscribers', async () => {
      tmux.listSessions.mockResolvedValue([
        { name: 'main', windows: 2, attached: true, lastActivity: '12345' },
      ]);
      tmux.listWindows.mockResolvedValue([
        { id: '@1', index: 0, name: 'bash', active: true, width: 80, height: 24, bell: false, activity: 1700000000 },
        { id: '@2', index: 1, name: 'vim', active: false, width: 80, height: 24, bell: false, activity: 1700000000 },
      ]);
      tmux.listPaneCommands.mockResolvedValue([]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();

      expect(tmux.listSessions).toHaveBeenCalled();
      expect(tmux.listWindows).toHaveBeenCalledWith('main');
      expect(ws.send).toHaveBeenCalledTimes(1);

      const message = JSON.parse(ws.send.mock.calls[0][0]);
      expect(message.type).toBe('status');
      expect(message.data.totalSessions).toBe(1);
      expect(message.data.totalWindows).toBe(2);
      expect(message.data.sessions[0].name).toBe('main');
      expect(message.data.sessions[0].windowDetails).toHaveLength(2);
    });

    it('includes pane details (id, command, path) per window in status payload', async () => {
      tmux.listSessions.mockResolvedValue([
        { name: 'main', windows: 1, attached: true, lastActivity: '12345' },
      ]);
      tmux.listWindows.mockResolvedValue([
        { id: '@1', index: 0, name: 'bash', active: true, width: 80, height: 24, bell: false, activity: 1700000000 },
      ]);
      tmux.listPaneCommands.mockResolvedValue([
        { windowIndex: 0, paneId: '%1', command: 'vim', path: '/home/user/project', pid: 1234 },
        { windowIndex: 0, paneId: '%2', command: 'bash', path: '/home/user', pid: 1235 },
      ]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();

      const message = JSON.parse(ws.send.mock.calls[0][0]);
      const windowDetails = message.data.sessions[0].windowDetails;
      expect(windowDetails).toHaveLength(1);
      expect(windowDetails[0].panes).toEqual([
        { id: '%1', command: 'vim', path: '/home/user/project', ports: [] },
        { id: '%2', command: 'bash', path: '/home/user', ports: [] },
      ]);
    });

    it('does not expose internal _paneCommands in status payload', async () => {
      tmux.listSessions.mockResolvedValue([
        { name: 'main', windows: 1, attached: true, lastActivity: '12345' },
      ]);
      tmux.listWindows.mockResolvedValue([
        { id: '@1', index: 0, name: 'bash', active: true, width: 80, height: 24, bell: false, activity: 1700000000 },
      ]);
      tmux.listPaneCommands.mockResolvedValue([
        { windowIndex: 0, paneId: '%1', command: 'vim', path: '/home/user', pid: 1234 },
      ]);

      const ws = createMockWs();
      monitor.subscribe(ws);
      await monitor.poll();

      const message = JSON.parse(ws.send.mock.calls[0][0]);
      expect(message.data.sessions[0]._paneCommands).toBeUndefined();
    });

    it('does not broadcast when state has not changed', async () => {
      tmux.listSessions.mockResolvedValue([
        { name: 'main', windows: 1, attached: false, lastActivity: '0' },
      ]);
      tmux.listWindows.mockResolvedValue([
        { id: '@1', index: 0, name: 'bash', active: true, width: 80, height: 24, bell: false, activity: 1700000000 },
      ]);
      tmux.listPaneCommands.mockResolvedValue([]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();
      await monitor.poll();

      // Only one send (from first poll — second is skipped due to no change)
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('broadcasts error message when tmux call fails', async () => {
      tmux.listSessions.mockRejectedValue(new Error('tmux not found'));

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();

      expect(ws.send).toHaveBeenCalledTimes(1);
      const message = JSON.parse(ws.send.mock.calls[0][0]);
      expect(message.type).toBe('error');
      expect(message.data.message).toBe('tmux not found');
    });

    it('skips sending to closed WebSocket clients', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);

      const openWs = createMockWs(1);
      const closedWs = createMockWs(3);
      monitor.subscribe(openWs);
      monitor.subscribe(closedWs);

      await monitor.poll();

      expect(openWs.send).toHaveBeenCalledTimes(1);
      expect(closedWs.send).not.toHaveBeenCalled();
    });
  });

  describe('start / stop', () => {
    it('starts periodic polling', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);

      monitor.start(1000);

      // Immediate poll on start
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(3);
    });

    it('stops periodic polling', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);

      monitor.start(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);

      monitor.stop();

      await vi.advanceTimersByTimeAsync(3000);
      // No additional calls after stop
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);
    });

    it('restarts cleanly when start is called twice', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);

      monitor.start(1000);
      monitor.start(2000);

      expect(tmux.listSessions).toHaveBeenCalledTimes(2); // Two immediate polls

      await vi.advanceTimersByTimeAsync(2000);
      // Should use the second interval (2000ms), so one more poll
      expect(tmux.listSessions).toHaveBeenCalledTimes(3);
    });

    it('stop is safe to call when not started', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  describe('agent status & zero-config notifications', () => {
    const SESSION = [
      { name: 'main', windows: 1, attached: true, lastActivity: '12345' },
    ];

    function windowsWith(bell = false) {
      return [{ id: '@1', index: 0, name: 'dev', active: true, width: 80, height: 24, bell, activity: 1700000000 }];
    }

    function recordingStore() {
      return {
        notifications: [],
        markReadByPane: vi.fn(() => 0),
        add(entry) {
          const n = { id: String(this.notifications.length + 1), ...entry };
          this.notifications.push(n);
          return n;
        },
      };
    }

    async function pollWith(windows, paneCommands, session = SESSION) {
      tmux.listSessions.mockResolvedValue(session);
      tmux.listWindows.mockResolvedValue(windows);
      tmux.listPaneCommands.mockResolvedValue(paneCommands);
      await monitor.poll();
    }

    const sent = (ws, type) => ws.send.mock.calls.map((c) => JSON.parse(c[0])).filter((m) => m.type === type);

    it('removes ordinary command-completion and bell notifications (no noise on node->zsh or bell)', async () => {
      const store = recordingStore();
      monitor = new StatusMonitor({ notificationStore: store, scanProcesses: async () => new Map() });
      const ws = createMockWs();
      monitor.subscribe(ws);

      await pollWith(windowsWith(false), [{ windowIndex: 0, paneId: '%0', command: 'node', pid: 100 }]);
      ws.send.mockClear();
      await pollWith(windowsWith(true), [{ windowIndex: 0, paneId: '%0', command: 'zsh', pid: 100 }]);

      expect(store.notifications).toHaveLength(0);
      expect(sent(ws, 'notifications')).toHaveLength(0);
      expect(sent(ws, 'agent-status')).toHaveLength(0);
    });

    it('detects agents via process tree and title, broadcasts agent-status, and emits zero-config notifications on finish', async () => {
      const store = recordingStore();
      const agentEvents = new AgentEventService({ notificationStore: store });
      let procStdout = '  200 100 S+ claude --resume abc';
      const scanProcesses = vi.fn(async () => {
        const { parseProcessTable } = await import('../../lib/agent-status.js');
        return parseProcessTable(procStdout);
      });
      monitor = new StatusMonitor({ notificationStore: store, agentEvents, scanProcesses });
      const ws = createMockWs();
      monitor.subscribe(ws);

      // Poll 1: claude child under zsh with Braille spinner title -> working
      await pollWith(windowsWith(false), [{ windowIndex: 0, paneId: '%0', command: 'zsh', pid: 100, title: '⠋ Refactoring store' }]);
      const agentMsgs1 = sent(ws, 'agent-status');
      expect(agentMsgs1).toHaveLength(1);
      expect(agentMsgs1[0].data.panes['%0']).toMatchObject({
        agentType: 'claude',
        status: 'working',
        label: 'Refactoring store',
      });
      expect(agentMsgs1[0].data.windows['@1']).toMatchObject({ status: 'working', agentCount: 1 });
      expect(store.notifications).toHaveLength(0);

      // Poll 2: identical state -> no redundant agent-status broadcast
      ws.send.mockClear();
      await pollWith(windowsWith(false), [{ windowIndex: 0, paneId: '%0', command: 'zsh', pid: 100, title: '⠋ Refactoring store' }]);
      expect(sent(ws, 'agent-status')).toHaveLength(0);

      // Poll 3: spinner disappears while claude remains -> transitions to done + emits deduplicated notification
      procStdout = '  200 100 S+ claude --resume abc';
      await pollWith(windowsWith(false), [{ windowIndex: 0, paneId: '%0', command: 'zsh', pid: 100, title: 'Claude Code' }]);
      expect(sent(ws, 'agent-status')[0].data.panes['%0']).toMatchObject({ status: 'done', unread: true });
      expect(store.notifications).toHaveLength(1);
      expect(store.notifications[0]).toMatchObject({ source: 'claude', state: 'agent_stopped', paneId: '%0' });
      expect(sent(ws, 'notifications')).toHaveLength(1);
    });

    it('emits immediate agent-status updates on hook events and supports acknowledgePane', async () => {
      const store = recordingStore();
      const agentEvents = new AgentEventService({ notificationStore: store });
      monitor = new StatusMonitor({ notificationStore: store, agentEvents, scanProcesses: async () => new Map() });
      const ws = createMockWs();
      monitor.subscribe(ws);

      const res = agentEvents.ingest({
        agent: 'codex',
        event: 'UserPromptSubmit',
        session: 'main',
        windowIndex: 0,
        windowId: '@1',
        paneId: '%5',
        model: 'gpt-5.3-codex',
        prompt: 'Write integration tests',
      });
      monitor.handleAgentEvent(res.event);

      const msgs = sent(ws, 'agent-status');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].data.panes['%5']).toMatchObject({
        agentType: 'codex',
        status: 'working',
        shortModel: 'gpt-5.3',
        prompt: 'Write integration tests',
      });

      const stop = agentEvents.ingest({ agent: 'codex', event: 'Stop', session: 'main', windowIndex: 0, windowId: '@1', paneId: '%5' });
      monitor.handleAgentEvent(stop.event);
      expect(monitor.getAgentStatus().panes['%5']).toMatchObject({ status: 'done', unread: true });

      ws.send.mockClear();
      const changed = monitor.acknowledgePane({ paneId: '%5' });
      expect(changed).toBe(true);
      expect(monitor.getAgentStatus().panes['%5'].unread).toBe(false);
      expect(store.markReadByPane).toHaveBeenCalledWith('%5');
      expect(sent(ws, 'agent-status')).toHaveLength(1);
    });

    it('detects non-spinning agents (agy) via capturePaneTails, propagates pane label, and notifies on idle transition', async () => {
      const store = recordingStore();
      const agentEvents = new AgentEventService({ notificationStore: store });
      let screenText = '⣽ Working...\n>\nesc to cancel · Orchestrator · Gemini 4 Neon · xhigh';
      const capturePaneTails = vi.fn(async (ids) => new Map(ids.map((id) => [id, screenText])));
      monitor = new StatusMonitor({
        notificationStore: store,
        agentEvents,
        scanProcesses: async () => new Map(),
        capturePaneTails,
      });
      const ws = createMockWs();
      monitor.subscribe(ws);

      await pollWith(windowsWith(false), [
        { windowIndex: 0, paneId: '%2', command: 'agy', pid: 500, title: 'agy ~/w/d/windows', label: '自更新' },
      ]);
      expect(capturePaneTails).toHaveBeenCalledWith(['%2']);
      const msgs1 = sent(ws, 'agent-status');
      expect(msgs1[0].data.panes['%2']).toMatchObject({
        agentType: 'antigravity',
        status: 'working',
        label: '自更新',
        model: 'Gemini 4 Neon',
      });

      screenText = 'Summary complete\n>\n? for shortcuts · Orchestrator · Gemini 4 Neon · xhigh';
      ws.send.mockClear();
      await pollWith(windowsWith(false), [
        { windowIndex: 0, paneId: '%2', command: 'agy', pid: 500, title: 'agy ~/w/d/windows', label: '自更新' },
      ]);
      expect(sent(ws, 'agent-status')[0].data.panes['%2']).toMatchObject({ status: 'done', unread: true, label: '自更新' });
      expect(store.notifications).toHaveLength(1);
      expect(store.notifications[0]).toMatchObject({ source: 'antigravity', state: 'agent_stopped', paneId: '%2' });
    });

    it('purges stale pane hooks, statuses, and triggers onServerRestart when tmux serverInstance changes', async () => {
      let now = 1_700_000_100_000;
      vi.setSystemTime(now);
      const store = recordingStore();
      const agentEvents = new AgentEventService({ notificationStore: store, now: () => now });
      const onServerRestart = vi.fn();
      const onServerInstance = vi.fn();
      const snapshotServerState = vi.fn();
      monitor = new StatusMonitor({
        notificationStore: store,
        agentEvents,
        scanProcesses: async () => new Map(),
        snapshotServerState,
        onServerRestart,
        onServerInstance,
      });

      const snapServer = (instance, windows, panes) => ({
        serverInstance: instance,
        sessions: [{ id: '$1', name: 'work', windows: windows.length, attached: true, lastActivity: '1' }],
        windowsBySession: new Map([['$1', windows]]),
        paneCommandsBySession: new Map([['$1', panes]]),
      });

      // Server 1000: %11 & %12 are agy panes (working and done)
      snapshotServerState.mockResolvedValue(snapServer(
        '1000:1700000000',
        [{ id: '@5', index: 0, name: 'tmux panel', active: true, width: 80, height: 24, bell: false, activity: 1 }],
        [
          { windowIndex: 0, paneId: '%11', command: 'agy', path: '/repo/panel', pid: 1011, title: 'agy' },
          { windowIndex: 0, paneId: '%12', command: 'agy', path: '/repo/panel', pid: 1012, title: 'agy' },
        ],
      ));
      agentEvents.ingest({ agent: 'antigravity', event: 'PreInvocation', paneId: '%11', tmuxServerPid: '1000', prompt: '要' });
      agentEvents.ingest({ agent: 'antigravity', event: 'Stop', paneId: '%12', tmuxServerPid: '1000', prompt: '再看一下现在的情况' });

      await monitor.poll();
      expect(onServerInstance).toHaveBeenCalledWith('1000:1700000000');
      expect(monitor.getAgentStatus().serverInstance).toBe('1000:1700000000');
      expect(monitor.getAgentStatus().panes['%11']).toMatchObject({ status: 'working', label: '要' });
      expect(monitor.getAgentStatus().panes['%12']).toMatchObject({ status: 'done', label: '再看一下现在的情况' });

      // Tmux server restarts (PID 2000 at t=1_700_000_500s): %11 and %12 are reassigned to fish in window dsh
      now = 1_700_000_505_000;
      vi.setSystemTime(now);
      store.notifications = [];
      snapshotServerState.mockResolvedValue(snapServer(
        '2000:1700000500',
        [{ id: '@6', index: 1, name: 'dsh', active: true, width: 80, height: 24, bell: false, activity: 2 }],
        [
          { windowIndex: 1, paneId: '%11', command: 'fish', path: '/Users/me', pid: 2011, title: '~' },
          { windowIndex: 1, paneId: '%12', command: 'fish', path: '/Users/me', pid: 2012, title: '~' },
        ],
      ));

      await monitor.poll();
      expect(onServerInstance).toHaveBeenLastCalledWith('2000:1700000500');
      expect(onServerRestart).toHaveBeenCalledWith({
        prevInstance: '1000:1700000000',
        nextInstance: '2000:1700000500',
      });
      expect(tmux.ensurePaneBorderConfig).toHaveBeenCalledTimes(2);
      expect(monitor.getAgentStatus().serverInstance).toBe('2000:1700000500');
      expect(monitor.getAgentStatus().panes).toEqual({});
      expect(monitor.getAgentStatus().hasAgents).toBe(false);
      expect(agentEvents.getPaneState('%11')).toBeNull();
      expect(agentEvents.getPaneState('%12')).toBeNull();
      expect(store.notifications).toHaveLength(0);
    });

    it('clears closed panes, clears respawned pane pid changes, and ignores hooks from old tmuxServerPid', async () => {
      let now = 1_700_000_100_000;
      vi.setSystemTime(now);
      const agentEvents = new AgentEventService({ now: () => now });
      const snapshotServerState = vi.fn();
      monitor = new StatusMonitor({
        agentEvents,
        scanProcesses: async () => new Map(),
        snapshotServerState,
      });

      const snapServer = (instance, panes) => ({
        serverInstance: instance,
        sessions: [{ id: '$1', name: 'work', windows: 1, attached: true, lastActivity: '1' }],
        windowsBySession: new Map([['$1', [{ id: '@5', index: 0, name: 'panel', active: true, width: 80, height: 24, bell: false, activity: 1 }]]]),
        paneCommandsBySession: new Map([['$1', panes]]),
      });

      snapshotServerState.mockResolvedValue(snapServer('2000:1700000000', [
        { windowIndex: 0, paneId: '%5', command: 'agy', path: '/repo', pid: 500, title: 'agy' },
        { windowIndex: 0, paneId: '%6', command: 'agy', path: '/repo', pid: 600, title: 'agy' },
      ]));
      agentEvents.ingest({ agent: 'antigravity', event: 'Stop', paneId: '%5', tmuxServerPid: '2000', prompt: 'first' });
      agentEvents.ingest({ agent: 'antigravity', event: 'Stop', paneId: '%6', tmuxServerPid: '2000', prompt: 'closing' });
      await monitor.poll();
      expect(monitor.getAgentStatus().panes['%5']).toBeDefined();
      expect(monitor.getAgentStatus().panes['%6']).toBeDefined();

      // Hook arriving with stale tmuxServerPid 1000 is ignored in fast path
      monitor.handleAgentEvent({
        paneId: '%5',
        agentType: 'antigravity',
        state: 'agent_running',
        tmuxServerPid: '1000',
        prompt: 'stale pid event',
      });
      await monitor.poll();
      expect(monitor.getAgentStatus().panes['%5'].prompt).toBe('first');

      // %5 respawns with new pid 999 as fish, and %6 closes
      now += 5000;
      vi.setSystemTime(now);
      snapshotServerState.mockResolvedValue(snapServer('2000:1700000000', [
        { windowIndex: 0, paneId: '%5', command: 'fish', path: '/repo', pid: 999, title: '~' },
      ]));
      await monitor.poll();
      expect(monitor.getAgentStatus().panes['%5']).toBeUndefined();
      expect(agentEvents.getPaneState('%5')).toBeNull();
      expect(agentEvents.getPaneState('%6')).toBeNull();
    });

    it('does not broadcast when plain shell stays idle', async () => {
      monitor = new StatusMonitor({ scanProcesses: async () => new Map() });
      const ws = createMockWs();
      monitor.subscribe(ws);

      await pollWith(windowsWith(false), [{ windowIndex: 0, paneId: '%0', command: 'zsh', pid: 100 }]);
      ws.send.mockClear();
      await pollWith(windowsWith(false), [{ windowIndex: 0, paneId: '%0', command: 'zsh', pid: 100 }]);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('isolates pane command errors per session', async () => {
      const ws = createMockWs();
      monitor.subscribe(ws);

      const twoSessions = [
        { name: 'good', windows: 1, attached: true, lastActivity: '1' },
        { name: 'bad', windows: 1, attached: true, lastActivity: '2' },
      ];

      tmux.listSessions.mockResolvedValue(twoSessions);
      tmux.listWindows.mockResolvedValue(windowsWith(false));
      tmux.listPaneCommands.mockImplementation((session) => {
        if (session === 'bad') return Promise.reject(new Error('fail'));
        return Promise.resolve(paneCommandsWith('zsh'));
      });

      await monitor.poll();

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(msg.type).toBe('status');
      // The broadcast still happens (not an error)
      expect(msg.data.sessions).toHaveLength(2);
    });
  });

  describe('pane-cmd broadcasts', () => {
    it('broadcasts pane-cmd when pane command changes', async () => {
      tmux.listSessions.mockResolvedValue([{ name: 'main', windows: 1 }]);
      tmux.listWindows.mockResolvedValue([{ id: '@1', index: 0, name: 'bash', active: true, bell: false, activity: 1700000000 }]);
      tmux.listPaneCommands.mockResolvedValue([
        { windowIndex: 0, paneId: '%0', command: 'bash', path: '/', pid: 111 },
      ]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      // First poll — establishes baseline
      await monitor.poll();

      // Change the pane command from bash to claude
      tmux.listPaneCommands.mockResolvedValue([
        { windowIndex: 0, paneId: '%0', command: 'claude', path: '/', pid: 222 },
      ]);

      // Second poll — should detect change
      await monitor.poll();

      const paneCmdMsgs = ws.send.mock.calls
        .map(c => JSON.parse(c[0]))
        .filter(m => m.type === 'pane-cmd');
      expect(paneCmdMsgs.length).toBe(1);
      expect(paneCmdMsgs[0].paneId).toBe('%0');
      expect(paneCmdMsgs[0].cmd).toBe('claude');
    });

    it('does not broadcast when command stays the same', async () => {
      tmux.listSessions.mockResolvedValue([{ name: 'main', windows: 1 }]);
      tmux.listWindows.mockResolvedValue([{ id: '@1', index: 0, name: 'bash', active: true, bell: false, activity: 1700000000 }]);
      tmux.listPaneCommands.mockResolvedValue([
        { windowIndex: 0, paneId: '%0', command: 'bash', path: '/', pid: 111 },
      ]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();
      ws.send.mockClear();

      // Same command on second poll
      await monitor.poll();

      const paneCmdMsgs = ws.send.mock.calls
        .map(c => JSON.parse(c[0]))
        .filter(m => m.type === 'pane-cmd');
      expect(paneCmdMsgs.length).toBe(0);
    });
  });

  describe('pane-border config ensure', () => {
    it('ensures once while sessions persist, re-arms after empty', async () => {
      const sess = [{ name: 'main', windows: 1, attached: true, lastActivity: '0' }];
      tmux.listSessions.mockResolvedValue(sess);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);

      await monitor.poll();
      await monitor.poll();
      expect(tmux.ensurePaneBorderConfig).toHaveBeenCalledTimes(1);

      tmux.listSessions.mockResolvedValue([]);
      await monitor.poll();
      tmux.listSessions.mockResolvedValue(sess);
      await monitor.poll();
      expect(tmux.ensurePaneBorderConfig).toHaveBeenCalledTimes(2);
    });

    it('retries on the next poll when a previous ensure failed', async () => {
      const sess = [{ name: 'main', windows: 1, attached: true, lastActivity: '0' }];
      tmux.listSessions.mockResolvedValue(sess);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);
      tmux.ensurePaneBorderConfig
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(undefined);

      await monitor.poll();         // attempt 1 fails -> flag must reset
      await Promise.resolve();      // let the rejection's .catch run
      await monitor.poll();         // attempt 2 (retry)
      expect(tmux.ensurePaneBorderConfig).toHaveBeenCalledTimes(2);
    });

    it('sets the hyperlink environment at the same moments, and a refusal costs nothing else', async () => {
      const sess = [{ name: 'main', windows: 1, attached: true, lastActivity: '0' }];
      tmux.listSessions.mockResolvedValue(sess);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);
      tmux.ensureHyperlinkEnvironment.mockRejectedValueOnce(new Error('old tmux'));
      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();
      await Promise.resolve();
      await monitor.poll();
      // Once per server, like the border; its failure is not the border's to retry.
      expect(tmux.ensureHyperlinkEnvironment).toHaveBeenCalledTimes(1);
      expect(tmux.ensurePaneBorderConfig).toHaveBeenCalledTimes(1);
      expect(JSON.parse(ws.send.mock.calls[0][0]).type).toBe('status');

      tmux.listSessions.mockResolvedValue([]);
      await monitor.poll();
      tmux.listSessions.mockResolvedValue(sess);
      await monitor.poll();
      expect(tmux.ensureHyperlinkEnvironment).toHaveBeenCalledTimes(2);
    });
  });
});
