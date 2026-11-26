/** Shared, server-instance scoped control clients. They never detach legacy clients. */
import { ControlProcess } from './control-process.js';
import { tmuxEnv, tmuxServerArgs } from '../tmux-server.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_DIMENSION, MAX_INPUT_BYTES } from './protocol.js';
import { parseTmuxLayout } from './tmux-layout.js';
import { createBinaryOutputBatcher, compactNativeSnapshot, encodeOutputFrame, encodeSnapshotFrame, parsePaneNum } from './window-protocol.js';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SUBSCRIBERS = 5;
const FIELD_SEP = '=:=';
const INPUT_CHUNK_BYTES = 4096;
const PAUSE_RECOVER_DELAY_MS = 150;
const fail = (code, message) => new AppError(ErrorCode[code], message);

export function validateControlTarget(target) {
  if (!target || !/^\d+:\d+$/.test(target.instanceId) || !/^\$\d+$/.test(target.sessionId)
    || !/^@\d+$/.test(target.windowId) || !/^%\d+$/.test(target.paneId)) throw fail('VALIDATION_ERROR', 'Invalid pane identity');
  return target;
}
export function validateWindowTarget(target) {
  if (!target || !/^\d+:\d+$/.test(target.instanceId) || !/^\$\d+$/.test(target.sessionId)
    || !/^@\d+$/.test(target.windowId)) throw fail('VALIDATION_ERROR', 'Invalid window identity');
  return target;
}
export function validControlSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= MAX_DIMENSION && rows <= MAX_DIMENSION;
}

function splitTaggedFields(line, count, textIndex) {
  const parts = line.split(FIELD_SEP);
  if (parts.length <= count) return parts;
  const trailing = count - textIndex - 1;
  return [
    ...parts.slice(0, textIndex),
    parts.slice(textIndex, parts.length - trailing).join(FIELD_SEP),
    ...parts.slice(parts.length - trailing),
  ];
}

export function decodeSnapshot(value) {
  let snapshot;
  try { snapshot = JSON.parse(value.toString('utf8')); } catch { throw fail('UNSUPPORTED', 'A native pane snapshot is required'); }
  snapshot.dataBase64 ??= snapshot.data;
  if (snapshot.version !== 1 || !validControlSize(snapshot.cols, snapshot.rows) || typeof snapshot.dataBase64 !== 'string'
    || snapshot.dataBase64.length > MAX_SNAPSHOT_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(snapshot.dataBase64)) {
    throw fail('UNSUPPORTED', 'Unsupported native pane snapshot');
  }
  return snapshot;
}

function layoutFramePayload(state) {
  return {
    type: 'layout',
    windowId: state.windowId,
    windowCols: state.windowCols,
    windowRows: state.windowRows,
    zoomed: state.zoomed,
    activePaneId: state.activePaneId,
    layoutString: state.layoutString,
    tree: state.tree,
    panes: state.panes,
  };
}

export class ControlPool {
  constructor({ tmux, workspace, createControl = options => new ControlProcess(options), snapshotCommand = paneId => `capture-pane -Q -p -t ${paneId}`, idleMs = 30_000, maxSessions = 32, args = tmuxServerArgs(), env = tmuxEnv(), getOwnedClientPids = () => [], pauseAfterSec = 5, outputBatchMs = 4, initialSnapshotHistoryLines = 200, resizeSnapshotHistoryLines = 80 }) {
    this.tmux = tmux;
    this.workspace = workspace;
    this.createControl = createControl;
    this.snapshotCommand = snapshotCommand;
    this.idleMs = idleMs;
    this.maxSessions = maxSessions;
    this.serverArgs = [...args];
    this.env = { ...env };
    this.getOwnedClientPids = getOwnedClientPids;
    this.pauseAfterSec = pauseAfterSec;
    this.outputBatchMs = outputBatchMs;
    this.initialSnapshotHistoryLines = initialSnapshotHistoryLines;
    this.resizeSnapshotHistoryLines = resizeSnapshotHistoryLines;
    this.socketIdentity = JSON.stringify(this.serverArgs);
    this.entries = new Map();
    this.order = 0;
    this.closed = false;
  }

  async capability() {
    try {
      const version = String(await this.tmux.run(['display-message', '-p', '#{pane_snapshot_version}'])).trim();
      return { available: version === '1' && !this.closed, protocol: 1, snapshotVersion: version === '1' ? 1 : null,
        ...(version === '1' ? {} : { reason: 'native_snapshot_required' }) };
    } catch { return { available: false, protocol: 1, snapshotVersion: null, reason: 'tmux_unavailable' }; }
  }

  async richPaneCapability() {
    try {
      const version = String(await this.tmux.run(['display-message', '-p', '#{rich_pane_version}'])).trim();
      return { available: version === '1' && !this.closed, version: version === '1' ? 1 : null };
    } catch { return { available: false, version: null }; }
  }

  async windowStreamCapability() {
    const cap = await this.capability();
    const rich = cap.available ? await this.richPaneCapability().catch(() => ({ available: false })) : { available: false };
    return { ...cap, binary: true, richPane: Boolean(rich.available) };
  }

  async resolve(target) {
    validateControlTarget(target);
    const resolved = await this.workspace.resolvePane(target.paneId);
    if (resolved.windowId !== target.windowId) throw fail('PANE_NOT_FOUND', 'The pane moved to a different window');
    // One invocation binds the tree and server lifetime. The explicit session/window
    // target also supports windows linked into more than one session.
    const output = String(await this.tmux.run(['list-panes', '-t', `${target.sessionId}:${target.windowId}`, '-F',
      '#{pid}:#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{window_panes}|#{window_linked}|#{window_width}|#{window_height}']));
    const row = output.trim().split('\n').map(line => line.split('|')).find(fields => fields[3] === target.paneId);
    if (!row || row[1] !== target.sessionId || row[2] !== target.windowId) throw fail('PANE_NOT_FOUND', 'The pane no longer belongs to this session');
    if (row[0] !== target.instanceId) throw fail('WORKSPACE_UNAVAILABLE', 'The tmux server changed; refresh the workspace');
    if (row[7] !== '0') throw fail('UNSUPPORTED', 'Linked tmux windows use the compatible terminal view');
    const cols = Number(row[4]), rows = Number(row[5]);
    if (!validControlSize(cols, rows)) throw fail('WORKSPACE_UNAVAILABLE', 'The pane grid is unavailable');
    const windowCols = Number(row[8]), windowRows = Number(row[9]);
    if (!Number.isInteger(windowCols) || !Number.isInteger(windowRows) || windowCols < cols || windowRows < rows) throw fail('WORKSPACE_UNAVAILABLE', 'The window grid is unavailable');
    return { ...target, cols, rows, windowCols, windowRows, singlePane: row[6] === '1' };
  }

