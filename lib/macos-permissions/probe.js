// macOS TCC Full Disk Access probe, signature attribution check, and privacy settings helpers.
import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AppError, ErrorCode } from '../servers/errors.js';
import { appDir } from '../legacy-names.js';
import { REPO_ROOT } from '../paths.js';

const execFileAsync = promisify(execFileCb);

export const APP_BUNDLE_ID = 'com.anymux.app';

export const PRIVACY_PANE_URLS = Object.freeze({
  'full-disk-access': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  'files-and-folders': 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  'local-network': 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
});

async function defaultReadOneByte(filePath) {
  const handle = await open(filePath, 'r');
  try {
    await handle.read(Buffer.alloc(1), 0, 1, 0);
  } finally {
    await handle.close();
  }
}

/**
 * Silent Full Disk Access check by opening and reading 1 byte of TCC.db.
 * Never use access(2)/test -r, which bypasses MAC enforcement.
 */
export async function probeFullDiskAccess({
  platform = process.platform,
  homeDir = homedir(),
  openFile = defaultReadOneByte,
} = {}) {
  if (platform !== 'darwin') return 'unsupported';
  const dbPath = join(homeDir, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
  try {
    await openFile(dbPath);
    return 'granted';
  } catch (err) {
    const code = err?.code;
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown';
  }
}

/**
 * Probes Full Disk Access from inside the running tmux server's own process tree.
 * Returns 'granted' | 'denied' | 'unknown' | 'not_running' | 'unsupported'.
 */
export async function probeTmuxFullDiskAccess({
  platform = process.platform,
  tmuxRun = null,
} = {}) {
  if (platform !== 'darwin') return 'unsupported';
  if (typeof tmuxRun !== 'function') return 'unknown';

  try {
    const pidOut = (await tmuxRun(['display-message', '-p', '#{pid}'], { timeout: 2000 })).trim();
    if (!/^\d+$/.test(pidOut)) return 'not_running';
  } catch {
    return 'not_running';
  }

  const probeCmd = '[ -e "$HOME/Library/Application Support/com.apple.TCC/TCC.db" ] || { printf unknown; exit 0; }; head -c 1 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" >/dev/null 2>&1 && printf granted || printf denied';
  try {
    const out = (await tmuxRun(['run-shell', probeCmd], { timeout: 2500 })).trim();
    if (out === 'granted' || out === 'denied' || out === 'unknown') return out;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Parse `codesign -dvv` and `codesign -d -r -` outputs into structured metadata. */
export function parseCodesignOutput(dvvText = '', reqText = '') {
  const text = String(dvvText || '');
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim() || null;
  const signature = /^Signature=(.+)$/m.exec(text)?.[1]?.trim() || null;
  const teamLine = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim() || null;
  const teamIdentifier = teamLine && teamLine !== 'not set' ? teamLine : null;
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const adhoc = signature === 'adhoc' || authorities.length === 0;
  const designatedRequirement = /^designated\s*=>\s*(.+)$/m.exec(String(reqText || ''))?.[1]?.trim() || null;
  return {
    identifier,
    adhoc,
    authority: authorities[0] || null,
    teamIdentifier,
    designatedRequirement,
  };
}

/** Inspect a Mach-O binary or .app bundle's code signature and helper-bundle status. */
export async function inspectBinarySignature(
  targetPath,
  {
    execFile = execFileAsync,
    resolveRealpath = realpath,
    exists = existsSync,
  } = {},
) {
  if (!targetPath || !exists(targetPath)) {
    return { path: targetPath || null, realPath: null, exists: false, isHelperBundle: false };
  }
  const realPath = await resolveRealpath(targetPath).catch(() => resolve(targetPath));
  const isHelperBundle = /\.app\/Contents\/MacOS\/[^/]+$/.test(realPath) || /\.app$/.test(realPath);

  let dvvText = '';
  try {
    const { stdout, stderr } = await execFile('/usr/bin/codesign', ['-dvv', targetPath], { timeout: 3000 });
    dvvText = `${stdout || ''}\n${stderr || ''}`;
  } catch (err) {
    dvvText = `${err?.stdout || ''}\n${err?.stderr || ''}`;
  }

  let reqText = '';
  try {
    const { stdout, stderr } = await execFile('/usr/bin/codesign', ['-d', '-r', '-', targetPath], { timeout: 3000 });
    reqText = `${stdout || ''}\n${stderr || ''}`;
  } catch (err) {
    reqText = `${err?.stdout || ''}\n${err?.stderr || ''}`;
  }

  return {
    path: targetPath,
    realPath,
    exists: true,
    isHelperBundle,
    ...parseCodesignOutput(dvvText, reqText),
  };
}

function defaultAppCandidates(projectDir = REPO_ROOT, homeDir = homedir()) {
  const list = [];
  if (process.env.ANYMUX_APP_PATH) list.push(process.env.ANYMUX_APP_PATH);
  list.push(
    '/Applications/Anymux.app',
    join(homeDir, 'Applications', 'Anymux.app'),
    join(projectDir, 'dist', 'macos', 'Anymux.app'),
  );
  return list;
}

export function resolveInstalledAppPath({
  appCandidates = defaultAppCandidates(),
  exists = existsSync,
} = {}) {
  for (const candidate of appCandidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

export async function resolveInstalledAppPathAsync({
  appCandidates = defaultAppCandidates(),
  execFile = execFileAsync,
  exists = existsSync,
} = {}) {
  const direct = resolveInstalledAppPath({ appCandidates, exists });
  if (direct) return direct;
  try {
    const { stdout } = await execFile('/bin/ps', ['-axo', 'comm='], { timeout: 2000 });
    for (const rawLine of String(stdout || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      const match = /^(.+\/Anymux\.app)\/Contents\/MacOS\/Anymux$/.exec(line);
      if (match && exists(match[1])) return match[1];
    }
  } catch {
    // Best-effort lookup for development builds launched outside /Applications.
  }
  return null;
}

export function resolveInstalledTmuxPath({
  tmuxBin = null,
  runtimePath = null,
  homeDir = homedir(),
  exists = existsSync,
} = {}) {
  const candidates = [];
  if (tmuxBin && tmuxBin !== 'tmux') candidates.push(tmuxBin);
  if (runtimePath) {
    candidates.push(join(runtimePath, 'Helpers', 'Anymux Tmux.app', 'Contents', 'MacOS', 'Anymux Tmux'));
    candidates.push(join(runtimePath, 'bin', 'tmux'));
  }
  const dataDir = appDir('data', { home: homeDir, exists });
  candidates.push(join(dataDir, 'Helpers', 'Anymux Tmux.app', 'Contents', 'MacOS', 'Anymux Tmux'));
  candidates.push(join(dataDir, 'bin', 'tmux'));
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return tmuxBin || null;
}

function isUnifiedSignature(sig, appSig) {
  if (!sig?.exists || !sig.isHelperBundle) return false;
  if (sig.identifier !== APP_BUNDLE_ID || sig.adhoc) return false;
  if (appSig?.exists && appSig.designatedRequirement && sig.designatedRequirement) {
    return sig.designatedRequirement === appSig.designatedRequirement;
  }
  return true;
}

/**
 * Inspect whether the live tmux server shares Anymux.app's TCC attribution identity,
 * or whether a restart / rebuild is needed.
 */
export async function inspectLiveTmuxAttribution({
  platform = process.platform,
  tmuxBin = null,
  runtimePath = null,
  homeDir = homedir(),
  tmuxRun = null,
  projectDir = REPO_ROOT,
  appCandidates = defaultAppCandidates(projectDir, homeDir),
  execFile = execFileAsync,
  resolveRealpath = realpath,
  statFile = stat,
  exists = existsSync,
} = {}) {
  if (platform !== 'darwin') {
    return { supported: false, state: 'unsupported', livePid: null, live: null, installed: null, app: null };
  }

  const appPath = await resolveInstalledAppPathAsync({ appCandidates, execFile, exists });
  const installedPath = resolveInstalledTmuxPath({ tmuxBin, runtimePath, homeDir, exists });

  const [appSig, installedSig] = await Promise.all([
    appPath ? inspectBinarySignature(appPath, { execFile, resolveRealpath, exists }) : Promise.resolve(null),
    installedPath ? inspectBinarySignature(installedPath, { execFile, resolveRealpath, exists }) : Promise.resolve(null),
  ]);

  let livePid = null;
  let liveStartSec = null;
  let livePath = null;
  if (typeof tmuxRun === 'function') {
    try {
      const metaText = (await tmuxRun(['display-message', '-p', '#{pid}:#{start_time}'], { timeout: 2000 })).trim();
      const parts = /^(\d+)(?::(\d+))?$/.exec(metaText);
      if (parts) {
        livePid = Number(parts[1]);
        liveStartSec = parts[2] ? Number(parts[2]) : null;
        try {
          const { stdout } = await execFile('/bin/ps', ['-p', String(livePid), '-o', 'comm='], { timeout: 2000 });
          livePath = String(stdout || '').trim() || null;
        } catch {
          livePath = null;
        }
      }
    } catch {
      livePid = null;
    }
  }

  if (!livePid) {
    const installedReady = isUnifiedSignature(installedSig, appSig);
    return {
      supported: true,
      state: 'not_running',
      installedReady,
      livePid: null,
      live: null,
      installed: installedSig,
      app: appSig,
    };
  }

  const liveSig = livePath
    ? await inspectBinarySignature(livePath, { execFile, resolveRealpath, exists })
    : { path: null, realPath: null, exists: false, isHelperBundle: false };

  // A running legacy process may have launched from a path (e.g. ~/.local/share/anymux/bin/tmux)
  // that was later replaced on disk by a symlink to the signed Helper .app. Do not trust the
  // on-disk symlink target when the process itself did not launch directly from a .app bundle
  // or started before the Helper binary was written.
  const liveLaunchedFromBundle = Boolean(livePath && /\.app\/Contents\/MacOS\/[^/]+$/.test(livePath));
  let binaryReplacedSinceStart = false;
  if (liveStartSec && installedSig?.realPath) {
    try {
      const info = await statFile(installedSig.realPath);
      if (Number.isFinite(info?.mtimeMs) && liveStartSec * 1000 < info.mtimeMs) {
        binaryReplacedSinceStart = true;
      }
    } catch {
      // Missing mtime falls back to path check.
    }
  }

  const liveUnified = liveLaunchedFromBundle && !binaryReplacedSinceStart && isUnifiedSignature(liveSig, appSig);
  const installedUnified = isUnifiedSignature(installedSig, appSig);

  let state = 'legacy_adhoc';
  if (liveUnified) {
    state = 'unified';
  } else if (installedUnified) {
    state = 'restart_required';
  }

  return {
    supported: true,
    state,
    installedReady: installedUnified,
    livePid,
    live: liveSig,
    installed: installedSig,
    app: appSig,
  };
}

export async function openPrivacySettings(id, { platform = process.platform, execFile = execFileAsync } = {}) {
  if (platform !== 'darwin') {
    throw new AppError(ErrorCode.UNSUPPORTED, 'macOS privacy settings are only available on macOS');
  }
  const url = PRIVACY_PANE_URLS[id];
  if (!url) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Unsupported privacy settings pane: ${id}`);
  }
  await execFile('/usr/bin/open', [url], { timeout: 5000 });
  return { opened: true, id, url };
}

export async function revealInFinder(targetPath, { platform = process.platform, execFile = execFileAsync, exists = existsSync } = {}) {
  if (platform !== 'darwin') {
    throw new AppError(ErrorCode.UNSUPPORTED, 'Finder reveal is only available on macOS');
  }
  if (!targetPath || !exists(targetPath)) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Target application or binary not found on disk');
  }
  await execFile('/usr/bin/open', ['-R', targetPath], { timeout: 5000 });
  return { revealed: true, path: targetPath };
}
