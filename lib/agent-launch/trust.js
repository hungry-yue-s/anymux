// Scoped Agent worktree pre-trust ledger and safe revocation.
// Hard-refuses broad paths ($HOME, filesystem roots, system dirs) before writing any trust marker.
// Ported from stablyai/orca (MIT).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const FORBIDDEN_UNIX_DIRS = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/root', '/sbin', '/sys', '/tmp', '/usr', '/var', '/System', '/Library', '/Applications', '/Users', '/home']);

export function isForbiddenTrustPath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return true;
  const rawTrimmed = targetPath.trim();
  if (/^[A-Za-z]:[\\/]*$/.test(rawTrimmed)) return true;
  if (/^[A-Za-z]:[\\/](?:Windows|Program Files|Program Files \(x86\)|Users)[\\/]*$/i.test(rawTrimmed)) return true;
  const resolved = resolve(rawTrimmed).replace(/[\\/]+$/, '') || '/';
  const home = resolve(homedir()).replace(/[\\/]+$/, '');
  if (resolved === '/' || resolved === home) return true;
  if (FORBIDDEN_UNIX_DIRS.has(resolved)) return true;
  return false;
}

function ledgerPathFor(configDir) {
  return join(configDir, 'worktree-trust-ledger.json');
}

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, filePath);
}

export async function pretrustWorktree({
  worktreePath,
  configDir,
  agentTypes = ['claude', 'codex'],
  claudeConfigPath = null,
} = {}) {
  if (isForbiddenTrustPath(worktreePath)) {
    throw new Error(`Refusing to trust forbidden broad or system path: ${worktreePath}`);
  }
  const canonical = resolve(worktreePath);
  const now = Date.now();

  if (configDir) {
    const ledgerFile = ledgerPathFor(configDir);
    const ledger = await readJsonSafe(ledgerFile, { entries: {} });
    ledger.entries = ledger.entries && typeof ledger.entries === 'object' ? ledger.entries : {};
    ledger.entries[canonical] = {
      path: canonical,
      agentTypes: [...new Set(agentTypes)],
      trustedAt: now,
    };
    await writeJsonAtomic(ledgerFile, ledger);
  }

  let claudeTrusted = false;
  if (claudeConfigPath && agentTypes.includes('claude')) {
    const cfg = await readJsonSafe(claudeConfigPath, {});
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
      const existing = projects[canonical] && typeof projects[canonical] === 'object' ? projects[canonical] : {};
      if (!existing.hasTrustDialogAccepted) {
        projects[canonical] = { ...existing, hasTrustDialogAccepted: true };
        cfg.projects = projects;
        await writeJsonAtomic(claudeConfigPath, cfg);
      }
      claudeTrusted = true;
    }
  }

  return { path: canonical, trusted: true, claudeTrusted };
}

export async function revokeWorktreeTrust({
  worktreePath,
  configDir,
  claudeConfigPath = null,
} = {}) {
  if (!worktreePath) return { revoked: false };
  const canonical = resolve(worktreePath);
  let revoked = false;

  if (configDir) {
    const ledgerFile = ledgerPathFor(configDir);
    const ledger = await readJsonSafe(ledgerFile, { entries: {} });
    if (ledger.entries && ledger.entries[canonical]) {
      delete ledger.entries[canonical];
      await writeJsonAtomic(ledgerFile, ledger);
      revoked = true;
    }
  }

  if (claudeConfigPath) {
    const cfg = await readJsonSafe(claudeConfigPath, null);
    if (cfg?.projects?.[canonical]) {
      delete cfg.projects[canonical];
      await writeJsonAtomic(claudeConfigPath, cfg);
      revoked = true;
    }
  }

  return { path: canonical, revoked };
}

export async function listTrustedWorktrees({ configDir } = {}) {
  if (!configDir) return [];
  const ledger = await readJsonSafe(ledgerPathFor(configDir), { entries: {} });
  return Object.values(ledger.entries || {});
}