  async resolveWindow(target) {
    validateWindowTarget(target);
    const paneFmt = [
      'P',
      '#{pid}:#{start_time}', '#{session_id}', '#{window_id}', '#{window_linked}',
      '#{window_width}', '#{window_height}', '#{window_zoomed_flag}', '#{window_layout}',
      '#{pane_id}', '#{pane_index}', '#{pane_left}', '#{pane_top}', '#{pane_width}', '#{pane_height}',
      '#{pane_active}', '#{pane_current_command}', '#{@pane_label}',
    ].join(FIELD_SEP);
    const cwdFmt = ['D', '#{pane_id}', '#{pane_current_path}'].join(FIELD_SEP);
    const kindFmt = ['K', '#{pane_id}', '#{@pane_kind}', '#{@pane_payload}'].join(FIELD_SEP);
    let output;
    try {
      output = String(await this.tmux.run([
        'list-panes', '-t', `${target.sessionId}:${target.windowId}`, '-F', paneFmt,
        ';',
        'list-panes', '-t', `${target.sessionId}:${target.windowId}`, '-F', cwdFmt,
        ';',
        'list-panes', '-t', `${target.sessionId}:${target.windowId}`, '-F', kindFmt,
      ]));
    } catch (error) {
      if (error instanceof AppError) throw error;
      const stderr = String(error?.stderr || error?.message || '');
      if (/can'?t find (?:session|window|pane)|no such|session not found/i.test(stderr)) {
        throw fail('WINDOW_NOT_FOUND', 'The window no longer exists; refresh the workspace');
      }
      throw error;
    }

    const cwdByPane = new Map();
    const richByPane = new Map();
    const rows = [];
    for (const line of output.split('\n')) {
      if (!line) continue;
      if (line.startsWith(`D${FIELD_SEP}`)) {
        const rest = line.slice(1 + FIELD_SEP.length);
        const cut = rest.indexOf(FIELD_SEP);
        if (cut !== -1) cwdByPane.set(rest.slice(0, cut), rest.slice(cut + FIELD_SEP.length));
        continue;
      }
      if (line.startsWith(`K${FIELD_SEP}`)) {
        const rest = line.slice(1 + FIELD_SEP.length);
        const cut = rest.indexOf(FIELD_SEP);
        if (cut !== -1) {
          const id = rest.slice(0, cut);
          const body = rest.slice(cut + FIELD_SEP.length);
          const kCut = body.indexOf(FIELD_SEP);
          if (kCut !== -1) {
            const kind = body.slice(0, kCut);
            const payload = body.slice(kCut + FIELD_SEP.length);
            richByPane.set(id, { kind: kind || 'terminal', payload: kind && kind !== 'terminal' ? payload : '' });
          }
        }
        continue;
      }
      const fields = splitTaggedFields(line.startsWith(`P${FIELD_SEP}`) ? line.slice(1 + FIELD_SEP.length) : line, 17, 15);
      if (fields.length >= 17) rows.push(fields);
    }

    const matching = rows.filter(fields => fields[1] === target.sessionId && fields[2] === target.windowId);
    if (!matching.length) throw fail('WINDOW_NOT_FOUND', 'The window no longer belongs to this session');
    const first = matching[0];
    if (first[0] !== target.instanceId) throw fail('WORKSPACE_UNAVAILABLE', 'The tmux server changed; refresh the workspace');
    if (first[3] !== '0') throw fail('UNSUPPORTED', 'Linked tmux windows use the compatible terminal view');
    const windowCols = Number(first[4]), windowRows = Number(first[5]);
    if (!validControlSize(windowCols, windowRows)) throw fail('WORKSPACE_UNAVAILABLE', 'The window grid is unavailable');
    const zoomed = first[6] === '1';
    const layoutString = first[7] || '';
    const panes = matching.map(fields => {
      const width = Number(fields[12]), height = Number(fields[13]);
      const x = Number(fields[10]), y = Number(fields[11]), index = Number(fields[9]);
      if (!validControlSize(width, height) || !Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 0) {
        throw fail('WORKSPACE_UNAVAILABLE', 'The pane grid is unavailable');
      }
      const id = fields[8];
      const rich = richByPane.get(id);
      return {
        id,
        index: Number.isInteger(index) ? index : 0,
        x,
        y,
        width,
        height,
        active: fields[14] === '1',
        command: fields[15] || '',
        label: fields[16] || '',
        cwd: cwdByPane.get(id) || '',
        kind: rich?.kind || 'terminal',
        payload: rich?.payload || '',
      };
    }).sort((a, b) => a.index - b.index);

    const activePaneId = (panes.find(pane => pane.active) || panes[0]).id;
    return {
      instanceId: target.instanceId,
      sessionId: target.sessionId,
      windowId: target.windowId,
      windowCols,
      windowRows,
      zoomed,
      layoutString,
      tree: parseTmuxLayout(layoutString),
      activePaneId,
      panes,
    };
  }

