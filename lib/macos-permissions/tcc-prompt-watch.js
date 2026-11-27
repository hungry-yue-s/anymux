// Watches macOS unified TCC logs for AUTHREQ_PROMPTING dialogs attributed to Anymux/tmux.
// Uses a stdin-EOF shell wrapper so `/usr/bin/log stream` terminates cleanly when the parent exits.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { replaceFile } from '../atomic-file.js';

export const TCC_LOG_PREDICATE = 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING"';

export const WATCHED_TCC_SERVICES = new Set([
  'kTCCServiceSystemPolicyAllFiles',
  'kTCCServiceSystemPolicyAppData',
  'kTCCServiceSystemPolicyDesktopFolder',
  'kTCCServiceSystemPolicyDocumentsFolder',
  'kTCCServiceSystemPolicyDownloadsFolder',
  'kTCCServiceSystemPolicyRemovableVolumes',
  'kTCCServiceSystemPolicyNetworkVolumes',
  'kTCCServiceMediaLibrary',
  'kTCCServicePhotos',
  'kTCCServiceAppleEvents',
  'kTCCServiceLocalNetwork',
]);

const ATTRIBUTION_PATTERNS = [
  /\bcom\.anymux\./i,
  /\bcom\.tmux-web-panel\b/i,
  /\.tmux\.new\.\d+/i,
  /\/\.local\/share\/(?:anymux|tmux-web-panel)\//i,
  /\/Application Support\/(?:Anymux|Tmux Panel)\//i,
  /Anymux Tmux\.app/i,
  /Anymux Panel\.app/i,
  /\/Anymux\.app\//i,
];

const LOG_STREAM_WRAPPER_SCRIPT = `set +eu
exec 4>&1 >/dev/null
log_pid=
term=
trap 'term=1; [ -n "$log_pid" ] && kill "$log_pid" 2>/dev/null' TERM INT HUP
/usr/bin/log stream --predicate "$1" --info --style compact </dev/null >&4 4>&- &
log_pid=$!
exec 4>&-
if [ -n "$term" ]; then
  kill "$log_pid" 2>/dev/null
else
  read -r _
  kill "$log_pid" 2>/dev/null
fi
sleep 0.2
kill "$log_pid" 2>/dev/null
wait "$log_pid"
exit "$?"`;

export function parseTccPromptEvent(line) {
  if (typeof line !== 'string' || !line.includes('AUTHREQ_PROMPTING')) return null;
  const service = /\bservice=(kTCCService\w+)/.exec(line)?.[1];
  const accessingIdentifier = /\bSub:\{([^}]*)\}/.exec(line)?.[1];
  const responsibleIdentifier = /\bResp:\{TCCDProcess:\s*identifier=([^,}]+)/.exec(line)?.[1];
  if (!service || !accessingIdentifier || !responsibleIdentifier) return null;
  const responsiblePath = /\bresponsible_path=([^,}]+)/.exec(line)?.[1]?.trim() || undefined;
  const binaryPath = /\bbinary_path=([^,}]+)/.exec(line)?.[1]?.trim() || undefined;
  return {
    service,
    accessingIdentifier: accessingIdentifier.trim(),
    responsibleIdentifier: responsibleIdentifier.trim(),
    ...(responsiblePath ? { responsiblePath } : {}),
    ...(binaryPath ? { binaryPath } : {}),
  };
}

export function isAnymuxAttributedPrompt(event) {
  if (!event || !WATCHED_TCC_SERVICES.has(event.service)) return false;
  const haystack = [
    event.accessingIdentifier,
    event.responsibleIdentifier,
    event.responsiblePath,
    event.binaryPath,
  ]
    .filter(Boolean)
    .join('\n');
  return ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(haystack));
}

function defaultSpawnLogStream() {
  return spawn('/bin/sh', ['-c', LOG_STREAM_WRAPPER_SCRIPT, 'sh', TCC_LOG_PREDICATE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export class MacosTccPromptWatch {
  constructor({ onPrompt, spawnLogStream = defaultSpawnLogStream, restartDelayMs = 1500, platform = process.platform } = {}) {
    this.onPrompt = onPrompt;
    this.spawnLogStream = spawnLogStream;
    this.restartDelayMs = restartDelayMs;
    this.platform = platform;
    this.child = null;
    this.reader = null;
    this.restartTimer = null;
    this.restartAttempted = false;
    this.stopped = false;
  }

  start() {
    if (this.platform !== 'darwin' || this.child || this.stopped) return;
    let child;
    try {
      child = this.spawnLogStream();
    } catch {
      return;
    }
    this.child = child;
    child.on('error', () => this._handleTermination(child));
    child.on('exit', () => this._handleTermination(child));
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this._handleLine(line));
    this.reader.on('close', () => this._handleTermination(child));
  }

  _handleTermination(child) {
    if (this.child !== child) return;
    this.reader?.close();
    this.reader = null;
    this.child = null;
    try { child.stdin?.destroy(); } catch {}
    if (this.stopped || this.restartAttempted) return;
    this.restartAttempted = true;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  _handleLine(line) {
    const event = parseTccPromptEvent(line);
    if (!event || !isAnymuxAttributedPrompt(event)) return;
    this.onPrompt?.(event);
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.reader?.close();
    this.reader = null;
    try { child?.kill('SIGTERM'); } catch {}
    try { child?.stdin?.destroy(); } catch {}
  }
}

const DEFAULT_STATE = Object.freeze({
  promptCount: 0,
  lastService: null,
  lastResponsible: null,
  lastAt: null,
  dismissed: false,
  acknowledgedAt: null,
});

export class TccPromptStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.state = { ...DEFAULT_STATE };
    this._writeQueue = Promise.resolve();
  }

  static forConfigDir(configDir) {
    return new TccPromptStore(join(configDir, 'macos-tcc-prompt-state.json'));
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          promptCount: Number.isFinite(raw.promptCount) ? raw.promptCount : 0,
          lastService: typeof raw.lastService === 'string' ? raw.lastService : null,
          lastResponsible: typeof raw.lastResponsible === 'string' ? raw.lastResponsible : null,
          lastAt: typeof raw.lastAt === 'number' ? raw.lastAt : null,
          dismissed: raw.dismissed === true,
          acknowledgedAt: typeof raw.acknowledgedAt === 'number' ? raw.acknowledgedAt : null,
        };
      }
    } catch {
      this.state = { ...DEFAULT_STATE };
    }
    return this.snapshot();
  }

  snapshot() {
    return { ...this.state };
  }

  _persist() {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const run = async () => {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(tmp, payload, { mode: 0o600 });
      await replaceFile(tmp, this.statePath);
    };
    this._writeQueue = this._writeQueue.then(run, run);
    return this._writeQueue;
  }

  async recordPrompt(event, now = Date.now()) {
    this.state = {
      ...this.state,
      promptCount: (this.state.promptCount || 0) + 1,
      lastService: event?.service || this.state.lastService,
      lastResponsible: event?.responsibleIdentifier || event?.responsiblePath || this.state.lastResponsible,
      lastAt: now,
    };
    await this._persist();
    return this.snapshot();
  }

  async dismiss(now = Date.now()) {
    this.state = {
      ...this.state,
      dismissed: true,
      acknowledgedAt: now,
    };
    await this._persist();
    return this.snapshot();
  }
}
