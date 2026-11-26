import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TMUX_BIN, msysExecArgs } from './msys.js';
import { diagnostics } from './diagnostics.js';
import { tmuxEnv, tmuxServerArgs } from './tmux-server.js';
import { HYPERLINK_ENV_COMMAND } from './terminal/hyperlinks.js';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 5000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

async function observedExec(command, args, options) {
  const began = performance.now();
  let result;
  let failure;
  try {
    result = command === TMUX_BIN
      ? await execFileAsync(command, ...msysExecArgs([...tmuxServerArgs(), ...args], { ...options, argv0: command, env: tmuxEnv(options?.env ?? process.env) }))
      : await execFileAsync(command, args, options);
    return result;
  } catch (err) { failure = err; throw err; }
  finally {
    if (diagnostics.status().active) diagnostics.record('command', {
      provider: command === TMUX_BIN ? 'tmux' : 'process',
      operation: command === TMUX_BIN ? args[0] : 'exec',
      durationMs: performance.now() - began, outcome: failure ? 'error' : 'ok',
      code: typeof failure?.code === 'string' ? failure.code : undefined,
      exitCode: failure ? (typeof failure.code === 'number' ? failure.code : null) : 0,
      timedOut: Boolean(failure?.killed),
      stdoutBytes: Buffer.byteLength(result?.stdout || failure?.stdout || ''), stderrBytes: Buffer.byteLength(result?.stderr || failure?.stderr || ''),
    });
  }
}

// --- Validation ---

const SESSION_NAME_RE = /^[\w\-\u4e00-\u9fff][\w\-\u4e00-\u9fff\s]*$/;
const WINDOW_NAME_RE = /^[^\x00-\x1f:]*$/;
const PANE_ID_RE = /^%\d+$/;
const WINDOW_INDEX_RE = /^\d+$/;
const WINDOW_ID_RE = /^@\d+$/;
/** The layouts select-layout takes by name; the workspace provider checks against it too. */
export const PRESET_LAYOUTS = ['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled'];
const SESSION_ID_RE = /^\$\d+$/;

/**
 * Field separator for `-F` output.
 *
 * It has to be printable. tmux 3.6a replaces every control character in format
 * output with "_", which destroyed the previous \x1f separator — and did so
 * irreversibly, since a real "_" in a name is indistinguishable from a rewritten
 * separator. Printable characters pass through every tmux version unchanged.
 */
const FIELD_SEP = '=:=';

/**
 * The `-c` for a new session or window: home. Without `-c`, tmux starts a
 * window from a command client that has no session (every tmux the panel
 * runs) in that client's working directory, which is the panel's install
 * directory. tmux expands this when the pane spawns, from the session's then
 * the global environment, so it is the same ~ the pane's shell has (MSYS2's
 * /home/<user> on Windows).
 */
export const HOME_CWD = '#{HOME}';

/** A literal path for a `-c`, which tmux expands as a format. */
export const tmuxLiteral = (path) => path.replaceAll('#', '##');

/**
 * Splits one `-F` line into `count` fields, reassembling the free-text field at
 * `textIndex` from whatever the anchored fields around it do not claim.
 *
 * A window name or working directory may legitimately contain FIELD_SEP, so the
 * fields carrying identity — ids, indices, numbers — are read at fixed offsets
 * from both ends and stay exact no matter what the text field holds.
 */
function splitTmuxFields(line, count, textIndex) {
  const parts = line.split(FIELD_SEP);
  if (parts.length <= count) return parts;
  const trailing = count - textIndex - 1;
  return [
    ...parts.slice(0, textIndex),
    parts.slice(textIndex, parts.length - trailing).join(FIELD_SEP),
    ...parts.slice(parts.length - trailing),
  ];
}

/**
 * Validates a tmux session or window name.
 * Allowed characters: [a-zA-Z0-9_\-\u4e00-\u9fff\s], must not be empty/whitespace-only.
 */
export function validateSessionName(name) {
  if (typeof name !== 'string') return false;
  if (name.trim().length === 0) return false;
  return SESSION_NAME_RE.test(name);
}

/**
 * Validates a tmux session ID (format: $<digits>). Session IDs are stable across
 * renames — prefer over name when an identity must survive edits.
 */
export function validateSessionId(id) {
  if (typeof id !== 'string') return false;
  return SESSION_ID_RE.test(id);
}

/**
 * Validates a tmux window name.
 * More permissive than session names — disallows control chars and colon (tmux separator).
 */
export function validateWindowName(name) {
  if (typeof name !== 'string') return false;
  if (name.trim().length === 0) return false;
  return WINDOW_NAME_RE.test(name);
}

/**
 * Validates a tmux pane ID (format: %<digits>).
 */
export function validatePaneId(id) {
  if (typeof id !== 'string') return false;
  return PANE_ID_RE.test(id);
}

const PANE_LABEL_MAX_LEN = 32;
const PANE_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PANE_PAYLOAD_MAX_BYTES = 8192;

/**
 * Validates a pane kind identifier (for rich panes such as browser/diff/doc).
 */
export function validatePaneKind(kind) {
  if (typeof kind !== 'string') return false;
  return PANE_KIND_RE.test(kind);
}

/**
 * Normalizes a rich pane payload (string or plain object -> string), returning
 * null when invalid (oversized, control chars, or contains FIELD_SEP).
 */
export function normalizePanePayload(payload) {
  if (payload === undefined || payload === null) return '';
  let text;
  if (typeof payload === 'string') {
    text = payload;
  } else if (typeof payload === 'object' && !Array.isArray(payload)) {
    try { text = JSON.stringify(payload); } catch { return null; }
  } else {
    return null;
  }
  if (text.includes(FIELD_SEP) || /[\x00-\x1f\x7f]/.test(text)) return null;
  if (Buffer.byteLength(text, 'utf8') > PANE_PAYLOAD_MAX_BYTES) return null;
  return text;
}

/**
 * Validates a rich pane payload (string or plain object).
 */
export function validatePanePayload(payload) {
  return normalizePanePayload(payload) !== null;
}