  async _entry(target) {
    if (this.closed) throw fail('WORKSPACE_UNAVAILABLE', 'The terminal service is stopping');
    const key = `${this.socketIdentity}|${target.instanceId}|${target.sessionId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxSessions) throw fail('CONNECTION_LIMIT', 'Too many active terminal sessions');
      const control = this.createControl({ sessionId: target.sessionId, args: this.serverArgs, env: this.env });
      entry = { key, sessionId: target.sessionId, control, sources: new Map(), windowSources: new Map(), timer: null, closed: false, pauseAfterEnabled: false };
      this.entries.set(key, entry);
      control.on('output', (paneId, bytes) => {
        const source = entry.sources.get(paneId);
        if (source?.synced) this._broadcast(source, { type: 'output', encoding: 'base64', data: bytes.toString('base64') });
        for (const ws of entry.windowSources.values()) {
          if (ws.paneStates.has(paneId)) ws.batcher.push(paneId, bytes);
        }
      });
      control.on('pause', paneId => {
        for (const ws of entry.windowSources.values()) {
          if (ws.paneStates.has(paneId)) this._schedulePauseRecovery(entry, ws, paneId);
        }
      });
      control.on('closed', () => {
        entry.closed = true;
        clearTimeout(entry.timer);
        this.entries.delete(key);
        for (const source of entry.sources.values()) {
          for (const subscriber of [...source.subscribers]) {
            this._send(subscriber, { type: 'error', code: 'WORKSPACE_UNAVAILABLE', message: 'The pane stream ended; reconnect to resynchronize', retryable: true });
            subscriber.end?.(1011, 'stream ended');
            subscriber.closed = true;
          }
        }
        entry.sources.clear();
        for (const ws of entry.windowSources.values()) {
          this._disposeWindowSource(ws);
          for (const subscriber of [...ws.subscribers]) {
            this._sendWindowFrame(subscriber, { type: 'error', code: 'WORKSPACE_UNAVAILABLE', message: 'The window stream ended; reconnect to resynchronize', retryable: true });
            subscriber.end?.(1011, 'stream ended');
            subscriber.closed = true;
          }
          ws.subscribers.clear();
        }
        entry.windowSources.clear();
      });
      control.on('notification', text => {
        if (/^%(?:window-close|unlinked-window-close|window-add|unlinked-window-add|layout-change|window-pane-changed|session-changed|sessions-changed)\b/.test(text)) {
          this._reconcile(entry);
          this._reconcileWindows(entry);
        } else if (/^%(?:client-session-changed|client-detached)\b/.test(text)) {
          this._reconcileClients(entry);
        }
      });
      entry.ready = control.command("display-message -p '#{pid}:#{start_time}|#{session_id}|#{client_pid}'", {
        onResult: bytes => {
          const [instanceId, sessionId, pid] = bytes.toString().trim().split('|');
          if (instanceId !== target.instanceId || sessionId !== target.sessionId) throw fail('WORKSPACE_UNAVAILABLE', 'The control connection belongs to another server lifetime or session');
          if (!/^\d+$/.test(pid)) throw fail('INTERNAL', 'The control client identity is unavailable');
          control.clientPid = pid; // MSYS uses a POSIX pid, not child_process.pid.
        },
      }).catch(error => { this.entries.delete(key); control.dispose(); throw error; });
    }
    await entry.ready;
    clearTimeout(entry.timer);
    entry.timer = null;
    return entry;
  }

  _disposeWindowSource(ws) {
    ws.batcher.dispose();
    for (const paneState of ws.paneStates.values()) {
      clearTimeout(paneState.pauseTimer);
      paneState.pauseTimer = null;
    }
    ws.paneStates.clear();
  }

  _send(subscriber, frame) {
    if (subscriber.closed) return;
    try {
      subscriber.send(frame.type === 'output' || frame.type === 'snapshot' ? { ...frame, seq: ++subscriber.seq } : frame);
    } catch {
      subscriber.close?.();
      subscriber.end?.(1013, 'slow subscriber');
    }
  }

  _sendWindowFrame(subscriber, frame) {
    if (subscriber.closed) return;
    try {
      subscriber.send(frame);
    } catch {
      subscriber.close?.();
      subscriber.end?.(1013, 'slow subscriber');
    }
  }

  _broadcast(source, frame) {
    for (const subscriber of source.subscribers) {
      if (!subscriber.visible || subscriber.closed || (frame.type === 'output' && !subscriber.synced)) continue;
      if (frame.type === 'snapshot') subscriber.synced = true;
      this._send(subscriber, frame);
    }
  }

  _broadcastWindowOutput(ws, paneId, bytes) {
    let paneNum;
    try { paneNum = parsePaneNum(paneId); } catch { return; }
    for (const subscriber of [...ws.subscribers]) {
      if (!subscriber.visible || subscriber.closed || !subscriber.syncedPanes.has(paneId)) continue;
      const nextSeq = (((subscriber.paneSeqs.get(paneId) ?? 0) + 1) >>> 0);
      subscriber.paneSeqs.set(paneId, nextSeq);
      this._sendWindowFrame(subscriber, encodeOutputFrame(paneNum, nextSeq, bytes));
    }
  }

  _broadcastWindowControl(ws, frame) {
    for (const subscriber of [...ws.subscribers]) {
      if (subscriber.closed) continue;
      this._sendWindowFrame(subscriber, frame);
    }
  }

  _announce(source, foreign) {
    for (const subscriber of source.subscribers) {
      const resizeAllowed = source.target.singlePane && !foreign && this._owner(source) === subscriber;
      const key = `${source.target.cols}:${source.target.rows}:${resizeAllowed}`;
      if (subscriber.announcement === key) continue;
      subscriber.announcement = key;
      this._send(subscriber, { type: 'ready', protocol: 1, ...source.target, resizeAllowed });
    }
  }

  _windowOwner(ws) {
    return [...ws.subscribers].filter(item => item.visible && !item.closed).sort((a, b) => b.order - a.order)[0] || null;
  }

  _syncTakeoverState(ws, owner, foreignPids) {
    if (!ws.takeoverSubscriber) return;
    if (ws.takeoverSubscriber !== owner || ws.takeoverSubscriber.closed || !ws.takeoverSubscriber.visible || foreignPids.size === 0) {
      ws.takeoverSubscriber = null;
      ws.takeoverForeignPids = null;
      return;
    }
    for (const pid of foreignPids) {
      if (!ws.takeoverForeignPids?.has(pid)) {
        ws.takeoverSubscriber = null;
        ws.takeoverForeignPids = null;
        return;
      }
    }
  }

  _computeWindowLease(ws, subscriber, owner, foreignPids) {
    const isOwner = Boolean(owner === subscriber && subscriber.visible && !subscriber.closed);
    const inputAllowed = isOwner;
    let sizeLease = 'observer';
    if (isOwner) {
      sizeLease = (foreignPids.size === 0 || ws.takeoverSubscriber === subscriber) ? 'owner' : 'follow-foreign';
    }
    return { sizeLease, inputAllowed };
  }

  _announceWindow(ws, foreignPids) {
    const owner = this._windowOwner(ws);
    this._syncTakeoverState(ws, owner, foreignPids);
    const foreignClient = foreignPids.size > 0;
    for (const subscriber of [...ws.subscribers]) {
      const { sizeLease, inputAllowed } = this._computeWindowLease(ws, subscriber, owner, foreignPids);
      const key = `${ws.state.windowCols}:${ws.state.windowRows}:${ws.state.zoomed}:${sizeLease}:${inputAllowed}:${foreignClient}`;
      if (subscriber.announcement === key) continue;
      subscriber.announcement = key;
      this._sendWindowFrame(subscriber, {
        type: 'ready',
        protocol: 1,
        instanceId: ws.state.instanceId,
        sessionId: ws.state.sessionId,
        windowId: ws.state.windowId,
        windowCols: ws.state.windowCols,
        windowRows: ws.state.windowRows,
        zoomed: ws.state.zoomed,
        sizeLease,
        inputAllowed,
        foreignClient,
      });
    }
  }

  async _snapshot(entry, source) {
    if (source.snapshotting) return source.snapshotting;
    source.synced = false;
    const task = entry.control.command(this.snapshotCommand(source.target.paneId), {
      onResult: bytes => {
        const snapshot = decodeSnapshot(bytes);
        if (snapshot.paneId !== source.target.paneId || snapshot.instanceId !== source.target.instanceId || snapshot.windowId !== source.target.windowId) throw fail('PANE_NOT_FOUND', 'The snapshot belongs to another pane');
        source.target.cols = snapshot.cols;
        source.target.rows = snapshot.rows;
        source.synced = true;
        // Native capture cuts this pane's queued raw output at the same callback
        // that serializes its state. Resynchronize every subscriber at that fence.
        this._broadcast(source, { type: 'snapshot', encoding: 'base64', data: snapshot.dataBase64, cols: snapshot.cols, rows: snapshot.rows, historyLines: snapshot.historyLines, historyTotal: snapshot.historyTotal });
      },
    });
    source.snapshotting = task;
    try { await task; }
    catch (error) {
      source.synced = false;
      for (const subscriber of [...source.subscribers]) {
        this._send(subscriber, { type: 'error', code: error.code || 'INTERNAL', message: 'The pane could not be resynchronized', retryable: error.retryable === true });
        subscriber.end?.(error.retryable ? 1011 : 1008, 'snapshot failed');
        subscriber.close();
      }
      throw error;
    } finally { if (source.snapshotting === task) source.snapshotting = null; }
  }

  _applyWindowPaneSnapshot(ws, paneId, bytes, { maxHistoryLines = this.initialSnapshotHistoryLines } = {}) {
    const snapshot = decodeSnapshot(bytes);
    if (snapshot.paneId !== paneId || snapshot.instanceId !== ws.state.instanceId || snapshot.windowId !== ws.state.windowId) {
      throw fail('PANE_NOT_FOUND', 'The snapshot belongs to another pane');
    }
    const pane = ws.state.panes.find(item => item.id === paneId);
    if (pane) { pane.width = snapshot.cols; pane.height = snapshot.rows; }
    ws.batcher.discard(paneId);
    const paneNum = parsePaneNum(paneId);
    const rawData = Buffer.from(snapshot.dataBase64, 'base64');
    const compacted = compactNativeSnapshot(rawData, { rows: snapshot.rows, maxHistoryLines });
    const data = compacted.data;
    const historyLines = compacted.historyLines ?? snapshot.historyLines ?? 0;
    const historyTotal = Math.max(snapshot.historyTotal ?? 0, compacted.historyTotal ?? 0);
    for (const subscriber of [...ws.subscribers]) {
      if (!subscriber.visible || subscriber.closed) continue;
      const prevSeq = subscriber.paneSeqs.get(paneId);
      const nextSeq = prevSeq === undefined ? 0 : ((prevSeq + 1) >>> 0);
      subscriber.syncedPanes.add(paneId);
      subscriber.paneSeqs.set(paneId, nextSeq);
      this._sendWindowFrame(subscriber, encodeSnapshotFrame({
        paneNum,
        seq: nextSeq,
        cols: snapshot.cols,
        rows: snapshot.rows,
        historyLines,
        historyTotal,
        data,
      }));
    }
  }

  async _snapshotWindowPane(entry, ws, paneId, options = {}) {
    const paneState = ws.paneStates.get(paneId);
    if (!paneState) return;
    if (paneState.snapshotting) return paneState.snapshotting;
    for (const subscriber of ws.subscribers) subscriber.syncedPanes.delete(paneId);
    const task = entry.control.command(this.snapshotCommand(paneId), {
      onResult: bytes => this._applyWindowPaneSnapshot(ws, paneId, bytes, options),
    });
    paneState.snapshotting = task;
    try { await task; }
    catch (error) {
      for (const subscriber of [...ws.subscribers]) {
        this._sendWindowFrame(subscriber, { type: 'error', code: error.code || 'INTERNAL', message: 'The window pane could not be resynchronized', retryable: error.retryable === true });
        subscriber.end?.(error.retryable ? 1011 : 1008, 'snapshot failed');
        subscriber.close();
      }
      throw error;
    } finally { if (paneState.snapshotting === task) paneState.snapshotting = null; }
  }

  async _snapshotWindowPanes(entry, ws, paneIds, options = {}) {
    const ordered = [];
    const seen = new Set();
    if (ws.state.activePaneId && paneIds.includes(ws.state.activePaneId)) {
      ordered.push(ws.state.activePaneId);
      seen.add(ws.state.activePaneId);
    }
    for (const id of paneIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    await Promise.all(ordered.map(id => this._snapshotWindowPane(entry, ws, id, options)));
  }

  _schedulePauseRecovery(entry, ws, paneId) {
    const paneState = ws.paneStates.get(paneId);
    if (!paneState || paneState.pauseTimer || entry.closed) return;
    paneState.pauseTimer = setTimeout(async () => {
      paneState.pauseTimer = null;
      if (entry.closed || this.closed || !entry.windowSources.has(ws.state.windowId) || !ws.paneStates.has(paneId)) return;
      if (![...ws.subscribers].some(sub => sub.visible && !sub.closed)) return;
      try {
        await entry.control.command(`refresh-client -A ${paneId}:continue ; ${this.snapshotCommand(paneId)}`, {
          blocks: 2,
          collect: true,
          onResult: results => this._applyWindowPaneSnapshot(ws, paneId, results[1], { maxHistoryLines: this.resizeSnapshotHistoryLines }),
        });
      } catch {
        // Closed or pane vanished; reconcile handles teardown.
      }
    }, PAUSE_RECOVER_DELAY_MS);
    paneState.pauseTimer.unref?.();
  }

  async subscribe(requested, send, { cancelled = () => false, end = null } = {}) {
    const target = await this.resolve(requested);
    if (cancelled()) return null;
    if (!(await this.capability()).available) throw fail('UNSUPPORTED', 'This tmux build does not support native pane snapshots');
    if (cancelled()) return null;
    const entry = await this._entry(target);
    if (cancelled()) { this._idle(entry); return null; }
    let source = entry.sources.get(target.paneId);
    if (!source) {
      source = { target, subscribers: new Set(), synced: false, snapshotting: null };
      entry.sources.set(target.paneId, source);
    } else source.target = target;
    if (source.subscribers.size >= MAX_SUBSCRIBERS) throw fail('CONNECTION_LIMIT', 'Too many views of this pane');
    const subscriber = { send, end, seq: -1, visible: true, order: ++this.order, closed: false, synced: false };
    subscriber.close = () => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      source.subscribers.delete(subscriber);
      if (source.subscribers.size === 0) entry.sources.delete(target.paneId);
      else this._foreignClient(target.sessionId).then(foreign => this._announce(source, foreign)).catch(() => {});
      this._idle(entry);
    };
    const lease = {
      close: subscriber.close,
      input: async data => {
        if (subscriber.closed || !subscriber.synced || !source.synced || !subscriber.visible || this._owner(source) !== subscriber) return false;
        if ((typeof data !== 'string' && !Buffer.isBuffer(data)) || Buffer.byteLength(data) > MAX_INPUT_BYTES) throw fail('VALIDATION_ERROR', 'Terminal input exceeded its limit');
        if (!data.length) return true;
        // This pipe remains bound to the verified server lifetime. Pane ids are
        // never reused within it, so a keystroke needs no subprocess/round trip.
        if (subscriber.closed || entry.closed) return false;
        const hex = [...Buffer.from(data, 'utf8')].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
        await entry.control.command(`send-keys -H -t ${target.paneId} ${hex}`);
        return true;
      },
      resize: async (cols, rows) => {
        if (subscriber.closed || !validControlSize(cols, rows) || this._owner(source) !== subscriber) return false;
        const requestKey = () => `${cols}:${rows}|${source.target.cols}:${source.target.rows}:${source.target.windowCols}:${source.target.windowRows}`;
        if (subscriber.lastResize === requestKey()) return true;
        const current = await this.resolve(target);
        const foreign = await this._foreignClient(target.sessionId);
        source.target = current;
        if (!current.singlePane || foreign || this._owner(source) !== subscriber || subscriber.closed) {
          this._announce(source, foreign);
          await this._snapshot(entry, source);
          return false;
        }
        if (current.cols === cols && current.rows === rows) { subscriber.lastResize = requestKey(); return true; }
        // pane-border-status top/bottom reserves a row inside the window. A
        // requested pane grid is not the window grid; confusing them continually
        // resizes to an impossible size and causes a reset/snapshot feedback loop.
        const windowCols = cols + current.windowCols - current.cols;
        const windowRows = rows + current.windowRows - current.rows;
        await entry.control.command(`resize-window -t ${target.windowId} -x ${windowCols} -y ${windowRows}`);
        source.target = await this.resolve(target);
        // SIGWINCH can redraw a running TUI. The following native capture fences
        // those bytes and announces the resulting remote grid to every view.
        await this._snapshot(entry, source);
        subscriber.lastResize = requestKey();
        this.workspace.invalidate?.();
        return true;
      },
      visibility: async visible => {
        if (subscriber.closed || typeof visible !== 'boolean') return;
        const wasVisible = subscriber.visible;
        subscriber.visible = visible;
        if (!visible) subscriber.synced = false;
        if (visible) {
          subscriber.order = ++this.order;
          this._announce(source, await this._foreignClient(target.sessionId));
          if (!wasVisible) await this._snapshot(entry, source);
        } else this._announce(source, await this._foreignClient(target.sessionId));
      },
    };
    source.subscribers.add(subscriber);
    try {
      const foreign = await this._foreignClient(target.sessionId);
      if (cancelled()) { subscriber.close(); return null; }
      this._announce(source, foreign);
      await this._snapshot(entry, source);
      if (cancelled()) { subscriber.close(); return null; }
      return lease;
    } catch (error) { subscriber.close(); throw error; }
  }

  async subscribeWindow(requested, send, { cancelled = () => false, end = null } = {}) {
    const resolved = await this.resolveWindow(requested);
    if (cancelled()) return null;
    if (!(await this.capability()).available) throw fail('UNSUPPORTED', 'This tmux build does not support native pane snapshots');
    if (cancelled()) return null;
    const entry = await this._entry(resolved);
    if (cancelled()) { this._idle(entry); return null; }
    if (!entry.pauseAfterEnabled && this.pauseAfterSec > 0) {
      entry.pauseAfterEnabled = true;
      await entry.control.command(`refresh-client -f pause-after=${this.pauseAfterSec}`).catch(() => {});
    }
    if (cancelled()) { this._idle(entry); return null; }

    let ws = entry.windowSources.get(resolved.windowId);
    if (!ws) {
      ws = {
        state: resolved,
        subscribers: new Set(),
        takeoverSubscriber: null,
        takeoverForeignPids: null,
        paneStates: new Map(resolved.panes.map(pane => [pane.id, { snapshotting: null, pauseTimer: null }])),
        batcher: createBinaryOutputBatcher((paneId, bytes) => this._broadcastWindowOutput(ws, paneId, bytes), { burstMs: this.outputBatchMs }),
      };
      entry.windowSources.set(resolved.windowId, ws);
    } else {
      ws.state = resolved;
      for (const pane of resolved.panes) {
        if (!ws.paneStates.has(pane.id)) ws.paneStates.set(pane.id, { snapshotting: null, pauseTimer: null });
      }
    }

    if (ws.subscribers.size >= MAX_SUBSCRIBERS) throw fail('CONNECTION_LIMIT', 'Too many views of this window');

    const subscriber = {
      send,
      end,
      visible: true,
      order: ++this.order,
      closed: false,
      syncedPanes: new Set(),
      paneSeqs: new Map(),
      announcement: null,
    };

    const assertWindowPane = paneId => {
      if (!/^%\d+$/.test(String(paneId || '')) || !ws.state.panes.some(pane => pane.id === paneId)) {
        throw fail('PANE_NOT_FOUND', 'The pane does not belong to this window');
      }
      return paneId;
    };

    const assertInputAllowed = () => !subscriber.closed && !entry.closed && subscriber.visible && this._windowOwner(ws) === subscriber;

    subscriber.close = () => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      ws.subscribers.delete(subscriber);
      if (ws.takeoverSubscriber === subscriber) {
        ws.takeoverSubscriber = null;
        ws.takeoverForeignPids = null;
      }
      if (ws.subscribers.size === 0) {
        this._disposeWindowSource(ws);
        entry.windowSources.delete(resolved.windowId);
      } else {
        this._foreignClientPids(resolved.sessionId).then(foreignPids => this._announceWindow(ws, foreignPids)).catch(() => {});
      }
      this._idle(entry);
    };

    const lease = {
      close: subscriber.close,
      input: async (paneId, data) => {
        assertWindowPane(paneId);
        if (!assertInputAllowed()) return false;
        if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw fail('VALIDATION_ERROR', 'Terminal input exceeded its limit');
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        if (buf.length > MAX_INPUT_BYTES) throw fail('VALIDATION_ERROR', 'Terminal input exceeded its limit');
        if (!buf.length) return true;
        for (let offset = 0; offset < buf.length; offset += INPUT_CHUNK_BYTES) {
          if (subscriber.closed || entry.closed) return false;
          const slice = buf.subarray(offset, offset + INPUT_CHUNK_BYTES);
          const hex = Array.from(slice, byte => byte.toString(16).padStart(2, '0')).join(' ');
          await entry.control.command(`send-keys -H -t ${paneId} ${hex}`);
        }
        return true;
      },
      resizeWindow: async (cols, rows) => {
        if (!validControlSize(cols, rows)) throw fail('VALIDATION_ERROR', 'Invalid window size');
        if (subscriber.closed || !subscriber.visible) return false;
        const foreignPids = await this._foreignClientPids(ws.state.sessionId);
        const owner = this._windowOwner(ws);
        this._syncTakeoverState(ws, owner, foreignPids);
        const { sizeLease } = this._computeWindowLease(ws, subscriber, owner, foreignPids);
        if (sizeLease !== 'owner') {
          this._announceWindow(ws, foreignPids);
          return false;
        }
        if (ws.state.windowCols === cols && ws.state.windowRows === rows) return true;
        // Window coordinates are 1:1 with tmux's window layout root; never add border offsets.
        await entry.control.command(`resize-window -t ${ws.state.windowId} -x ${cols} -y ${rows}`);
        await this._reconcileWindow(entry, ws);
        this.workspace.invalidate?.();
        return true;
      },
      resizePaneSize: async (paneId, { cols, rows } = {}) => {
        return lease.resizePaneBatch([{ paneId, ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}) }]);
      },
      resizePaneBatch: async (resizes) => {
        if (!Array.isArray(resizes) || resizes.length < 1 || resizes.length > 4) {
          throw fail('VALIDATION_ERROR', 'Invalid pane resize batch');
        }
        const cmds = resizes.map((item) => {
          const paneId = item?.paneId;
          const { cols, rows } = item || {};
          assertWindowPane(paneId);
          const hasCols = cols !== undefined;
          const hasRows = rows !== undefined;
          if ((!hasCols && !hasRows) || (hasCols && (!Number.isInteger(cols) || cols < 1 || cols > MAX_DIMENSION))
            || (hasRows && (!Number.isInteger(rows) || rows < 1 || rows > MAX_DIMENSION))) {
            throw fail('VALIDATION_ERROR', 'Invalid pane dimensions');
          }
          const args = [`resize-pane -t ${paneId}`];
          if (hasCols) args.push(`-x ${cols}`);
          if (hasRows) args.push(`-y ${rows}`);
          return args.join(' ');
        });
        if (subscriber.closed || !subscriber.visible) return false;
        const foreignPids = await this._foreignClientPids(ws.state.sessionId);
        const owner = this._windowOwner(ws);
        this._syncTakeoverState(ws, owner, foreignPids);
        const { sizeLease } = this._computeWindowLease(ws, subscriber, owner, foreignPids);
        if (sizeLease !== 'owner') {
          this._announceWindow(ws, foreignPids);
          return false;
        }
        if (cmds.length === 1) await entry.control.command(cmds[0]);
        else if (typeof entry.control.transaction === 'function') await entry.control.transaction(cmds);
        else await entry.control.command(cmds.join(' ; '), { blocks: cmds.length, collect: true });
        await this._reconcileWindow(entry, ws);
        this.workspace.invalidate?.();
        return true;
      },
      selectPane: async paneId => {
        assertWindowPane(paneId);
        if (!assertInputAllowed()) return false;
        if (ws.state.activePaneId !== paneId) {
          await entry.control.command(`select-pane -t ${paneId}`);
          ws.state = {
            ...ws.state,
            activePaneId: paneId,
            panes: ws.state.panes.map(pane => ({ ...pane, active: pane.id === paneId })),
          };
          this._broadcastWindowControl(ws, layoutFramePayload(ws.state));
          this.workspace.invalidate?.();
        }
        return true;
      },
      zoomPane: async (paneId, zoomed) => {
        assertWindowPane(paneId);
        if (zoomed !== undefined && typeof zoomed !== 'boolean') throw fail('VALIDATION_ERROR', 'Invalid zoom target');
        if (!assertInputAllowed()) return false;
        const targetZoom = zoomed === undefined ? !ws.state.zoomed : zoomed;
        if (ws.state.zoomed !== targetZoom || (targetZoom && ws.state.activePaneId !== paneId)) {
          if (ws.state.activePaneId !== paneId) await entry.control.command(`select-pane -t ${paneId}`);
          const current = await this.resolveWindow(ws.state);
          if (current.zoomed !== targetZoom) await entry.control.command(`resize-pane -Z -t ${paneId}`);
          await this._reconcileWindow(entry, ws);
          this.workspace.invalidate?.();
        }
        return true;
      },
      takeover: async () => {
        if (subscriber.closed || !subscriber.visible) return false;
        const foreignPids = await this._foreignClientPids(ws.state.sessionId);
        let owner = this._windowOwner(ws);
        if (owner !== subscriber) {
          subscriber.order = ++this.order;
          owner = subscriber;
        }
        if (foreignPids.size > 0) {
          ws.takeoverSubscriber = subscriber;
          ws.takeoverForeignPids = new Set(foreignPids);
        } else if (ws.takeoverSubscriber && ws.takeoverSubscriber !== subscriber) {
          ws.takeoverSubscriber = null;
          ws.takeoverForeignPids = null;
        }
        this._announceWindow(ws, foreignPids);
        return true;
      },
      releaseTakeover: async () => {
        if (subscriber.closed) return false;
        if (ws.takeoverSubscriber === subscriber) {
          ws.takeoverSubscriber = null;
          ws.takeoverForeignPids = null;
          this._announceWindow(ws, await this._foreignClientPids(ws.state.sessionId));
        }
        return true;
      },
      resync: async ({ paneId = null, forceSnapshot = false } = {}) => {
        if (subscriber.closed) return false;
        if (paneId != null) assertWindowPane(paneId);
        await this._reconcileWindow(entry, ws, {
          forceSnapshotPaneId: forceSnapshot && paneId ? paneId : null,
        });
        return true;
      },
      visibility: async visible => {
        if (subscriber.closed || typeof visible !== 'boolean') return;
        const wasVisible = subscriber.visible;
        subscriber.visible = visible;
        if (!visible) {
          subscriber.syncedPanes.clear();
          if (ws.takeoverSubscriber === subscriber) {
            ws.takeoverSubscriber = null;
            ws.takeoverForeignPids = null;
          }
          this._announceWindow(ws, await this._foreignClientPids(ws.state.sessionId));
          return;
        }
        subscriber.order = ++this.order;
        this._announceWindow(ws, await this._foreignClientPids(ws.state.sessionId));
        if (!wasVisible) {
          this._sendWindowFrame(subscriber, layoutFramePayload(ws.state));
          const termIds = [];
          for (const pane of ws.state.panes) {
            if (subscriber.closed) break;
            if (pane.kind && pane.kind !== 'terminal') subscriber.syncedPanes.add(pane.id);
            else termIds.push(pane.id);
          }
          if (!subscriber.closed && termIds.length) {
            await this._snapshotWindowPanes(entry, ws, termIds, { maxHistoryLines: this.initialSnapshotHistoryLines });
          }
        }
      },
    };

    ws.subscribers.add(subscriber);
    try {
      const foreignPids = await this._foreignClientPids(resolved.sessionId);
      if (cancelled()) { subscriber.close(); return null; }
      this._announceWindow(ws, foreignPids);
      this._sendWindowFrame(subscriber, layoutFramePayload(ws.state));
      const termIds = [];
      for (const pane of ws.state.panes) {
        if (cancelled()) { subscriber.close(); return null; }
        if (pane.kind && pane.kind !== 'terminal') subscriber.syncedPanes.add(pane.id);
        else termIds.push(pane.id);
      }
      if (!cancelled() && termIds.length) {
        await this._snapshotWindowPanes(entry, ws, termIds, { maxHistoryLines: this.initialSnapshotHistoryLines });
      }
      if (cancelled()) { subscriber.close(); return null; }
      return lease;
    } catch (error) {
      subscriber.close();
      throw error;
    }
  }

  _owner(source) {
    return [...source.subscribers].filter(item => item.visible && !item.closed).sort((a, b) => b.order - a.order)[0];
  }

  async _foreignClientPids(sessionId) {
    const clients = String(await this.tmux.run(['list-clients', '-F', '#{session_id}|#{client_pid}']));
    const owned = new Set([...this.entries.values()].map(entry => entry.control.clientPid || entry.control.child?.pid).filter(Boolean).map(String));
    for (const pid of this.getOwnedClientPids?.() || []) {
      if (pid) owned.add(String(pid));
    }
    const foreignPids = new Set();
    for (const line of clients.trim().split('\n')) {
      if (!line) continue;
      const [session, pid] = line.split('|');
      if (session === sessionId && pid && !owned.has(pid)) foreignPids.add(pid);
    }
    return foreignPids;
  }

  async _foreignClient(sessionId) {
    return (await this._foreignClientPids(sessionId)).size > 0;
  }

  async _reconcileClients(entry) {
    if (entry.closed || this.closed || !entry.windowSources.size) return;
    try {
      const foreignPids = await this._foreignClientPids(entry.sessionId);
      for (const ws of entry.windowSources.values()) {
        this._announceWindow(ws, foreignPids);
      }
    } catch {
      // Best-effort instant lease notification; transient read failures recover on next event.
    }
  }

  async _reconcileWindows(entry) {
    if (entry.closed || this.closed || !entry.windowSources.size) return;
    for (const ws of [...entry.windowSources.values()]) {
      await this._reconcileWindow(entry, ws);
    }
  }

  async _reconcileWindow(entry, ws, { forceSnapshotPaneId = null } = {}) {
    if (entry.closed || this.closed || !entry.windowSources.has(ws.state.windowId)) return;
    if (forceSnapshotPaneId) {
      ws.pendingForceSnapshots = ws.pendingForceSnapshots || new Set();
      ws.pendingForceSnapshots.add(forceSnapshotPaneId);
    }
    if (ws.reconcilingPromise) {
      ws.reconcileAgain = true;
      while (ws.reconcilingPromise) await ws.reconcilingPromise;
      return;
    }

    const runPass = async () => {
      const forcedSet = new Set(ws.pendingForceSnapshots || []);
      ws.pendingForceSnapshots?.clear();
      try {
        const prev = ws.state;
        const next = await this.resolveWindow(prev);
        const prevById = new Map(prev.panes.map(pane => [pane.id, pane]));
        const nextById = new Map(next.panes.map(pane => [pane.id, pane]));

        const removed = [];
        for (const pane of prev.panes) {
          if (!nextById.has(pane.id)) removed.push(pane.id);
        }
        const initialSnapshotPanes = [];
        const resizeSnapshotPanes = [];
        let richChanged = false;
        for (const pane of next.panes) {
          const old = prevById.get(pane.id);
          const isRich = Boolean(pane.kind && pane.kind !== 'terminal');
          if (!old || old.kind !== pane.kind || old.payload !== pane.payload) richChanged = true;
          if (!isRich) {
            if (forcedSet.has(pane.id) || !old || old.kind !== pane.kind || prev.zoomed !== next.zoomed) {
              initialSnapshotPanes.push(pane.id);
            } else if (old.width !== pane.width || old.height !== pane.height) {
              resizeSnapshotPanes.push(pane.id);
            }
          }
          if (isRich) {
            ws.batcher.discard(pane.id);
            for (const sub of ws.subscribers) {
              if (sub.visible && !sub.closed) sub.syncedPanes.add(pane.id);
            }
          }
        }

        const layoutChanged = removed.length > 0
          || initialSnapshotPanes.length > 0
          || resizeSnapshotPanes.length > 0
          || richChanged
          || prev.windowCols !== next.windowCols
          || prev.windowRows !== next.windowRows
          || prev.zoomed !== next.zoomed
          || prev.activePaneId !== next.activePaneId
          || prev.layoutString !== next.layoutString;

        ws.state = next;

        for (const paneId of removed) {
          ws.batcher.flush(paneId);
          const ps = ws.paneStates.get(paneId);
          if (ps) clearTimeout(ps.pauseTimer);
          ws.paneStates.delete(paneId);
          for (const sub of ws.subscribers) {
            sub.syncedPanes.delete(paneId);
            sub.paneSeqs.delete(paneId);
          }
          this._broadcastWindowControl(ws, { type: 'pane-exit', paneId, reason: 'pane_closed' });
        }

        for (const pane of next.panes) {
          if (!ws.paneStates.has(pane.id)) ws.paneStates.set(pane.id, { snapshotting: null, pauseTimer: null });
        }

        if (layoutChanged) {
          const foreignPids = await this._foreignClientPids(next.sessionId);
          this._announceWindow(ws, foreignPids);
          this._broadcastWindowControl(ws, layoutFramePayload(next));
        }

        const snapshotJobs = [];
        if (initialSnapshotPanes.length) {
          snapshotJobs.push(this._snapshotWindowPanes(entry, ws, initialSnapshotPanes, { maxHistoryLines: this.initialSnapshotHistoryLines }));
        }
        if (resizeSnapshotPanes.length) {
          snapshotJobs.push(this._snapshotWindowPanes(entry, ws, resizeSnapshotPanes, { maxHistoryLines: this.resizeSnapshotHistoryLines }));
        }
        if (snapshotJobs.length) await Promise.all(snapshotJobs);
      } catch (error) {
        if (error.code === 'UNSUPPORTED') {
          this._disposeWindowSource(ws);
          entry.windowSources.delete(ws.state.windowId);
          for (const subscriber of [...ws.subscribers]) {
            this._sendWindowFrame(subscriber, { type: 'error', code: error.code, message: error.message, retryable: false });
            subscriber.end?.(1008, 'linked window');
            subscriber.close();
          }
        } else if (['PANE_NOT_FOUND', 'WINDOW_NOT_FOUND', 'SESSION_NOT_FOUND'].includes(error.code)) {
          ws.batcher.flushAll();
          this._disposeWindowSource(ws);
          entry.windowSources.delete(ws.state.windowId);
          for (const subscriber of [...ws.subscribers]) {
            this._sendWindowFrame(subscriber, { type: 'window-exit', windowId: ws.state.windowId, reason: 'window_closed' });
            subscriber.end?.(1000, 'window closed');
            subscriber.close();
          }
        }
      }
    };

    ws.reconcilingPromise = (async () => {
      try {
        do {
          ws.reconcileAgain = false;
          await runPass();
        } while (ws.reconcileAgain && !entry.closed && !this.closed && entry.windowSources.has(ws.state.windowId));
      } finally {
        ws.reconcilingPromise = null;
      }
    })();
    return ws.reconcilingPromise;
  }

  async _reconcile(entry) {
    if (entry.closed || this.closed) return;
    if (entry.reconciling) { entry.reconcileAgain = true; return; }
    entry.reconciling = true;
    try {
      for (const source of [...entry.sources.values()]) {
        try {
          const current = await this.resolve(source.target);
          const changed = current.cols !== source.target.cols || current.rows !== source.target.rows || current.singlePane !== source.target.singlePane;
          source.target = current;
          if (changed) {
            this._announce(source, await this._foreignClient(current.sessionId));
            await this._snapshot(entry, source);
          }
        } catch (error) {
          if (error.code === 'UNSUPPORTED') {
            for (const subscriber of [...source.subscribers]) {
              this._send(subscriber, { type: 'error', code: error.code, message: error.message, retryable: false });
              subscriber.end?.(1008, 'linked window');
              subscriber.close();
            }
            continue;
          }
          if (!['PANE_NOT_FOUND', 'WINDOW_NOT_FOUND', 'SESSION_NOT_FOUND'].includes(error.code)) continue;
          for (const subscriber of [...source.subscribers]) {
            this._send(subscriber, { type: 'exit', reason: 'pane_closed' });
            subscriber.end?.(1000, 'pane closed');
            subscriber.close();
          }
        }
      }
    } finally {
      entry.reconciling = false;
      if (entry.reconcileAgain) { entry.reconcileAgain = false; this._reconcile(entry).catch(() => {}); }
    }
  }

  /** A read-only page in the currently retained tmux history, oldest first. */
  async history(requested, { before, limit = 500 } = {}) {
    if ((before !== undefined && (!Number.isSafeInteger(before) || before < 0 || before > 0x7fffffff))
      || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fail('VALIDATION_ERROR', 'Invalid terminal history range');
    const target = await this.resolve(requested);
    if (!(await this.capability()).available) throw fail('UNSUPPORTED', 'Native pane streams are required for scoped history');
    const entry = await this._entry(target);
    const metadata = `display-message -p -t ${target.paneId} '#{pid}:#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{history_size}|#{window_linked}'`;
    const parse = bytes => {
      const [instanceId, sessionId, windowId, paneId, total, linked] = bytes.toString().trim().split('|');
      if (instanceId !== target.instanceId || sessionId !== target.sessionId || windowId !== target.windowId || paneId !== target.paneId) throw fail('WORKSPACE_UNAVAILABLE', 'The history target changed; refresh the workspace');
      if (linked !== '0') throw fail('UNSUPPORTED', 'Linked tmux windows use the compatible terminal view');
      if (!/^\d+$/.test(total) || Number(total) > 0x7fffffff) throw fail('WORKSPACE_UNAVAILABLE', 'The terminal history range is unavailable');
      return Number(total);
    };
    try {
      const total = parse(await entry.control.command(metadata));
      const end = Math.min(before ?? total, total);
      const start = Math.max(0, end - limit);
      const capture = `capture-pane -p -t ${target.paneId} -S ${start - total} -E ${end - 1 - total}`;
      // One line is one command queue group. These synchronous commands do not
      // yield; metadata on both sides also rejects a history-changing user hook.
      const results = await entry.control.transaction(end > start ? [metadata, capture, metadata] : [metadata, metadata]);
      if (parse(results[0]) !== total || parse(results.at(-1)) !== total) throw fail('TERMINAL_BUSY', 'Terminal history changed while reading; retry this page');
      return { ...requested, lines: end > start ? results[1].toString('utf8').split('\n') : [], total, before: end, nextBefore: start === 0 ? null : start };
    } finally { this._idle(entry); }
  }

  _idle(entry) {
    if (entry.sources.size || entry.windowSources.size || entry.closed || entry.timer) return;
    entry.timer = setTimeout(() => {
      if (entry.sources.size === 0 && entry.windowSources.size === 0) { this.entries.delete(entry.key); entry.control.dispose(); }
    }, this.idleMs);
    entry.timer.unref?.();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      clearTimeout(entry.timer);
      for (const ws of entry.windowSources.values()) this._disposeWindowSource(ws);
      entry.windowSources.clear();
      entry.control.dispose();
    }
    this.entries.clear();
  }
}
