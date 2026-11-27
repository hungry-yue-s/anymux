/**
 * Session protection: keeps tmux sessions across tmux restarts and reboots.
 *
 * The node drives it, so nothing has to be added to ~/.tmux.conf:
 * - every few minutes it runs tmux-resurrect's save.sh (standard snapshots, so
 *   prefix + Ctrl-s / Ctrl-r keep working in a terminal);
 * - the first time it sees a tmux server instance that has no sessions, it
 *   restores the latest snapshot with the panel's own restore (restore.js) and
 *   records that on the server, so the page can say it happened;
 * - a snapshot never replaces the latest one while tmux has no sessions,
 *   because that empty save is what would be restored after the next reboot.
 *
 * When the user's own tmux config already loads tmux-resurrect (often with
 * tmux-continuum through TPM), that setup stays in charge: the panel only
 * reports, saves on request and restores single sessions from history.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { AppError, ErrorCode } from '../servers/errors.js';
import { IS_WINDOWS, MSYS_ROOT, TMUX_BIN, msysExecArgs, tmuxUserHome, toNativePath, toPosixPath } from '../msys.js';
import { shellQuote } from '../transport/ssh-connection.js';
import { isShellCommand } from '../agent-status.js';
import { validatePaneLabel } from '../tmux.js';
import {
  DEFAULT_PROGRAMS, ambiguousAgentCwdKeys, canonicalAgentType, choiceList,
  exactAgentResumeCommand, isSafeAgentSessionId, isValidChoice, paneAgentInfo,
  paneProgramName, programName, resurrectProcessOptions,
} from './catalog.js';
import { freeName, restoreSession } from './restore.js';
import { isUsable, listSnapshots, parseSnapshot, readLatest, readSnapshot, repairLast, summarize } from './snapshot.js';
import { replaceFile } from '../atomic-file.js';
import { HYPERLINK_ENV_COMMAND } from '../terminal/hyperlinks.js';

const execFileAsync = promisify(execFile);

export const SAVE_INTERVAL_MS = 5 * 60 * 1000;
const TICK_MS = 20 * 1000;
/** A server younger than this was just (re)started, whatever sessions it already has. */
const FRESH_SERVER_MS = 2 * 60 * 1000;
const SEP = '=:=';
const SETTINGS_FILE = 'session-protection.json';
const MAX_PROGRAMS = 64;

// Server-scoped tmux options: they vanish with the server, which is the point.
const OPT_SEEN = '@anymux-protect-seen';
const OPT_RESTORED_AT = '@anymux-restored-at';
const OPT_RESTORED_FROM = '@anymux-restored-from';
const OPT_RESTORED_SESSIONS = '@anymux-restored-sessions';
// The same marks as a panel installed before the rename left them on a server
// that is still running; read after the current ones, never written.
const LEGACY_OPTIONS = ['@twp-protect-seen', '@twp-restored-at', '@twp-restored-from', '@twp-restored-sessions'];

const INFO_FORMAT = [
  '#{pid}', '#{start_time}', '#{default-shell}', `#{${OPT_SEEN}}`,
  `#{${OPT_RESTORED_AT}}`, `#{${OPT_RESTORED_FROM}}`, `#{${OPT_RESTORED_SESSIONS}}`,
  '#{@resurrect-save-script-path}', '#{@resurrect-dir}', '#{@continuum-restore}',
  ...LEGACY_OPTIONS.map((option) => `#{${option}}`),
].join(SEP);