/**
 * Validates a user-supplied pane label. Stored as the tmux per-pane user
 * option @pane_label. Rejects control chars and FIELD_SEP: parsePanes anchors
 * the label as the last field, so a separator inside it would shift every field.
 */
export function validatePaneLabel(label) {
  if (typeof label !== 'string') return false;
  if (label.length > PANE_LABEL_MAX_LEN) return false;
  if (label.includes(FIELD_SEP)) return false;
  return !/[\x00-\x1f]/.test(label);
}

/**
 * Validates a tmux window index (non-negative integer string).
 */
export function validateWindowIndex(index) {
  if (typeof index !== 'string') return false;
  if (!WINDOW_INDEX_RE.test(index)) return false;
  const num = Number(index);
  return Number.isInteger(num) && num >= 0;
}

/**
 * Validates a tmux window ID (format: @<digits>). Window IDs are stable across
 * renames/moves/renumbers — prefer over index for destructive operations.
 */
export function validateWindowId(id) {
  if (typeof id !== 'string') return false;
  return WINDOW_ID_RE.test(id);
}

// --- Parsing ---

/**
 * Parses `tmux list-sessions -F` output:
 * 5 fields: session_id, session_name, session_windows, session_attached, session_last_attached.
 *
 * Also accepts the legacy pipe-delimited 4-field output (no session_id), which
 * yields `id: null`.
 */
export function parseSessions(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const fields = splitTmuxFields(line, 5, 1);
    if (fields.length < 5) {
      const [name, windows, attached, lastActivity] = line.split('|');
      return { id: null, name, windows: Number(windows), attached: attached === '1', lastActivity };
    }
    const [id, name, windows, attached, lastActivity] = fields;
    return {
      id,
      name,
      windows: Number(windows),
      attached: attached === '1',
      lastActivity,
    };
  });
}

/**
 * The name of a pane's process. tmux normally reports a bare command, but MSYS2
 * tmux on Windows reports a native program as an escaped absolute path
 * (C:\\Users\\me\\.local\\bin\\claude.exe).
 */
export function commandName(raw) {
  const text = String(raw || '');
  const base = text.split(/[\\/]+/).filter(Boolean).pop() || text;
  return base.replace(/\.exe$/i, '');
}

/**
 * A window's name. automatic-rename copies the pane's command, so on Windows an
 * unnamed window can be called by that same absolute path. A name someone
 * chose is left alone.
 */
export function windowName(raw) {
  const text = String(raw || '');
  return /^[A-Za-z]:[\\/]/.test(text) ? commandName(text) : text;
}

/**
 * Parses `tmux list-windows -F` output.
 * Accepts 8 fields (legacy) or 10 fields (adds window_zoomed_flag, window_layout).
 */
export function parseWindows(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const rawParts = line.split(FIELD_SEP);
    const hasLayout = rawParts.length >= 10
      && (rawParts.at(-2) === '0' || rawParts.at(-2) === '1')
      && /^[0-9a-fA-F]{4},\d+x\d+,\d+,\d+/.test(rawParts.at(-1));
    if (hasLayout) {
      const [id, index, name, active, width, height, bell, activity, zoomed, layout] = splitTmuxFields(line, 10, 2);
      return {
        id,
        index: Number(index),
        name: windowName(name),
        active: active === '1',
        width: Number(width),
        height: Number(height),
        bell: bell === '1',
        activity: Number(activity),
        zoomed: zoomed === '1',
        layout: layout || '',
      };
    }
    const [id, index, name, active, width, height, bell, activity] = splitTmuxFields(line, 8, 2);
    return {
      id,
      index: Number(index),
      name: windowName(name),
      active: active === '1',
      width: Number(width),
      height: Number(height),
      bell: bell === '1',
      activity: Number(activity),
    };
  });
}

/**
 * Parses `tmux list-panes -F` output.
 * 9 fields: id, x, y, width, height, active, command, index, label.
 *
 * Index and label are anchored last, so the command alone may absorb a separator.
 */
export function parsePanes(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [id, x, y, width, height, active, command, index, label] = splitTmuxFields(line, 9, 6);
    return {
      id,
      index: Number(index),
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      active: active === '1',
      command: commandName(command),
      label: label || '',
    };
  });
}

/**
 * Parses `tmux list-panes -s -F` output.
 * 5 fields: window_index, pane_id, command, path, pid.
 *
 * The working directory is the field allowed to absorb a separator; the ids and
 * the pid around it stay exact.
 */
export function parsePaneCommands(output) {
  if (!output || output.trim().length === 0) return [];
  const panes = [];
  const titleByPane = new Map();

  for (const rawLine of output.trim().split('\n')) {
    if (!rawLine) continue;
    if (rawLine.startsWith(`T${FIELD_SEP}`)) {
      const rest = rawLine.slice(1 + FIELD_SEP.length);
      const sepIdx = rest.indexOf(FIELD_SEP);
      if (sepIdx > 0) {
        const paneId = rest.slice(0, sepIdx);
        const title = rest.slice(sepIdx + FIELD_SEP.length);
        titleByPane.set(paneId, title);
      }
      continue;
    }

    const line = rawLine.startsWith(`C${FIELD_SEP}`) ? rawLine.slice(1 + FIELD_SEP.length) : rawLine;
    const [windowIndex, paneId, command, path, pid] = splitTmuxFields(line, 5, 3);
    panes.push({
      windowIndex: Number(windowIndex),
      paneId,
      command: commandName(command),
      path: path || '',
      pid: pid ? Number(pid) : 0,
    });
  }

  if (titleByPane.size === 0) return panes;
  return panes.map((pane) => (
    titleByPane.has(pane.paneId)
      ? { ...pane, title: titleByPane.get(pane.paneId) }
      : pane
  ));
}

/** Parses the stable address returned by `display-message -t %pane`. */
export function parsePaneAddress(output) {
  if (!output || output.trim().length === 0) return null;
  const [paneId, sessionId, sessionName, windowId, windowIndex] = splitTmuxFields(output.trim(), 5, 2);
  if (!paneId || !windowId) return null;
  return {
    paneId,
    sessionId: sessionId || sessionName,
    sessionName,
    windowId,
    windowIndex: Number(windowIndex),
  };
}

