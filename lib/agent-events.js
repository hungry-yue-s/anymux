import { normalizeAgentType } from './agent-status.js';

const DEFAULT_DEDUPE_MS = 10_000;
const DEDUPE_WINDOWS = Object.freeze({
  agent_stopped: 10_000,
  waiting_attention: 120_000,
  session_ended: 30_000,
  process_exited: 30_000,
  failed: 30_000,
});

const EVENT_STATE = Object.freeze({
  // Active working / realtime lifecycle hooks (update sidebar immediately, no persistent notice)
  SessionStart: 'agent_running',
  session_start: 'agent_running',
  UserPromptSubmit: 'agent_running',
  user_prompt_submit: 'agent_running',
  PreToolUse: 'agent_running',
  pre_tool_use: 'agent_running',
  PostToolUse: 'agent_running',
  post_tool_use: 'agent_running',
  PostToolUseFailure: 'agent_running',
  post_tool_use_failure: 'agent_running',
  ElicitationResult: 'agent_running',
  elicitation_result: 'agent_running',
  SubagentStart: 'agent_running',
  subagent_start: 'agent_running',
  agent_running: 'agent_running',
  working: 'agent_running',
  running: 'agent_running',
  SubagentStop: 'subagent_stopped',
  subagent_stop: 'subagent_stopped',

  // Persistent / attention-worthy events
  Stop: 'agent_stopped',
  agent_stop: 'agent_stopped',
  agent_stopped: 'agent_stopped',
  command_complete: 'agent_stopped',
  bell: 'agent_stopped',
  SessionEnd: 'session_ended',
  session_end: 'session_ended',
  session_ended: 'session_ended',
  PermissionRequest: 'waiting_attention',
  permission_wait: 'waiting_attention',
  waiting_attention: 'waiting_attention',
  Notification: 'waiting_attention',
  notification: 'waiting_attention',
  Elicitation: 'waiting_attention',
  elicitation: 'waiting_attention',
  StopFailure: 'failed',
  stop_failure: 'failed',
  failed: 'failed',
  process_exit: 'process_exited',
  process_exited: 'process_exited',
});

const STATE_PRIORITY = Object.freeze({
  session_ended: 50,
  failed: 40,
  waiting_attention: 30,
  agent_stopped: 20,
  process_exited: 10,
  agent_running: 5,
  subagent_stopped: 0,
});

