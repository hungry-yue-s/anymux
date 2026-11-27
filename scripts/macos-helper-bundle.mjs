#!/usr/bin/env node
// Shared helper .app bundle generator and codesign resolver for macOS TCC attribution.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyStableMacExecutableUuid,
  DEFAULT_MAC_APP_ID,
  DEFAULT_MAC_UUID_NAME,
} from './macos-executable-uuid.mjs';

export const FORBIDDEN_HELPER_INFO_KEYS = [
  'CFBundleURLTypes',
  'CFBundleDocumentTypes',
  'UTExportedTypeDeclarations',
  'UTImportedTypeDeclarations',
  'NSServices',
];

function defaultAppCandidates(projectDir = resolve(import.meta.dirname, '..')) {
  const candidates = [];
  if (process.env.ANYMUX_APP_PATH) candidates.push(process.env.ANYMUX_APP_PATH);
  candidates.push('/Applications/Anymux.app', join(projectDir, 'dist/macos/Anymux.app'));
  return candidates;
}

/** Extract all NS*UsageDescription keys and CFBundleShortVersionString from Info.plist. */
export function readAppInfoMetadata(infoPlistPath, { execFileSyncFn = execFileSync } = {}) {
  const raw = execFileSyncFn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPlistPath], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  const usageDescriptions = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (/^NS.+UsageDescription$/.test(key) && typeof value === 'string' && value.length > 0) {
      usageDescriptions[key] = value;
    }
  }
  return {
    appId: typeof parsed.CFBundleIdentifier === 'string' && parsed.CFBundleIdentifier ? parsed.CFBundleIdentifier : DEFAULT_MAC_APP_ID,
    shortVersion: typeof parsed.CFBundleShortVersionString === 'string' && parsed.CFBundleShortVersionString ? parsed.CFBundleShortVersionString : '0.1.0',
    usageDescriptions,
  };
}