/**
 * Assembles readTree output: tagged S/W/P lines become sessions holding their
 * windows holding their panes, using the same field parsers as the single
 * list commands.
 */
export function parseTree(output) {
  const sessions = [];
  const windowsBySession = new Map();
  const panesByWindow = new Map();
  const cwdByPane = new Map();
  const titleByPane = new Map();
  const richByPane = new Map();
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const kind = line.slice(0, 1);
    const rest = line.slice(1 + FIELD_SEP.length);
    if (line.slice(1, 1 + FIELD_SEP.length) !== FIELD_SEP) continue;
    if (kind === 'S') {
      sessions.push(...parseSessions(rest));
      continue;
    }
    const cut = rest.indexOf(FIELD_SEP);
    if (cut < 0) continue;
    const parent = rest.slice(0, cut);
    const body = rest.slice(cut + FIELD_SEP.length);
    if (kind === 'D') {
      cwdByPane.set(parent, body);
      continue;
    }
    if (kind === 'T') {
      titleByPane.set(parent, body);
      continue;
    }
    if (kind === 'K') {
      const kCut = body.indexOf(FIELD_SEP);
      if (kCut >= 0) {
        const paneKind = body.slice(0, kCut);
        const panePayload = body.slice(kCut + FIELD_SEP.length);
        richByPane.set(parent, { kind: paneKind || 'terminal', payload: paneKind && paneKind !== 'terminal' ? panePayload : '' });
      }
      continue;
    }
    const map = kind === 'W' ? windowsBySession : kind === 'P' ? panesByWindow : null;
    if (!map) continue;
    const parsed = (kind === 'W' ? parseWindows : parsePanes)(body);
    if (!map.has(parent)) map.set(parent, []);
    const known = map.get(parent);
    // `list-panes -a` repeats a linked window's panes for every session holding it.
    known.push(...(kind === 'P' ? parsed.filter((pane) => !known.some((other) => other.id === pane.id)) : parsed));
  }
  return sessions.map((session) => ({
    ...session,
    windowList: (windowsBySession.get(session.id) || []).map((window) => ({
      ...window,
      panes: (panesByWindow.get(window.id) || []).map((pane) => ({
        ...pane,
        ...(cwdByPane.has(pane.id) ? { cwd: cwdByPane.get(pane.id) } : {}),
        ...(titleByPane.has(pane.id) ? { title: titleByPane.get(pane.id) } : {}),
        ...(richByPane.has(pane.id) ? richByPane.get(pane.id) : {}),
      })),
    })),
  }));
}

/** The session/window/pane tree as one chained tmux command; see parseTree. */
const TREE_COMMANDS = [
  'list-sessions', '-F', `S${FIELD_SEP}#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{session_windows}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_last_attached}`,
  ';',
  'list-windows', '-a', '-F', `W${FIELD_SEP}#{session_id}${FIELD_SEP}#{window_id}${FIELD_SEP}#{window_index}${FIELD_SEP}#{window_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{window_width}${FIELD_SEP}#{window_height}${FIELD_SEP}#{window_bell_flag}${FIELD_SEP}#{window_activity}${FIELD_SEP}#{window_zoomed_flag}${FIELD_SEP}#{window_layout}`,
  ';',
  'list-panes', '-a', '-F', `P${FIELD_SEP}#{window_id}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_index}${FIELD_SEP}#{@pane_label}`,
  ';',
  'list-panes', '-a', '-F', `D${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_path}`,
  ';',
  'list-panes', '-a', '-F', `T${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_title}`,
  ';',
  'list-panes', '-a', '-F', `K${FIELD_SEP}#{pane_id}${FIELD_SEP}#{@pane_kind}${FIELD_SEP}#{@pane_payload}`,
];

// --- Exec Wrapper ---

/**
 * Executes a tmux command with array arguments via execFile (no shell).
 * @param {string[]} args - tmux subcommand and arguments
 * @returns {Promise<string>} stdout
 */