export const NOTIFY_STATES = new Set([
  'waiting_attention',
  'failed',
  'agent_stopped',
  'session_ended',
  'process_exited',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function truncateText(text, max) {
  if (!text) return '';
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

function parseWindowIndex(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

export function normalizeAgentEvent(input) {
  const raw = asObject(input);
  const tmuxInfo = asObject(raw.tmux || raw.pane || raw.window);
  const hookEventName = firstString(raw.hook_event_name, raw.hookEventName);
  const event = firstString(raw.event, hookEventName, raw.type);
  const state = EVENT_STATE[event] || EVENT_STATE[hookEventName] || EVENT_STATE[firstString(raw.state)] || 'waiting_attention';
  const source = firstString(raw.agent, raw.source, raw.cli, 'agent');
  const agentType = normalizeAgentType(source) || '';
  const session = firstString(raw.session, raw.tmux_session, raw.tmuxSession, tmuxInfo.session, tmuxInfo.tmux_session);
  const windowId = firstString(raw.windowId, raw.window_id, tmuxInfo.windowId, tmuxInfo.window_id);
  const windowIndex = parseWindowIndex(raw.windowIndex ?? raw.window_index ?? tmuxInfo.windowIndex ?? tmuxInfo.window_index);
  const paneId = firstString(raw.paneId, raw.pane_id, tmuxInfo.paneId, tmuxInfo.pane_id);
  const sessionId = firstString(raw.session_id, raw.sessionId);
  const cwd = firstString(raw.cwd);
  const tty = firstString(raw.tty, raw.TTY);
  const command = firstString(raw.prevCommand, raw.command, raw.tool_name, raw.name);
  const reason = firstString(raw.reason, raw.stopReason, raw.message, raw.closeReason);
  const model = firstString(raw.model, raw.model_id, raw.modelId);
  const prompt = truncateText(firstString(raw.prompt, raw.user_prompt, raw.userPrompt, raw.title), 160);
  const toolName = firstString(raw.tool_name, raw.toolName);
  const lastMessage = truncateText(firstString(raw.last_assistant_message, raw.lastMessage, raw.reason, raw.message), 240);
  const agentId = firstString(raw.agent_id, raw.agentId, raw.subagent_id);
  const interrupted = Boolean(raw.interrupted || raw.stop_reason === 'interrupted' || raw.reason === 'interrupted');

  return {
    source,
    agentType,
    event: event || state,
    state,
    session,
    windowId,
    windowIndex,
    windowName: firstString(raw.windowName, raw.window_name, tmuxInfo.windowName, tmuxInfo.window_name),
    paneId,
    sessionId,
    cwd,
    tty,
    command,
    reason,
    model,
    prompt,
    toolName,
    lastMessage,
    agentId,
    interrupted,
    hookEventName,
    notificationType: firstString(raw.notificationType),
    priority: STATE_PRIORITY[state] || 0,
    timestamp: Date.now(),
  };
}

export function agentEventLocationKey(event) {
  return event.paneId || event.windowId || (
    event.session && event.windowIndex !== null ? `${event.session}:${event.windowIndex}` : ''
  ) || event.sessionId || event.tty || event.cwd || 'unknown';
}

export function agentEventDedupeKey(event) {
  return `${event.state}:${agentEventLocationKey(event)}`;
}

function serializePaneState(entry) {
  if (!entry) return null;
  return {
    paneId: entry.paneId,
    agentType: entry.agentType,
    source: entry.source,
    state: entry.state,
    status: entry.status,
    event: entry.event,
    model: entry.model,
    prompt: entry.prompt,
    toolName: entry.toolName,
    lastMessage: entry.lastMessage,
    subagentCount: entry.subagents.size,
    interrupted: entry.interrupted,
    session: entry.session,
    windowId: entry.windowId,
    windowIndex: entry.windowIndex,
    cwd: entry.cwd,
    updatedAt: entry.updatedAt,
  };
}

export class AgentEventService {
  constructor({ notificationStore = null, now = () => Date.now() } = {}) {
    this.notificationStore = notificationStore;
    this._now = now;
    this._seen = new Map();
    this._seenLocations = new Map();
    this._paneStates = new Map();
  }

  ingest(input, { notify = true } = {}) {
    const event = normalizeAgentEvent(input);
    const now = this._now();
    event.timestamp = now;

    if (event.paneId) {
      this._updatePaneState(event, now);
    }

    if (event.state === 'agent_running' && event.paneId && this.notificationStore?.markReadByPane) {
      this.notificationStore.markReadByPane(event.paneId);
    }

    if (!NOTIFY_STATES.has(event.state)) {
      return { event, duplicate: false, notification: null };
    }

    const key = agentEventDedupeKey(event);
    const locationKey = agentEventLocationKey(event);
    const ttl = DEDUPE_WINDOWS[event.state] || DEFAULT_DEDUPE_MS;
    this._prune(now);

    const previous = this._seen.get(key);
    if (previous && now - previous.timestamp < ttl) {
      previous.timestamp = now;
      previous.sources.add(event.source);
      previous.priority = Math.max(previous.priority, event.priority);
      this._seenLocations.set(locationKey, previous);
      return { event, duplicate: true, notification: null };
    }

    const previousLocation = this._seenLocations.get(locationKey);
    if (previousLocation && now - previousLocation.timestamp < ttl && previousLocation.priority >= event.priority) {
      previousLocation.timestamp = now;
      previousLocation.sources.add(event.source);
      return { event, duplicate: true, notification: null };
    }

    const seen = { timestamp: now, sources: new Set([event.source]), priority: event.priority };
    this._seen.set(key, seen);
    this._seenLocations.set(locationKey, seen);

    let notification = null;
    if (notify && this.notificationStore) {
      notification = this.notificationStore.add({
        type: event.notificationType || 'agent-event',
        state: event.state,
        source: event.source,
        event: event.event,
        session: event.session || event.sessionId || event.cwd || event.source,
        windowIndex: event.windowIndex ?? '',
        windowId: event.windowId,
        windowName: event.windowName,
        prevCommand: event.command,
        paneId: event.paneId,
        reason: event.reason || event.lastMessage,
      });
    }

    return { event, duplicate: false, notification };
  }

  getPaneState(paneId) {
    if (!paneId) return null;
    return serializePaneState(this._paneStates.get(paneId));
  }

  getPaneStates() {
    const result = {};
    for (const [paneId, entry] of this._paneStates.entries()) {
      result[paneId] = serializePaneState(entry);
    }
    return result;
  }

  clearPaneState(paneId) {
    if (!paneId) return false;
    return this._paneStates.delete(paneId);
  }

  pruneStaleStates(maxAgeMs = 3_600_000) {
    const now = this._now();
    for (const [paneId, entry] of this._paneStates.entries()) {
      if (now - entry.updatedAt > maxAgeMs) {
        this._paneStates.delete(paneId);
      }
    }
  }

  _updatePaneState(event, now) {
    const paneId = event.paneId;
    const prev = this._paneStates.get(paneId) || {
      paneId,
      agentType: '',
      source: '',
      state: '',
      status: 'idle',
      event: '',
      model: '',
      prompt: '',
      toolName: '',
      lastMessage: '',
      subagents: new Set(),
      interrupted: false,
      session: '',
      windowId: '',
      windowIndex: null,
      cwd: '',
      updatedAt: now,
    };

    const eventNameLower = String(event.event || '').toLowerCase();
    const isSubagentStart = eventNameLower === 'subagentstart' || eventNameLower === 'subagent_start';
    const isSubagentStop = eventNameLower === 'subagentstop' || eventNameLower === 'subagent_stop';
    const isPromptSubmit = eventNameLower === 'userpromptsubmit' || eventNameLower === 'user_prompt_submit';

    if (isSubagentStart) {
      prev.subagents.add(event.agentId || `sub-${now}-${prev.subagents.size + 1}`);
      prev.state = 'agent_running';
      prev.status = 'working';
    } else if (isSubagentStop) {
      if (event.agentId) {
        prev.subagents.delete(event.agentId);
      } else if (prev.subagents.size > 0) {
        const first = prev.subagents.values().next().value;
        prev.subagents.delete(first);
      }
      if (!prev.state || prev.state === 'subagent_stopped') {
        prev.state = 'agent_running';
        prev.status = 'working';
      }
    } else {
      prev.state = event.state;
      if (event.state === 'agent_running') prev.status = 'working';
      else if (event.state === 'waiting_attention') prev.status = 'permission';
      else if (event.state === 'failed') prev.status = 'failed';
      else if (event.state === 'agent_stopped') prev.status = event.interrupted ? 'interrupted' : 'done';
      else if (event.state === 'session_ended' || event.state === 'process_exited') {
        prev.status = 'session_ended';
        prev.subagents.clear();
      }

      if (event.state === 'agent_stopped' || event.state === 'failed') {
        prev.subagents.clear();
      }
    }

    if (event.agentType) prev.agentType = event.agentType;
    if (event.source && event.source !== 'agent') prev.source = event.source;
    else if (!prev.source && event.source) prev.source = event.source;
    prev.event = event.event;
    if (event.model) prev.model = event.model;
    if (isPromptSubmit && event.prompt) prev.prompt = event.prompt;
    else if (event.prompt && !prev.prompt) prev.prompt = event.prompt;
    if (event.toolName) prev.toolName = event.toolName;
    if (event.lastMessage) prev.lastMessage = event.lastMessage;
    prev.interrupted = Boolean(event.interrupted);
    if (event.session) prev.session = event.session;
    if (event.windowId) prev.windowId = event.windowId;
    if (event.windowIndex !== null && event.windowIndex !== undefined) prev.windowIndex = event.windowIndex;
    if (event.cwd) prev.cwd = event.cwd;
    prev.updatedAt = now;

    this._paneStates.set(paneId, prev);
  }

  _prune(now) {
    const maxTtl = Math.max(...Object.values(DEDUPE_WINDOWS), DEFAULT_DEDUPE_MS);
    for (const [key, value] of this._seen.entries()) {
      if (now - value.timestamp > maxTtl) this._seen.delete(key);
    }
    for (const [key, value] of this._seenLocations.entries()) {
      if (now - value.timestamp > maxTtl) this._seenLocations.delete(key);
    }
  }
}
