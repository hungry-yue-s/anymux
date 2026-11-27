// Cross-process file lock, atomic config replacement, and bounded backup pruning
// for agent hook installation. Ported from stablyai/orca (MIT).

import { copyFile, mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { replaceFile } from '../atomic-file.js';

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_DELAY_MS = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function isLockStale(lockPath, staleMs) {
  try {
    const [raw, st] = await Promise.all([readFile(lockPath, 'utf8').catch(() => ''), stat(lockPath)]);
    let ownerPid = null;
    try {
      const parsed = JSON.parse(raw);
      if (Number.isInteger(parsed?.pid)) ownerPid = parsed.pid;
    } catch {
      const num = Number(raw.trim());
      if (Number.isInteger(num) && num > 0) ownerPid = num;
    }
    if (ownerPid !== null) {
      return !isPidAlive(ownerPid);
    }
    return Date.now() - st.mtimeMs > staleMs;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

/**
 * Serialize hook configuration reads/merges/writes across concurrent processes.
 */
export async function withInstallLock(lockPath, run, { timeoutMs = DEFAULT_WAIT_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let handle = null;

  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (await isLockStale(lockPath, staleMs)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring hook install lock: ${lockPath}`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n', 'utf8');
    return await run();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

export async function atomicWriteFile(filePath, content, { mode = 0o644 } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`;
  try {
    await writeFile(tmpPath, content, { mode });
    await replaceFile(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function pruneBackups(filePath, { keep = 3 } = {}) {
  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.bak-`;
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const matches = names.filter((n) => n.startsWith(prefix)).sort();
  if (matches.length <= keep) return 0;
  const toDelete = matches.slice(0, matches.length - keep);
  let removed = 0;
  for (const name of toDelete) {
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch { /* ignore concurrent unlink */ }
  }
  return removed;
}

export async function backupAndPruneFile(filePath, { keep = 3 } = {}) {
  if (!existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  let dest = `${filePath}.bak-${stamp}`;
  if (existsSync(dest)) {
    dest = `${filePath}.bak-${stamp}-${process.hrtime.bigint().toString(36).slice(-4)}`;
  }
  await copyFile(filePath, dest);
  await pruneBackups(filePath, { keep });
  return dest;
}