export async function tmuxExec(args) {
  const { stdout } = await observedExec(TMUX_BIN, args, {
    timeout: EXEC_TIMEOUT,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout;
}

/**
 * Executor contract consumed by createTmuxApi:
 *   exec(command, args, options) -> Promise<{ stdout, stderr }>
 * The local executor runs execFile directly; tests substitute a recording one.
 * Arguments stay arrays — never a shell string.
 */
export const localExecutor = Object.freeze({
  id: 'local',
  transport: 'local',
  // MSYS2's tmux.exe on Windows, plain `tmux` elsewhere.
  tmuxBin: TMUX_BIN,
  async exec(command, args, options = {}) {
    const execOptions = {
      timeout: options.timeout || EXEC_TIMEOUT,
      maxBuffer: options.maxBuffer || EXEC_MAX_BUFFER,
    };
    // Only tmux is an MSYS2 program here; anything else gets Node's own quoting.
    const { stdout, stderr } = await observedExec(command, args, execOptions);
    return { stdout, stderr };
  },
});

// --- Validation Helpers ---

function requireValidSessionName(name) {
  if (!validateSessionName(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
}

function requireValidWindowName(name) {
  if (!validateWindowName(name)) {
    throw new Error(`Invalid window name: ${name}`);
  }
}

function requireValidPaneId(id) {
  if (!validatePaneId(id)) {
    throw new Error(`Invalid pane ID: ${id}`);
  }
}

function requireValidWindowIndex(index) {
  if (!validateWindowIndex(index)) {
    throw new Error(`Invalid window index: ${index}`);
  }
}

function requireValidWindowId(id) {
  if (!validateWindowId(id)) {
    throw new Error(`Invalid window ID: ${id}`);
  }
}

/**
 * Accepts either a stable session ID ($N) or a session name and returns the
 * value to pass to `-t`. Callers holding a stable ID stay correct across renames.
 */
export function sessionTarget(idOrName) {
  if (validateSessionId(idOrName)) return idOrName;
  requireValidSessionName(idOrName);
  return idOrName;
}

// --- High-Level Functions ---

/**
 * Binds every tmux operation to one executor so every caller shares a
 * single set of format strings, parsers and validation rules.
 *
 * @param {{ exec: (command: string, args: string[], options?: object) => Promise<{stdout: string, stderr: string}> }} executor
 */
export function createTmuxApi(executor) {
  if (!executor || typeof executor.exec !== 'function') {
    throw new Error('createTmuxApi requires an executor with exec()');
  }
  const bin = executor.tmuxBin || 'tmux';

  async function run(args, options) {
    const { stdout } = await executor.exec(bin, args, options);
    return stdout;
  }

  /** Window IDs are unique only within this tmux server's lifetime. */
  async function getServerInstance() {
    try {
      const value = (await run(['display-message', '-p', '#{pid}:#{start_time}'])).trim();
      if (!/^\d+:\d+$/.test(value)) throw new Error('Invalid tmux server instance');
      return value;
    } catch (err) {
      if (/no server running|no sessions|error connecting[^\n]*No such file/i.test(err?.stderr || '')) return null;
      throw err;
    }
  }

  async function listSessions() {
    try {
      const stdout = await run([
        'list-sessions',
        '-F',
        `#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{session_windows}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_last_attached}`,
      ]);
      return parseSessions(stdout);
    } catch (err) {
      // tmux server not running yet → treat as "no sessions" rather than error.
      // The web panel intentionally does not auto-start tmux; recovery is the
      // job of tmux-server.service + session protection (see CLAUDE.md).
      if (/no server running|no sessions|error connecting[^\n]*No such file/i.test(err?.stderr || '')) {
        return [];
      }
      throw err;
    }
  }

  async function listWindows(session) {
    const target = sessionTarget(session);
    const stdout = await run([
      'list-windows',
      '-t', target,
      '-F',
      `#{window_id}${FIELD_SEP}#{window_index}${FIELD_SEP}#{window_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{window_width}${FIELD_SEP}#{window_height}${FIELD_SEP}#{window_bell_flag}${FIELD_SEP}#{window_activity}${FIELD_SEP}#{window_zoomed_flag}${FIELD_SEP}#{window_layout}`,
    ]);
    return parseWindows(stdout);
  }

  /**
   * Returns the set of all live window_id values across all sessions.
   * Per-session errors are swallowed so one bad session doesn't abort the scan.
   *
   * @returns {Promise<Set<string>>}
   */
  async function listAllWindowIds() {
    const sessions = await listSessions();
    const all = new Set();
    for (const s of sessions) {
      try {
        const windows = await listWindows(s.name);
        for (const w of windows) {
          if (w.id) all.add(w.id);
        }
      } catch {
        // Skip sessions we can't read.
      }
    }
    return all;
  }

  async function unzoomWindow(session, window) {
    const target = sessionTarget(session);
    requireValidWindowIndex(window);
    try {
      const flag = await run([
        'display-message', '-p', '-t', `${target}:${window}`,
        '#{window_zoomed_flag}',
      ]);
      if (flag.trim() === '1') {
        await run(['resize-pane', '-Z', '-t', `${target}:${window}`]);
      }
    } catch {
      // Ignore — window may not exist or already unzoomed
    }
  }

  async function listPanes(session, window) {
    const target = sessionTarget(session);
    requireValidWindowIndex(window);
    const stdout = await run([
      'list-panes',
      '-t', `${target}:${window}`,
      '-F',
      `#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_index}${FIELD_SEP}#{@pane_label}`,
    ]);
    return parsePanes(stdout);
  }

  /** Panes of one window addressed by stable window ID (@N). */
  async function listPanesByWindowId(windowId) {
    requireValidWindowId(windowId);
    const stdout = await run([
      'list-panes',
      '-t', windowId,
      '-F',
      `P${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_index}${FIELD_SEP}#{@pane_label}`,
      ';',
      'list-panes',
      '-t', windowId,
      '-F',
      `D${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_path}`,
      ';',
      'list-panes',
      '-t', windowId,
      '-F',
      `T${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_title}`,
    ]);
    const lines = String(stdout || '').split('\n').filter(Boolean);
    if (!lines.some((line) => line.startsWith(`P${FIELD_SEP}`) || line.startsWith(`D${FIELD_SEP}`) || line.startsWith(`T${FIELD_SEP}`))) {
      return parsePanes(stdout);
    }
    const panes = [];
    const cwdByPane = new Map();
    const titleByPane = new Map();
    for (const line of lines) {
      if (line.startsWith(`P${FIELD_SEP}`)) {
        panes.push(...parsePanes(line.slice(1 + FIELD_SEP.length)));
      } else if (line.startsWith(`D${FIELD_SEP}`)) {
        const rest = line.slice(1 + FIELD_SEP.length);
        const cut = rest.indexOf(FIELD_SEP);
        if (cut >= 0) cwdByPane.set(rest.slice(0, cut), rest.slice(cut + FIELD_SEP.length));
      } else if (line.startsWith(`T${FIELD_SEP}`)) {
        const rest = line.slice(1 + FIELD_SEP.length);
        const cut = rest.indexOf(FIELD_SEP);
        if (cut >= 0) titleByPane.set(rest.slice(0, cut), rest.slice(cut + FIELD_SEP.length));
      }
    }
    return panes.map((pane) => ({
      ...pane,
      ...(cwdByPane.has(pane.id) ? { cwd: cwdByPane.get(pane.id) } : {}),
      ...(titleByPane.has(pane.id) ? { title: titleByPane.get(pane.id) } : {}),
    }));
  }

  async function listPaneCommands(session) {
    const target = sessionTarget(session);
    const stdout = await run([
      'list-panes', '-s', '-t', target, '-F',
      `C${FIELD_SEP}#{window_index}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}`,
      ';',
      'list-panes', '-s', '-t', target, '-F',
      `T${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_title}`,
    ]);
    return parsePaneCommands(stdout);
  }

  /** Resolve one pane without walking the complete Session/Window tree. */
  async function getPaneAddress(paneId) {
    requireValidPaneId(paneId);
    const stdout = await run([
      'display-message', '-p', '-t', paneId,
      `#{pane_id}${FIELD_SEP}#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{window_id}${FIELD_SEP}#{window_index}`,
    ]);
    return parsePaneAddress(stdout);
  }

  async function createSession(name) {
    requireValidSessionName(name);
    await run(['new-session', '-d', '-s', name, '-c', HOME_CWD]);
  }

  /** Creates a session and returns its stable session ID. */
  async function createSessionReturningId(name) {
    requireValidSessionName(name);
    const stdout = await run(['new-session', '-d', '-s', name, '-c', HOME_CWD, '-P', '-F', '#{session_id}']);
    return stdout.trim();
  }

  async function createWindow(session, name) {
    const target = sessionTarget(session);
    const args = ['new-window', '-t', target + ':', '-c', HOME_CWD, '-P', '-F', '#{window_index}'];
    if (name) {
      requireValidWindowName(name);
      args.push('-n', name);
    }
    const stdout = await run(args);
    return stdout.trim();
  }

  /** Creates a window and returns its stable window ID (@N). */
  async function createWindowReturningId(session, name) {
    const target = sessionTarget(session);
    const args = ['new-window', '-t', target + ':', '-c', HOME_CWD, '-P', '-F', '#{window_id}'];
    if (name) {
      requireValidWindowName(name);
      args.push('-n', name);
    }
    const stdout = await run(args);
    return stdout.trim();
  }

  /**
   * A split starts where the pane being split is. `-c '#{pane_current_path}'`
   * cannot say that: tmux expands it against the session's active pane, not
   * the split's target. A pane tmux cannot read starts at home, never in the
   * panel's own directory; a missing pane is left for the split to report.
   */
  async function splitCwd(paneId) {
    let path = '';
    try {
      path = (await run(['display-message', '-p', '-t', paneId, '#{pane_current_path}'])).replace(/\r?\n$/, '');
    } catch { /* the split itself fails with the real error */ }
    return path.startsWith('/') ? tmuxLiteral(path) : HOME_CWD;
  }

  async function splitPane(paneId, direction) {
    requireValidPaneId(paneId);
    const flag = direction === 'horizontal' ? '-h' : '-v';
    await run(['split-window', flag, '-t', paneId, '-c', await splitCwd(paneId)]);
  }

  /** Splits a pane and returns the new pane's stable ID (%N). */
  async function splitPaneReturningId(paneId, direction) {
    requireValidPaneId(paneId);
    const flag = direction === 'horizontal' ? '-h' : '-v';
    const stdout = await run(['split-window', flag, '-t', paneId, '-c', await splitCwd(paneId), '-P', '-F', '#{pane_id}']);
    return stdout.trim();
  }

  async function renameSession(name, newName) {
    const target = sessionTarget(name);
    requireValidSessionName(newName);
    await run(['rename-session', '-t', target, newName]);
  }

  async function renameWindow(session, index, newName) {
    const target = sessionTarget(session);
    requireValidWindowIndex(index);
    requireValidWindowName(newName);
    await run(['rename-window', '-t', `${target}:${index}`, newName]);
  }

  async function killSession(name) {
    const target = sessionTarget(name);
    await run(['kill-session', '-t', target]);
  }

  async function killWindow(session, index) {
    const target = sessionTarget(session);
    requireValidWindowIndex(index);
    await run(['kill-window', '-t', `${target}:${index}`]);
  }

  async function killPane(paneId) {
    requireValidPaneId(paneId);
    await run(['kill-pane', '-t', paneId]);
  }

  async function selectPane(paneId) {
    requireValidPaneId(paneId);
    await run(['select-pane', '-t', paneId]);
  }

  /**
   * Sets or clears a pane's custom label via the @pane_label user option.
   * Empty/nullish label clears it. tmux redraws the pane border automatically.
   */
  async function setPaneLabel(paneId, label) {
    requireValidPaneId(paneId);
    if (label == null || (typeof label === 'string' && label.trim() === '')) {
      await run(['set-option', '-pu', '-t', paneId, '@pane_label']);
      return;
    }
    if (!validatePaneLabel(label)) {
      throw new Error('Invalid pane label');
    }
    await run(['set-option', '-p', '-t', paneId, '@pane_label', label]);
  }

  /**
   * Sets or clears a pane's rich kind/payload via @pane_kind and @pane_payload.
   * Omitting kind updates @pane_payload only; setting kind to ''/'terminal' unsets both.
   */
  async function setPaneRich(paneId, { kind, payload } = {}) {
    requireValidPaneId(paneId);
    if (kind !== undefined) {
      if (kind === null || kind === '' || kind === 'terminal') {
        await run(['set-option', '-pu', '-t', paneId, '@pane_kind']).catch(() => {});
        await run(['set-option', '-pu', '-t', paneId, '@pane_payload']).catch(() => {});
        return { kind: 'terminal', payload: '' };
      }
      if (!validatePaneKind(kind)) throw new Error('Invalid pane kind');
      await run(['set-option', '-p', '-t', paneId, '@pane_kind', kind]);
    }
    let normalized;
    if (payload !== undefined) {
      normalized = normalizePanePayload(payload);
      if (normalized === null) throw new Error('Invalid pane payload');
      if (normalized === '') {
        await run(['set-option', '-pu', '-t', paneId, '@pane_payload']).catch(() => {});
      } else {
        await run(['set-option', '-p', '-t', paneId, '@pane_payload', normalized]);
      }
    }
    return { ...(kind !== undefined ? { kind } : {}), ...(normalized !== undefined ? { payload: normalized } : {}) };
  }

  /**
   * Splits a pane as a rich non-PTY tile (preferring `split-window -E`).
   * Note tmux's `-E` flag creates a commandless empty pane without spawning a shell.
   */
  async function splitRichPane(targetId, { direction = 'horizontal', kind, payload = '', label = '' } = {}) {
    requireValidPaneId(targetId);
    if (!validatePaneKind(kind) || kind === 'terminal') throw new Error('Invalid rich pane kind');
    const normalized = normalizePanePayload(payload);
    if (normalized === null) throw new Error('Invalid pane payload');
    if (label && !validatePaneLabel(label)) throw new Error('Invalid pane label');
    const flag = direction === 'vertical' ? '-v' : '-h';
    let stdout;
    try {
      stdout = await run(['split-window', '-d', '-E', flag, '-t', targetId, '-P', '-F', '#{pane_id}']);
    } catch (err) {
      if (!/unknown flag|illegal option|usage:/i.test(String(err?.stderr || err?.message || ''))) throw err;
      stdout = await run(['split-window', '-d', flag, '-t', targetId, '-P', '-F', '#{pane_id}', 'tail -f /dev/null']);
    }
    const paneId = stdout.trim();
    requireValidPaneId(paneId);
    await setPaneRich(paneId, { kind, payload: normalized });
    if (label) await setPaneLabel(paneId, label);
    return paneId;
  }

  async function sendKeys(paneId, command) {
    requireValidPaneId(paneId);
    if (typeof command !== 'string') {
      throw new Error('Command must be a string');
    }
    await run(['send-keys', '-t', paneId, command, 'Enter']);
  }

  /**
   * Types literal text into a pane and stops there: no Enter, so whoever reads
   * the pane decides whether to send it. One line only, and never something
   * tmux could take for an option.
   */
  async function typeText(paneId, text) {
    requireValidPaneId(paneId);
    if (typeof text !== 'string' || !text || /[\x00-\x1f\x7f]/.test(text) || text.startsWith('-')) {
      throw new Error('Text must be one line of printable characters');
    }
    // In copy-mode the keys would go to the mode, as commands.
    if ((await run(['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).trim() === '1') {
      throw Object.assign(new Error('The pane is in copy mode'), { code: 'PANE_IN_MODE' });
    }
    await run(['send-keys', '-t', paneId, '-l', text]);
  }

  /** Every pane on the server with its window and working directory. */
  async function listPanePaths() {
    const stdout = await run([
      'list-panes', '-a', '-F', `#{pane_id}${FIELD_SEP}#{window_id}${FIELD_SEP}#{pane_current_path}`,
    ]);
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [paneId, windowId, ...rest] = line.split(FIELD_SEP);
      return { paneId, windowId, path: rest.join(FIELD_SEP) };
    }).filter((pane) => /^%\d+$/.test(pane.paneId) && pane.path);
  }

  async function selectLayout(session, window, layout) {
    const target = sessionTarget(session);
    requireValidWindowIndex(window);
    if (!PRESET_LAYOUTS.includes(layout)) {
      throw new Error(`Invalid layout: ${layout}`);
    }
    await run(['select-layout', '-t', `${target}:${window}`, layout]);
  }

  async function resizePane(paneId, direction, amount) {
    requireValidPaneId(paneId);
    const validDirs = ['U', 'D', 'L', 'R'];
    if (!validDirs.includes(direction)) {
      throw new Error(`Invalid direction: ${direction}`);
    }
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error(`Invalid amount: ${amount}`);
    }
    await run(['resize-pane', '-t', paneId, `-${direction}`, String(amount)]);
  }

  async function resizePaneTo(paneId, { cols, rows } = {}) {
    requireValidPaneId(paneId);
    const hasCols = cols !== undefined;
    const hasRows = rows !== undefined;
    if ((!hasCols && !hasRows)
      || (hasCols && (!Number.isInteger(cols) || cols < 1 || cols > 2000))
      || (hasRows && (!Number.isInteger(rows) || rows < 1 || rows > 2000))) {
      throw new Error('Invalid pane dimensions');
    }
    const args = ['resize-pane', '-t', paneId];
    if (hasCols) args.push('-x', String(cols));
    if (hasRows) args.push('-y', String(rows));
    await run(args);
  }

  async function zoomPane(paneId, zoomed) {
    requireValidPaneId(paneId);
    if (zoomed !== undefined && typeof zoomed !== 'boolean') {
      throw new Error('zoomed must be a boolean');
    }
    const out = await run(['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}|#{pane_active}']);
    const [zFlag, aFlag] = out.trim().split('|');
    const current = zFlag === '1';
    const target = zoomed === undefined ? !current : zoomed;
    if (current !== target || (target && aFlag !== '1')) {
      if (aFlag !== '1') await run(['select-pane', '-t', paneId]);
      if (current !== target) await run(['resize-pane', '-Z', '-t', paneId]);
    }
    return target;
  }

  async function breakPane(paneId) {
    requireValidPaneId(paneId);
    const out = await run(['break-pane', '-d', '-P', '-F', `#{window_id}${FIELD_SEP}#{pane_id}`, '-s', paneId]);
    const [windowId, brokenPaneId] = out.trim().split(FIELD_SEP);
    return { windowId, paneId: brokenPaneId || paneId };
  }

  async function clearPane(paneId, { scope = 'all' } = {}) {
    requireValidPaneId(paneId);
    if (scope !== 'all' && scope !== 'history') {
      throw new Error(`Invalid clear scope: ${scope}`);
    }
    if (scope === 'all') await run(['send-keys', '-t', paneId, '-H', '0c']);
    await run(['clear-history', '-t', paneId]);
  }

  async function respawnPane(paneId) {
    requireValidPaneId(paneId);
    let cwd = '';
    try {
      cwd = (await run(['display-message', '-p', '-t', paneId, '#{pane_current_path}'])).trim();
    } catch { /* fall back to server default directory */ }
    await run(['set-option', '-p', '-u', '-t', paneId, '@pane_kind']).catch(() => {});
    await run(['set-option', '-p', '-u', '-t', paneId, '@pane_payload']).catch(() => {});
    if (cwd) {
      try {
        await run(['respawn-pane', '-k', '-c', cwd, '-t', paneId]);
        return { ok: true, paneId };
      } catch { /* directory may be missing or stale; fall back below */ }
    }
    await run(['respawn-pane', '-k', '-t', paneId]);
    return { ok: true, paneId };
  }

  async function swapPane(srcPaneId, dstPaneId) {
    requireValidPaneId(srcPaneId);
    requireValidPaneId(dstPaneId);
    await run(['swap-pane', '-s', srcPaneId, '-t', dstPaneId]);
  }

  async function capturePane(paneId, { escape = false } = {}) {
    requireValidPaneId(paneId);
    const args = ['capture-pane'];
    if (escape) args.push('-e');
    args.push('-t', paneId, '-p');
    const stdout = await run(args);
    return stdout;
  }

  /**
   * Globally enables the pane border title line so pane labels render.
   * Idempotent and best-effort — throws if no tmux server; callers should catch.
   */
  async function ensurePaneBorderConfig() {
    await run(['set-option', '-g', 'pane-border-status', 'top']);
    await run(['set-option', '-g', 'pane-border-format', PANE_BORDER_FORMAT]);
  }

  /**
   * Lets programs in new panes emit OSC 8 hyperlinks (lib/terminal/hyperlinks.js).
   * Idempotent and best-effort like the border configuration: it throws without
   * a tmux server, and a value already in the environment is left alone.
   */
  async function ensureHyperlinkEnvironment() {
    await run([...HYPERLINK_ENV_COMMAND]);
  }

  // --- by-id helpers (use window_id @N — stable across renames/moves/renumbers) ---

  async function renameWindowById(windowId, newName) {
    requireValidWindowId(windowId);
    requireValidWindowName(newName);
    await run(['rename-window', '-t', windowId, newName]);
  }

  async function killWindowById(windowId) {
    requireValidWindowId(windowId);
    await run(['kill-window', '-t', windowId]);
  }

  async function selectLayoutById(windowId, layout) {
    requireValidWindowId(windowId);
    if (!PRESET_LAYOUTS.includes(layout)) throw new Error(`Invalid layout: ${layout}`);
    await run(['select-layout', '-t', windowId, layout]);
  }

  /** The window's size in cells. */
  async function windowSizeById(windowId) {
    requireValidWindowId(windowId);
    const [width, height] = (await run(['display-message', '-p', '-t', windowId, '#{window_width} #{window_height}']))
      .trim().split(' ').map(Number);
    return { width, height };
  }

  async function moveWindowById(windowId, dstSession) {
    requireValidWindowId(windowId);
    if (validateSessionId(dstSession)) {
      await run(['move-window', '-s', windowId, '-t', dstSession + ':']);
      return;
    }
    requireValidSessionName(dstSession);
    // '=<name>:' forces exact-name match (no prefix collision like foo vs foobar).
    await run(['move-window', '-s', windowId, '-t', '=' + dstSession + ':']);
  }

  /**
   * The whole session/window/pane tree in ONE tmux invocation, chained with
   * `;`. Locally this is just fewer processes; for a host reached by plain
   * SSH it turns a sidebar refresh into a single round trip. Each line is
   * tagged with its kind and parent id, then fed to the usual parsers.
   */
  async function readTree() {
    let stdout;
    try {
      stdout = await run(TREE_COMMANDS);
    } catch (err) {
      // No server, or a server with no sessions: -a has nothing to target.
      if (typeof err?.stderr === 'string' && /no server running|no current target|no sessions/.test(err.stderr)) return [];
      throw err;
    }
    return parseTree(stdout);
  }

  /**
   * readTree plus the server it came from, in the same invocation: one client
   * talks to one server, so a restart cannot fall between the two. null when this
   * tmux or this moment cannot answer like that; the caller then reads piece by
   * piece, which can report a failure per session.
   */
  async function readSnapshot() {
    let stdout;
    try {
      stdout = await run(['display-message', '-p', `I${FIELD_SEP}#{pid}:#{start_time}`, ';', ...TREE_COMMANDS]);
    } catch (err) {
      if (/no server running|no sessions|error connecting[^\n]*No such file/i.test(err?.stderr || '')) {
        return { instanceId: null, sessions: [] };
      }
      return null;
    }
    const line = String(stdout).split('\n').find((text) => text.startsWith(`I${FIELD_SEP}`));
    const instanceId = line ? line.slice(1 + FIELD_SEP.length).trim() : '';
    if (!/^\d+:\d+$/.test(instanceId)) return null;
    const sessions = parseTree(stdout);
    // Without session ids (old tmux) windows cannot be matched to their sessions.
    return sessions.every((session) => session.id) ? { instanceId, sessions } : null;
  }

  /**
   * Batches listSessions + listWindows(-a) + listPaneCommands(-a) into one
   * tmux invocation so status/metrics polling avoids 1 + 2N subprocess spawns.
   */
  async function snapshotServerState() {
    let stdout;
    try {
      stdout = await run([
        'list-sessions', '-F',
        `S${FIELD_SEP}#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{session_windows}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_last_attached}`,
        ';',
        'list-windows', '-a', '-F',
        `W${FIELD_SEP}#{session_id}${FIELD_SEP}#{window_id}${FIELD_SEP}#{window_index}${FIELD_SEP}#{window_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{window_width}${FIELD_SEP}#{window_height}${FIELD_SEP}#{window_bell_flag}${FIELD_SEP}#{window_activity}${FIELD_SEP}#{window_zoomed_flag}${FIELD_SEP}#{window_layout}`,
        ';',
        'list-panes', '-a', '-F',
        `C${FIELD_SEP}#{session_id}${FIELD_SEP}#{window_index}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}`,
        ';',
        'list-panes', '-a', '-F',
        `T${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_title}`,
      ]);
    } catch (err) {
      if (/no server running|no sessions|error connecting[^\n]*No such file/i.test(err?.stderr || '')) {
        return { sessions: [], windowsBySession: new Map(), paneCommandsBySession: new Map() };
      }
      throw err;
    }

    const sessionLines = [];
    const windowLinesBySession = new Map();
    const cmdLinesBySession = new Map();
    const titleByPane = new Map();

    for (const line of String(stdout || '').split('\n')) {
      if (!line) continue;
      if (line.startsWith(`S${FIELD_SEP}`)) {
        sessionLines.push(line.slice(1 + FIELD_SEP.length));
        continue;
      }
      if (line.startsWith(`T${FIELD_SEP}`)) {
        const rest = line.slice(1 + FIELD_SEP.length);
        const cut = rest.indexOf(FIELD_SEP);
        if (cut > 0) titleByPane.set(rest.slice(0, cut), rest.slice(cut + FIELD_SEP.length));
        continue;
      }
      if (line.startsWith(`W${FIELD_SEP}`) || line.startsWith(`C${FIELD_SEP}`)) {
        const kind = line[0];
        const rest = line.slice(1 + FIELD_SEP.length);
        const cut = rest.indexOf(FIELD_SEP);
        if (cut < 0) continue;
        const sid = rest.slice(0, cut);
        const body = rest.slice(cut + FIELD_SEP.length);
        const target = kind === 'W' ? windowLinesBySession : cmdLinesBySession;
        let list = target.get(sid);
        if (!list) {
          list = [];
          target.set(sid, list);
        }
        list.push(body);
      }
    }

    const sessions = parseSessions(sessionLines.join('\n'));
    const windowsBySession = new Map();
    const paneCommandsBySession = new Map();
    for (const [sid, lines] of windowLinesBySession) {
      windowsBySession.set(sid, parseWindows(lines.join('\n')));
    }
    for (const [sid, lines] of cmdLinesBySession) {
      const panes = parsePaneCommands(lines.join('\n'));
      paneCommandsBySession.set(sid, titleByPane.size === 0 ? panes : panes.map((p) => (
        titleByPane.has(p.paneId) ? { ...p, title: titleByPane.get(p.paneId) } : p
      )));
    }
    return { sessions, windowsBySession, paneCommandsBySession };
  }

  /** Reads the tmux server version, e.g. "3.5a". Throws if tmux is unusable. */
  async function version() {
    const stdout = await run(['-V']);
    const match = /tmux\s+(?:next-)?([0-9]+\.[0-9]+[a-z]?)/i.exec(stdout.trim());
    return match ? match[1] : null;
  }

  return {
    executor,
    run,
    getServerInstance,
    readTree,
    readSnapshot,
    snapshotServerState,
    listSessions,
    listWindows,
    listAllWindowIds,
    unzoomWindow,
    listPanes,
    listPanesByWindowId,
    listPaneCommands,
    getPaneAddress,
    createSession,
    createSessionReturningId,
    createWindow,
    createWindowReturningId,
    splitPane,
    splitPaneReturningId,
    splitRichPane,
    renameSession,
    renameWindow,
    killSession,
    killWindow,
    killPane,
    selectPane,
    setPaneLabel,
    setPaneRich,
    sendKeys,
    typeText,
    listPanePaths,
    selectLayout,
    resizePane,
    resizePaneTo,
    zoomPane,
    breakPane,
    clearPane,
    respawnPane,
    swapPane,
    capturePane,
    ensurePaneBorderConfig,
    ensureHyperlinkEnvironment,
    renameWindowById,
    killWindowById,
    selectLayoutById,
    windowSizeById,
    moveWindowById,
    version,
  };
}

// Border title shown by tmux on each pane's top border (pane-border-status top).
// Keep title text in the terminal foreground. Only the leading marker uses
// theme-resolved ANSI colors; no global border style or user option is replaced.
// The command goes through the same reduction as commandName(), in tmux's terms.
export const PANE_BORDER_FORMAT =
  '#{?pane_active,#[fg=colour4]▸#[default]#[bold],#[fg=colour8]·#[default]} #{?#{@pane_label},[#{@pane_label}] ,}#{pane_index}:#{s|\\.exe$||:#{s|^.*[\\\\/]||:pane_current_command}} #[default]';

// This machine's tmux. Most callers import the named exports below; services
// that take a tmux API as a dependency get the object itself.
const local = createTmuxApi(localExecutor);
export const localTmux = local;

export const snapshotServerState = (...args) => local.snapshotServerState(...args);
export const listSessions = (...args) => local.listSessions(...args);
export const listWindows = (...args) => local.listWindows(...args);
export const listAllWindowIds = (...args) => local.listAllWindowIds(...args);
export const unzoomWindow = (...args) => local.unzoomWindow(...args);
export const listPanes = (...args) => local.listPanes(...args);
export const listPanesByWindowId = (...args) => local.listPanesByWindowId(...args);
export const listPaneCommands = (...args) => local.listPaneCommands(...args);
export const getPaneAddress = (...args) => local.getPaneAddress(...args);
export const createSession = (...args) => local.createSession(...args);
export const createWindow = (...args) => local.createWindow(...args);
export const splitPane = (...args) => local.splitPane(...args);
export const renameSession = (...args) => local.renameSession(...args);
export const renameWindow = (...args) => local.renameWindow(...args);
export const killSession = (...args) => local.killSession(...args);
export const killWindow = (...args) => local.killWindow(...args);
export const killPane = (...args) => local.killPane(...args);
export const selectPane = (...args) => local.selectPane(...args);
export const setPaneLabel = (...args) => local.setPaneLabel(...args);
export const setPaneRich = (...args) => local.setPaneRich(...args);
export const splitRichPane = (...args) => local.splitRichPane(...args);
export const sendKeys = (...args) => local.sendKeys(...args);
export const selectLayout = (...args) => local.selectLayout(...args);
export const resizePane = (...args) => local.resizePane(...args);
export const resizePaneTo = (...args) => local.resizePaneTo(...args);
export const zoomPane = (...args) => local.zoomPane(...args);
export const breakPane = (...args) => local.breakPane(...args);
export const clearPane = (...args) => local.clearPane(...args);
export const respawnPane = (...args) => local.respawnPane(...args);
export const swapPane = (...args) => local.swapPane(...args);
export const capturePane = (...args) => local.capturePane(...args);
export const ensurePaneBorderConfig = (...args) => local.ensurePaneBorderConfig(...args);
export const ensureHyperlinkEnvironment = (...args) => local.ensureHyperlinkEnvironment(...args);
export const renameWindowById = (...args) => local.renameWindowById(...args);
export const killWindowById = (...args) => local.killWindowById(...args);
export const selectLayoutById = (...args) => local.selectLayoutById(...args);
export const windowSizeById = (...args) => local.windowSizeById(...args);
export const moveWindowById = (...args) => local.moveWindowById(...args);
export const tmuxVersion = (...args) => local.version(...args);