function isNoServer(err) {
  const text = `${err && err.stderr ? err.stderr : ''} ${err && err.message ? err.message : ''}`;
  return /no server running|error connecting to|server exited unexpectedly|No such file or directory \(/i.test(text);
}

export class SessionProtection {
  /**
   * @param {object} deps
   * @param {string} deps.configDir
   * @param {string} deps.projectDir
   * @param {import('../managed-resources.js').ManagedResources} [deps.baseConfig] the panel's tmux.conf fragment
   */
  constructor({
    configDir, projectDir, baseConfig = null, tmuxBin = TMUX_BIN, windows = IS_WINDOWS,
    exec = (file, args, options) => execFileAsync(file, ...msysExecArgs(args, { ...options, argv0: file })), now = () => Date.now(),
    home = null, userConfigPath = null, intervalMs = SAVE_INTERVAL_MS, tickMs = TICK_MS,
  }) {
    this.configDir = configDir;
    this.baseConfig = baseConfig;
    this.tmuxBin = tmuxBin;
    this.windows = windows;
    this._exec = exec;
    this._now = now;
    this._fallbackHome = home;
    this.userConfigPath = userConfigPath;
    this.intervalMs = intervalMs;
    this.tickMs = tickMs;
    this.pluginDir = join(projectDir, 'vendor', 'tmux-plugins', 'tmux-resurrect');
    this.settings = { enabled: true, programs: [...DEFAULT_PROGRAMS] };
    this.lastSave = null;
    this._lastSaveAt = 0;
    this._lastAugmentedMtime = 0;
    this._externalResumedByPid = new Map();
    this._externalLabelsRestoredByPid = new Map();
    this._timer = null;
    this._queue = Promise.resolve();
  }

  // --- paths as tmux and as Node see them ---

  /** A native path as the tmux side (bash under MSYS2 on Windows) spells it. */
  _tmuxPath(nativePath) {
    return this.windows ? toPosixPath(nativePath, MSYS_ROOT) : nativePath;
  }

  _nativePath(tmuxPath) {
    return this.windows ? toNativePath(tmuxPath, MSYS_ROOT) : tmuxPath;
  }

  /** Where ~ is for tmux while no server tells us: see tmuxUserHome. */
  defaultHome() {
    return this._fallbackHome || tmuxUserHome({ windows: this.windows });
  }

  /** resurrect's own rule: ~/.tmux/resurrect if it exists, else the XDG data dir. */
  snapshotDir(home, option = '') {
    if (option) {
      const expanded = option.replace(/^~(?=\/|$)/, '$HOME').replace(/\$HOME/g, this._tmuxPath(home));
      return this._nativePath(expanded);
    }
    const legacy = join(home, '.tmux', 'resurrect');
    return existsSync(legacy) ? legacy : join(home, '.local', 'share', 'tmux', 'resurrect');
  }

  // --- settings ---

  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.configDir, SETTINGS_FILE), 'utf8'));
      if (typeof saved.enabled === 'boolean') this.settings.enabled = saved.enabled;
      if (Array.isArray(saved.programs)) this.settings.programs = saved.programs.filter(isValidChoice);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[session-protection] settings unreadable, using defaults:', err.message);
    }
  }

  async _persist() {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const file = join(this.configDir, SETTINGS_FILE);
    await writeFile(file + '.tmp', JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    await replaceFile(file + '.tmp', file);
  }

  async update(patch = {}) {
    const next = { ...this.settings };
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new AppError(ErrorCode.VALIDATION_ERROR, 'enabled must be a boolean');
      next.enabled = patch.enabled;
    }
    if (patch.programs !== undefined) {
      if (!Array.isArray(patch.programs) || patch.programs.length > MAX_PROGRAMS || !patch.programs.every(isValidChoice)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'programs must be a list of known program choices');
      }
      next.programs = [...new Set(patch.programs)];
    }
    this.settings = next;
    await this._persist();
    // Options are re-applied to a running server at once, not at the next tick.
    await this._serial(async () => {
      const env = await this._inspect();
      if (env.running && env.mode === 'managed') await this._applyOptions(env);
    });
    return this.status();
  }

  // --- tmux ---

  async _tmux(args, { timeout = 10000 } = {}) {
    const { stdout } = await this._exec(this.tmuxBin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return String(stdout);
  }

  /** One round trip for everything a decision needs. */
  async _inspect() {
    const env = { available: true, running: false, mode: 'managed', home: this.defaultHome() };
    let out;
    try {
      out = await this._tmux(['display-message', '-p', INFO_FORMAT, ';', 'show-environment', '-g', 'HOME', ';', 'show-options', '-gqv', 'status-right']);
    } catch (err) {
      if (err && err.code === 'ENOENT') env.available = false;
      else if (!isNoServer(err)) throw err;
      env.mode = !env.available ? 'unavailable' : (await this._userConfigLoadsPlugins()) ? 'external' : 'managed';
      env.dir = this.snapshotDir(env.home);
      return env;
    }
    const lines = out.split(/\r?\n/);
    const [pid, startTime, defaultShell, currentSeen, currentAt, currentFrom, currentSessions, scriptPath, dirOption, continuumRestore,
      legacySeen, legacyAt, legacyFrom, legacySessions] = lines[0].split(SEP);
    const seen = currentSeen || legacySeen;
    const [restoredAt, restoredFrom, restoredSessions] = currentAt
      ? [currentAt, currentFrom, currentSessions] : [legacyAt, legacyFrom, legacySessions];
    const homeLine = lines.find((line) => line.startsWith('HOME='));
    if (homeLine) env.home = this._nativePath(homeLine.slice(5));
    Object.assign(env, {
      running: true,
      pid,
      startedAt: Number(startTime) ? new Date(Number(startTime) * 1000).toISOString() : null,
      defaultShell: programName(defaultShell),
      seen: seen || '',
      restored: restoredAt ? { at: restoredAt, from: restoredFrom || null, sessions: Number(restoredSessions) || 0 } : null,
    });
    const ours = this._tmuxPath(this.pluginDir);
    const theirs = Boolean(scriptPath) && !scriptPath.startsWith(ours);
    env.mode = theirs ? 'external' : 'managed';
    // On Windows HOME depends on who started the server: the task gets the MSYS
    // home, a tmux typed in PowerShell the profile directory. Saves stay in one
    // place, or a server started the other way finds nothing to restore.
    if (this.windows && !theirs) env.home = this.defaultHome();
    env.scriptPath = scriptPath || '';
    env.external = theirs ? {
      scriptPath,
      continuum: continuumRestore !== '' || lines.slice(1).some((line) => line.includes('continuum_save')),
    } : null;
    env.dir = this.snapshotDir(env.home, theirs ? dirOption : '');
    return env;
  }

  async _userConfigLoadsPlugins() {
    if (!this.userConfigPath) return false;
    try {
      const text = await readFile(this.userConfigPath, 'utf8');
      return text.split(/\r?\n/).some((line) => /^[^#]*tmux-(resurrect|continuum)/.test(line));
    } catch {
      return false;
    }
  }

  async _sessions() {
    try {
      return (await this._tmux(['list-sessions', '-F', '#{session_name}'])).split(/\r?\n/).filter(Boolean);
    } catch (err) {
      if (isNoServer(err)) return [];
      throw err;
    }
  }

  async _applyOptions(env) {
    const processes = resurrectProcessOptions(this.settings.programs);
    const args = [
      'set-option', '-g', '@resurrect-dir', this._tmuxPath(env.dir), ';',
      'set-option', '-g', '@resurrect-default-processes', processes.defaultProcesses, ';',
      'set-option', '-g', '@resurrect-processes', processes.processes,
    ];
    if (this.windows) {
      args.push(';', 'set-option', '-g', '@resurrect-save-command-strategy', 'msys_procfs');
      // New panes start from this environment. A tmux typed in PowerShell does not
      // have it, and its login shells would drop claude, Node and Git from PATH.
      args.push(';', 'set-environment', '-g', 'MSYS2_PATH_TYPE', 'inherit');
    }
    await this._tmux(args);
    // Before any restore: the programs it reopens (claude --continue) are the
    // ones whose links this is for (lib/terminal/hyperlinks.js). On its own,
    // so that a tmux refusing it does not hold the options or the restore back.
    await this._tmux([...HYPERLINK_ENV_COMMAND]).catch(() => {});
  }

  _script(name) {
    return 'bash ' + shellQuote(this._tmuxPath(join(this.pluginDir, name)));
  }

  /** Runs one task at a time: a save must never see a restore half done. */
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  // --- the periodic decision ---

  start() {
    if (this._timer) return;
    const tick = () => this.tick().catch((err) => console.error('[session-protection]', err.message));
    this._timer = setInterval(tick, this.tickMs);
    if (this._timer.unref) this._timer.unref();
    tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.running) return;
      if (env.mode === 'external') {
        await this._handleExternalTick(env);
        return;
      }
      if (env.mode !== 'managed') return;
      await this._prepare(env);
      if (!env.seen) await this._firstSight(env);
      if (this.settings.enabled && this._now() - this._lastSaveAt >= this.intervalMs) {
        if ((await this._sessions()).length > 0) await this._save(env);
      }
    });
  }

  /**
   * Options and key bindings, once per server instance and per run of this
   * process; retried on the next tick if tmux refused them.
   */
  async _prepare(env) {
    if (this._preparedFor === env.pid) return;
    // An empty save left by an older panel would also be what resurrect's own
    // restore key brings back.
    await repairLast(env.dir).catch((err) => console.error('[session-protection] could not repair the last save:', err.message));
    await this._applyOptions(env);
    // Key bindings (prefix + Ctrl-s / Ctrl-r) for people working in a terminal.
    if (!env.scriptPath) await this._tmux(['run-shell', '-b', this._script('resurrect.tmux')]).catch(() => {});
    this._preparedFor = env.pid;
  }

  /**
   * The first look at a tmux server instance decides, once, whether to
   * restore. It is marked before restoring: a restore that fails half way is
   * better left alone than repeated into duplicate sessions.
   */
  async _firstSight(env) {
    await this._tmux(['set-option', '-g', OPT_SEEN, String(env.pid || 1)]);
    if (!this.settings.enabled) return;
    const current = await this._sessions();
    // A server that has been up for a while was there before us; leave it alone.
    if (current.length > 0 && !this._justStarted(env)) return;
    const latest = await readLatest(env.dir);
    if (!latest) return;
    // Something can get in first on a new server, like a tmux typed in a terminal.
    // Its session must not cost the saved ones: the next save replaces `last`.
    const missing = latest.snapshot.sessions.filter((session) => !current.includes(session.name));
    if (missing.length === 0) return;
    const restored = await this._restoreAll({ ...latest.snapshot, sessions: missing }, env);
    console.log(`[session-protection] new tmux server ${env.pid}: restored ${restored} of ${missing.length} sessions saved at ${latest.at}`);
    await this._tmux([
      'set-option', '-g', OPT_RESTORED_AT, new Date(this._now()).toISOString(), ';',
      'set-option', '-g', OPT_RESTORED_FROM, latest.at, ';',
      'set-option', '-g', OPT_RESTORED_SESSIONS, String(restored),
    ]);
    // Programs just reopened may not be running yet; a save now would forget them.
    this._lastSaveAt = this._now();
  }

  _justStarted(env) {
    const age = this._now() - Date.parse(env.startedAt);
    return age >= 0 && age < FRESH_SERVER_MS;
  }

  async _restoreAll(snapshot, env) {
    const taken = new Set(await this._sessions());
    const ambiguousCwdKeys = ambiguousAgentCwdKeys(snapshot.sessions, env.defaultShell);
    let count = 0;
    for (const session of snapshot.sessions) {
      const name = freeName(session.name, taken);
      try {
        await restoreSession((args) => this._tmux(args), session, {
          name, programs: this.settings.programs, defaultShell: env.defaultShell, ambiguousCwdKeys,
        });
        taken.add(name);
        count += 1;
      } catch (err) {
        console.error(`[session-protection] could not restore session ${session.name}:`, err.message);
      }
    }
    return count;
  }

  async _save(env) {
    const script = env.mode === 'external' ? shellQuote(env.external.scriptPath) : this._script('scripts/save.sh');
    try {
      await this._tmux(['run-shell', `${script} quiet`], { timeout: 120000 });
      // Sessions were there a moment ago, so a save without any means tmux
      // stopped answering half way. It must not become what a new server restores.
      const kept = env.mode === 'managed' ? await repairLast(env.dir) : null;
      if (kept) throw new Error(`tmux did not answer during the save; kept the save from ${kept.at}`);
      await this._augmentLatestSnapshot(env);
      this.lastSave = { at: new Date(this._now()).toISOString(), ok: true };
    } catch (err) {
      this.lastSave = { at: new Date(this._now()).toISOString(), ok: false, error: String(err.stderr || err.message).trim().slice(0, 300) };
    }
    this._lastSaveAt = this._now();
    return this.lastSave;
  }

  async _augmentLatestSnapshot(env) {
    await this._appendRichPanes(env).catch((err) => console.error('[session-protection] rich pane snapshot append failed:', err.message));
    await this._appendAgentPanes(env).catch((err) => console.error('[session-protection] agent pane snapshot append failed:', err.message));
    await this._appendPaneLabels(env).catch((err) => console.error('[session-protection] pane label snapshot append failed:', err.message));
    const latestStat = await stat(join(env.dir, 'last')).catch(() => null);
    if (latestStat) this._lastAugmentedMtime = latestStat.mtimeMs;
  }

  async _patchSnapshotSection(dir, prefix, lines, { preserveMtime = false } = {}) {
    let targetFile = join(dir, 'last');
    try {
      const linkTarget = await readlink(targetFile);
      targetFile = resolve(dirname(targetFile), linkTarget);
    } catch { /* plain file copy on Windows or no symlink */ }
    const prevStat = preserveMtime ? await stat(targetFile).catch(() => null) : null;
    let existing;
    try {
      existing = await readFile(targetFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const rawLines = existing.split(/\r?\n/);
    const clean = rawLines.filter((line) => line && !line.startsWith(prefix + '\t'));
    const hadOld = clean.length !== rawLines.filter(Boolean).length;
    if (!lines.length && !hadOld) return;
    const nextContent = [...clean, ...lines].join('\n') + '\n';
    const tempFile = `${targetFile}.anymux-${prefix}-${process.pid}`;
    await writeFile(tempFile, nextContent, { mode: 0o600 });
    await replaceFile(tempFile, targetFile);
    if (preserveMtime && prevStat) {
      await utimes(targetFile, prevStat.atime, prevStat.mtime).catch(() => {});
    }
  }

  async _appendRichPanes(env) {
    const out = await this._tmux([
      'list-panes', '-a', '-F', '#{session_name}\t#{window_index}\t#{pane_index}\t#{@pane_kind}\t#{@pane_payload}',
    ]).catch(() => '');
    const richLines = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const [session, winIdx, paneIdx, kind, ...rest] = line.split('\t');
      if (!session || !kind || kind === 'terminal') continue;
      const payload = rest.join('\t').replace(/[\r\n]/g, ' ');
      richLines.push(['rich_pane', session, winIdx, paneIdx, kind, ':' + payload].join('\t'));
    }
    await this._patchSnapshotSection(env.dir, 'rich_pane', richLines);
  }

  async _appendAgentPanes(env) {
    const out = await this._tmux([
      'list-panes', '-a', '-F',
      '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{@anymux_agent_type}\t#{@anymux_agent_session}',
    ]).catch(() => '');
    const agentLines = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length < 6) continue;
      const [session, winIdx, paneIdx, paneCommand, agentTypeOpt, ...rest] = fields;
      if (!session || isShellCommand(paneCommand)) continue;
      const cmdAgent = canonicalAgentType(programName(paneCommand));
      const optAgent = canonicalAgentType(agentTypeOpt);
      const agentType = cmdAgent || optAgent;
      if (!agentType) continue;
      const rawSid = rest.join('\t').trim();
      const mismatched = Boolean(cmdAgent && optAgent && cmdAgent !== optAgent);
      const sessionId = !mismatched && isSafeAgentSessionId(rawSid) ? rawSid : '';
      agentLines.push(['agent_pane', session, winIdx, paneIdx, agentType, ':' + sessionId].join('\t'));
    }
    await this._patchSnapshotSection(env.dir, 'agent_pane', agentLines);
  }

  async _appendPaneLabels(env, { preserveMtime = false } = {}) {
    const out = await this._tmux([
      'list-panes', '-a', '-F', '#{session_name}\t#{window_index}\t#{pane_index}\t#{@pane_label}',
    ]).catch(() => '');
    const labelLines = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const [session, winIdx, paneIdx, ...rest] = line.split('\t');
      if (!session || winIdx === undefined || paneIdx === undefined) continue;
      const rawLabel = rest.join('\t').replace(/[\r\n]+/g, ' ').trim();
      if (!rawLabel || !validatePaneLabel(rawLabel)) continue;
      labelLines.push(['pane_label', session, winIdx, paneIdx, ':' + rawLabel].join('\t'));
    }
    await this._patchSnapshotSection(env.dir, 'pane_label', labelLines, { preserveMtime });
  }

  async _handleExternalTick(env) {
    const sessions = await this._sessions();
    if (sessions.length === 0) return;
    if (this._justStarted(env)) {
      if (this.settings.enabled) {
        await this._restoreExternalPaneLabels(env).catch((err) => {
          console.error('[session-protection] external pane label restore failed:', err.message);
        });
        if (this.settings.programs.includes('ai')) {
          await this._resumeExternalAgents(env).catch((err) => {
            console.error('[session-protection] external agent resume failed:', err.message);
          });
        }
      }
      return;
    }
    const lastFile = join(env.dir, 'last');
    const st = await stat(lastFile).catch(() => null);
    if (!st || st.mtimeMs <= this._lastAugmentedMtime) return;
    const text = await readFile(lastFile, 'utf8').catch(() => '');
    if (!isUsable(parseSnapshot(text))) return;
    await this._augmentLatestSnapshot(env);
  }

  async _restoreExternalPaneLabels(env) {
    let seenPanes = this._externalLabelsRestoredByPid.get(env.pid);
    if (!seenPanes) {
      seenPanes = new Set();
      this._externalLabelsRestoredByPid.set(env.pid, seenPanes);
    }
    const latest = await readLatest(env.dir).catch(() => null);
    if (!latest?.snapshot?.sessions?.length) return 0;
    const savedLabels = new Map();
    for (const session of latest.snapshot.sessions) {
      for (const win of session.windows) {
        for (const pane of win.panes) {
          if (pane.label && validatePaneLabel(pane.label)) {
            savedLabels.set(`${session.name}\t${win.index}\t${pane.index}`, {
              label: pane.label,
              path: pane.path || '',
            });
          }
        }
      }
    }
    if (savedLabels.size === 0) return 0;
    const liveOut = await this._tmux([
      'list-panes', '-a', '-F',
      '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_path}\t#{@pane_label}',
    ]).catch(() => '');
    let restored = 0;
    for (const line of liveOut.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length < 6) continue;
      const [sessionName, winIdx, paneIdx, paneId, panePath, ...rest] = fields;
      if (!paneId || seenPanes.has(paneId)) continue;
      seenPanes.add(paneId);
      const saved = savedLabels.get(`${sessionName}\t${winIdx}\t${paneIdx}`);
      if (!saved) continue;
      const existingLabel = rest.join('\t').trim();
      if (existingLabel) continue;
      if (saved.path && panePath && saved.path !== panePath) continue;
      await this._tmux(['set-option', '-p', '-t', paneId, '@pane_label', saved.label]).catch(() => {});
      restored += 1;
    }
    return restored;
  }

  async _resumeExternalAgents(env) {
    let seenPanes = this._externalResumedByPid.get(env.pid);
    if (!seenPanes) {
      seenPanes = new Set();
      this._externalResumedByPid.set(env.pid, seenPanes);
    }
    const latest = await readLatest(env.dir).catch(() => null);
    if (!latest?.snapshot?.sessions?.length) return 0;
    const savedMap = new Map();
    for (const session of latest.snapshot.sessions) {
      for (const win of session.windows) {
        for (const pane of win.panes) {
          savedMap.set(`${session.name}\t${win.index}\t${pane.index}`, pane);
        }
      }
    }
    const ambiguous = ambiguousAgentCwdKeys(latest.snapshot.sessions, env.defaultShell);
    const liveOut = await this._tmux([
      'list-panes', '-a', '-F',
      '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{@anymux_agent_resumed}',
    ]).catch(() => '');
    let resumed = 0;
    for (const line of liveOut.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length < 7) continue;
      const [sessionName, winIdx, paneIdx, paneId, paneCommand, panePath, resumedOpt] = fields;
      if (!paneId || seenPanes.has(paneId) || resumedOpt === '1') continue;
      const savedPane = savedMap.get(`${sessionName}\t${winIdx}\t${paneIdx}`);
      if (!savedPane || !isShellCommand(paneCommand)) continue;
      if (savedPane.path && panePath && savedPane.path !== panePath) continue;
      const agentInfo = paneAgentInfo(savedPane, env.defaultShell);
      if (!agentInfo) continue;
      const allowFallback = Boolean(agentInfo.sessionId)
        || !ambiguous.has(`${agentInfo.type}\0${savedPane.path || ''}`);
      const command = exactAgentResumeCommand(agentInfo, { allowFallback });
      seenPanes.add(paneId);
      if (!command) continue;
      await this._tmux(['send-keys', '-t', paneId, '-l', command]);
      await this._tmux(['send-keys', '-t', paneId, 'Enter']);
      const optionArgs = ['set-option', '-p', '-t', paneId, '@anymux_agent_resumed', '1'];
      if (isSafeAgentSessionId(agentInfo.sessionId)) {
        optionArgs.push(
          ';', 'set-option', '-p', '-t', paneId, '@anymux_agent_type', agentInfo.type,
          ';', 'set-option', '-p', '-t', paneId, '@anymux_agent_session', agentInfo.sessionId,
        );
      }
      await this._tmux(optionArgs).catch(() => {});
      resumed += 1;
    }
    return resumed;
  }

  syncPaneLabels() {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.running) return false;
      if ((await this._sessions()).length === 0) return false;
      if (env.mode === 'external' && this._justStarted(env) && !this._externalLabelsRestoredByPid.has(env.pid)) {
        await this._restoreExternalPaneLabels(env).catch(() => {});
      }
      const lastFile = join(env.dir, 'last');
      const text = await readFile(lastFile, 'utf8').catch(() => '');
      if (!text || !isUsable(parseSnapshot(text))) return false;
      await this._appendPaneLabels(env, { preserveMtime: true });
      const latestStat = await stat(lastFile).catch(() => null);
      if (latestStat && latestStat.mtimeMs > this._lastAugmentedMtime) {
        this._lastAugmentedMtime = latestStat.mtimeMs;
      }
      return true;
    });
  }

  // --- what the page asks for ---

  saveNow() {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.running) throw new AppError(ErrorCode.UNSUPPORTED, 'tmux is not running on this machine');
      if ((await this._sessions()).length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'There are no sessions to save; the previous save is kept');
      }
      if (env.mode === 'managed') {
        await this._prepare(env);
        if (!env.seen) await this._firstSight(env);
      }
      const result = await this._save(env);
      if (!result.ok) throw new AppError(ErrorCode.INTERNAL, `Saving failed: ${result.error}`);
      return this.status();
    });
  }

  async snapshots() {
    const env = await this._inspect();
    const entries = await listSnapshots(env.dir);
    const out = [];
    for (const entry of entries.slice(0, 50)) {
      const snapshot = await readSnapshot(env.dir, entry.id);
      if (!snapshot || snapshot.sessions.length === 0) continue;
      out.push({
        ...entry,
        ...summarize(snapshot),
        list: snapshot.sessions.map((session) => ({
          name: session.name,
          windows: session.windows.map((window) => window.name),
          panes: session.windows.reduce((sum, window) => sum + window.panes.length, 0),
        })),
      });
    }
    return { snapshots: out };
  }

  restore(id, sessionName) {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.available) throw new AppError(ErrorCode.UNSUPPORTED, 'tmux is not available on this machine');
      const snapshot = await readSnapshot(env.dir, String(id || ''));
      if (!snapshot) throw new AppError(ErrorCode.SESSION_NOT_FOUND, 'Snapshot not found');
      const session = snapshot.sessions.find((entry) => entry.name === sessionName);
      if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND, 'That session is not in this snapshot');
      const name = freeName(session.name, new Set(await this._sessions()));
      const shell = env.defaultShell || null;
      return restoreSession((args) => this._tmux(args), session, { name, programs: this.settings.programs, defaultShell: shell });
    });
  }

  async status() {
    const env = await this._inspect();
    const latest = await readLatest(env.dir).catch(() => null);
    const seen = new Map();
    if (latest) {
      for (const session of latest.snapshot.sessions) {
        for (const window of session.windows) {
          for (const pane of window.panes) {
            const name = canonicalAgentType(pane.agent?.type) || paneProgramName(pane, env.defaultShell || null).name;
            if (name && !seen.has(name)) seen.set(name, pane.fullCommand || name);
          }
        }
      }
    }
    if (env.running) {
      const out = await this._tmux(['list-panes', '-a', '-F', '#{pane_current_command}']).catch(() => '');
      for (const command of out.split(/\r?\n/)) {
        const name = programName(command);
        if (name && !seen.has(name)) seen.set(name, '');
      }
    }
    return {
      mode: env.mode,
      enabled: this.settings.enabled,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      programs: choiceList(this.settings.programs, seen, env.defaultShell || null),
      tmux: { running: env.running, startedAt: env.startedAt || null },
      lastSave: this.lastSave,
      latest: latest && latest.snapshot.sessions.length ? { at: latest.at, ...summarize(latest.snapshot) } : null,
      autoRestore: env.restored || null,
      external: env.external ? { continuum: env.external.continuum } : null,
      snapshotDir: env.dir,
      base: await this._baseStatus(),
    };
  }

  // --- the settings the panel itself needs (the managed tmux.conf fragment) ---

  async _baseStatus() {
    if (!this.baseConfig) return null;
    const { tmuxConfig } = await this.baseConfig.status();
    return {
      linked: Boolean(tmuxConfig.linked),
      packaged: tmuxConfig.linkSupported === false,
      userPath: tmuxConfig.userPath,
      path: tmuxConfig.path,
      extraLines: tmuxConfig.extraLines || 0,
      file: tmuxConfig.userPath ? basename(tmuxConfig.userPath) : null,
    };
  }

  async linkBase() {
    if (!this.baseConfig) throw new AppError(ErrorCode.UNSUPPORTED, 'Not available here');
    await this.baseConfig.linkConfig(true);
    const env = await this._inspect();
    // Takes effect now when tmux runs; otherwise on its next start.
    if (env.running) await this.baseConfig.applyConfig();
    return this.status();
  }
}