/** Read valid macOS code-signing identity names from the keychain. */
export function listAvailableSigningIdentities({ execFileSyncFn = execFileSync } = {}) {
  try {
    const out = execFileSyncFn('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const names = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"([^"]+)"/.exec(line);
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
    return names;
  } catch {
    return [];
  }
}

/** Extract the leaf Authority name from `codesign -dvv` output (null for ad-hoc). */
export function parseCodesignAuthority(codesignOutput) {
  for (const line of String(codesignOutput || '').split(/\r?\n/)) {
    const m = /^Authority=(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Resolve which signing identity to use so helper bundles match Anymux.app when possible.
 * Returns '-' when no matching/usable certificate is present.
 */
export function resolveSigningIdentity({
  explicit = process.env.ANYMUX_CODESIGN_IDENTITY || '',
  appCandidates = defaultAppCandidates(),
  execFileSyncFn = execFileSync,
} = {}) {
  const trimmed = String(explicit || '').trim();
  if (trimmed) return trimmed;

  const available = listAvailableSigningIdentities({ execFileSyncFn });
  if (!available.length) return '-';

  for (const candidate of appCandidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const info = execFileSyncFn('/usr/bin/codesign', ['-dvv', candidate], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const authority = parseCodesignAuthority(info);
      if (authority && available.includes(authority)) return authority;
    } catch (err) {
      const combined = `${err?.stdout || ''}\n${err?.stderr || ''}`;
      const authority = parseCodesignAuthority(combined);
      if (authority && available.includes(authority)) return authority;
    }
  }

  const devId = available.find((name) => name.startsWith('Developer ID Application:'));
  if (devId) return devId;
  if (available.length === 1) return available[0];
  return '-';
}

/** Build Info.plist dictionary for a background helper bundle sharing the main app's bundle id. */
export function buildHelperInfoPlist({
  bundleName,
  executableName = bundleName,
  appId = DEFAULT_MAC_APP_ID,
  shortVersion = '0.1.0',
  minimumMacOS = '13.5',
  usageDescriptions = {},
  iconFile = null,
}) {
  const info = {
    ...usageDescriptions,
    CFBundleDevelopmentRegion: 'zh_CN',
    CFBundleIdentifier: appId,
    CFBundleName: bundleName,
    CFBundleDisplayName: bundleName,
    CFBundleExecutable: executableName,
    CFBundlePackageType: 'APPL',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleVersion: '0',
    CFBundleShortVersionString: shortVersion,
    LSMinimumSystemVersion: minimumMacOS,
    LSUIElement: true,
    NSHighResolutionCapable: true,
  };
  if (iconFile) info.CFBundleIconFile = iconFile;
  for (const forbidden of FORBIDDEN_HELPER_INFO_KEYS) {
    delete info[forbidden];
  }
  return info;
}

/**
 * Create, UUID-align, sign, verify and atomically publish a macOS Helper .app bundle.
 */
export function createHelperBundle({
  sourceBinary,
  outputBundle,
  bundleName,
  executableName = bundleName,
  appId = null,
  minimumMacOS = '13.5',
  appInfoPlist,
  iconPath = null,
  entitlementsPath = null,
  identity = null,
  distribution = false,
  alignUuidTo = DEFAULT_MAC_UUID_NAME,
  execFileSyncFn = execFileSync,
}) {
  if (!sourceBinary || !existsSync(sourceBinary)) {
    throw new Error(`Helper source binary missing: ${sourceBinary}`);
  }
  if (!appInfoPlist || !existsSync(appInfoPlist)) {
    throw new Error(`App Info.plist missing: ${appInfoPlist}`);
  }

  const meta = readAppInfoMetadata(appInfoPlist, { execFileSyncFn });
  const resolvedAppId = appId || meta.appId || DEFAULT_MAC_APP_ID;
  const resolvedIdentity = identity || resolveSigningIdentity({ execFileSyncFn });

  const parentDir = dirname(resolve(outputBundle));
  mkdirSync(parentDir, { recursive: true });
  const stageRoot = join(parentDir, `.helper-stage.${process.pid}.${Date.now()}`);
  const stagedBundle = join(stageRoot, `${bundleName}.app`);
  const contentsDir = join(stagedBundle, 'Contents');
  const macOsDir = join(contentsDir, 'MacOS');
  const resourcesDir = join(contentsDir, 'Resources');

  try {
    mkdirSync(macOsDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });

    const targetExec = join(macOsDir, executableName);
    copyFileSync(sourceBinary, targetExec);
    chmodSync(targetExec, 0o755);

    let iconFile = null;
    if (iconPath && existsSync(iconPath)) {
      iconFile = 'AppIcon.icns';
      copyFileSync(iconPath, join(resourcesDir, iconFile));
    }

    const plistObj = buildHelperInfoPlist({
      bundleName,
      executableName,
      appId: resolvedAppId,
      shortVersion: meta.shortVersion,
      minimumMacOS,
      usageDescriptions: meta.usageDescriptions,
      iconFile,
    });
    const plistPath = join(contentsDir, 'Info.plist');
    writeFileSync(plistPath, JSON.stringify(plistObj, null, 2));
    execFileSyncFn('/usr/bin/plutil', ['-convert', 'xml1', plistPath], { stdio: 'pipe' });

    applyStableMacExecutableUuid(targetExec, resolvedAppId, alignUuidTo, { execFileSyncFn });

    const signArgs = ['--force', '--sign', resolvedIdentity, '--identifier', resolvedAppId];
    if (resolvedIdentity !== '-') signArgs.push('--timestamp');
    if (resolvedIdentity.startsWith('Developer ID Application:') || distribution) {
      signArgs.push('--options', 'runtime');
    }
    if (entitlementsPath && existsSync(entitlementsPath)) {
      signArgs.push('--entitlements', entitlementsPath);
    }
    signArgs.push(stagedBundle);

    execFileSyncFn('/usr/bin/codesign', signArgs, { stdio: 'pipe' });
    // Install the signed executable onto a fresh inode so macOS does not serve
    // a stale vnode code-signature cache entry from the pre-signed write.
    const freshExec = `${targetExec}.signed.${process.pid}`;
    copyFileSync(targetExec, freshExec);
    chmodSync(freshExec, 0o755);
    renameSync(freshExec, targetExec);
    execFileSyncFn('/usr/bin/codesign', ['--verify', '--strict', stagedBundle], { stdio: 'pipe' });

    const resolvedOutput = resolve(outputBundle);
    const oldBackup = `${resolvedOutput}.old.${process.pid}`;
    rmSync(oldBackup, { recursive: true, force: true });
    if (existsSync(resolvedOutput)) {
      renameSync(resolvedOutput, oldBackup);
    }
    renameSync(stagedBundle, resolvedOutput);
    rmSync(oldBackup, { recursive: true, force: true });

    return {
      bundlePath: resolvedOutput,
      executablePath: join(resolvedOutput, 'Contents', 'MacOS', executableName),
      appId: resolvedAppId,
      identity: resolvedIdentity,
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function parseCliFlags(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[name] = next;
      i += 1;
    } else {
      opts[name] = '1';
    }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'resolve-identity') {
    const opts = parseCliFlags(rest);
    process.stdout.write(`${resolveSigningIdentity({ explicit: opts.identity || '' })}\n`);
  } else if (command === 'build') {
    const opts = parseCliFlags(rest);
    const result = createHelperBundle({
      sourceBinary: opts.source,
      outputBundle: opts.output,
      bundleName: opts.name,
      executableName: opts.executable || opts.name,
      appId: opts['app-id'] || null,
      minimumMacOS: opts['minimum-macos'] || '13.5',
      appInfoPlist: opts['app-info'],
      iconPath: opts.icon || null,
      entitlementsPath: opts.entitlements || null,
      identity: opts.identity || null,
      distribution: opts.distribution === '1' || opts.distribution === 'true',
      alignUuidTo: opts['uuid-name'] || DEFAULT_MAC_UUID_NAME,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    console.error('Usage: macos-helper-bundle.mjs <resolve-identity|build> [options]');
    process.exit(1);
  }
}
