#!/usr/bin/env node
// macOS Local Network privacy maps a responsible process to an app by LC_UUID (TN3179).
// Keep Anymux and its helper bundles aligned on one deterministic UUID per CPU type.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;

export const DEFAULT_MAC_APP_ID = 'com.anymux.app';
export const DEFAULT_MAC_UUID_NAME = 'Anymux';

/** Format a 16-byte LC_UUID payload as uppercase RFC-4122 hex. */
export function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic per-(appId, executableName, cpuType) UUID stable across builds. */
export function deriveExecutableUuid(appId, executableName, cpuType) {
  const uuid = createHash('sha256')
    .update(`${appId}\0${executableName}\0${cpuType}`)
    .digest()
    .subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x80;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  return uuid;
}

function sliceOffsets(buffer) {
  if (buffer.length < 32) {
    throw new Error(`File too small to be a Mach-O binary (${buffer.length} bytes)`);
  }
  const magic = buffer.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return [0];
  }
  const is64 = magic === FAT_MAGIC_64;
  const count = buffer.readUInt32BE(4);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const entry = 8 + i * (is64 ? 32 : 20);
    offsets.push(is64 ? Number(buffer.readBigUInt64BE(entry + 8)) : buffer.readUInt32BE(entry + 8));
  }
  return offsets;
}

/** Locate LC_UUID slots for every slice in a thin or fat Mach-O buffer. */
export function machOUuidSlots(buffer) {
  return sliceOffsets(buffer).map((offset) => {
    const magic = buffer.readUInt32LE(offset);
    if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
      throw new Error(`Unsupported Mach-O slice at offset ${offset} (magic 0x${magic.toString(16)})`);
    }
    const cpuType = buffer.readUInt32LE(offset + 4);
    const commandCount = buffer.readUInt32LE(offset + 16);
    let command = offset + (magic === MH_MAGIC_64 ? 32 : 28);
    for (let i = 0; i < commandCount; i++) {
      const cmd = buffer.readUInt32LE(command);
      const cmdSize = buffer.readUInt32LE(command + 4);
      if (cmdSize < 8) {
        throw new Error(`Invalid Mach-O load command size ${cmdSize} at offset ${command}`);
      }
      if (cmd === LC_UUID) {
        return { cpuType, uuidOffset: command + 8 };
      }
      command += cmdSize;
    }
    throw new Error(`Mach-O slice for CPU type ${cpuType} has no LC_UUID`);
  });
}

/** Read current LC_UUID entries from a Mach-O buffer. */
export function readMachOUuids(buffer) {
  return machOUuidSlots(buffer).map(({ cpuType, uuidOffset }) => ({
    cpuType,
    uuid: formatUuid(buffer.subarray(uuidOffset, uuidOffset + 16)),
  }));
}

/** Rewrite LC_UUID in every slice of `buffer` in place. */
export function rewriteMachOUuids(buffer, appId = DEFAULT_MAC_APP_ID, executableName = DEFAULT_MAC_UUID_NAME) {
  return machOUuidSlots(buffer).map(({ cpuType, uuidOffset }) => {
    const before = formatUuid(buffer.subarray(uuidOffset, uuidOffset + 16));
    const next = deriveExecutableUuid(appId, executableName, cpuType);
    next.copy(buffer, uuidOffset);
    return { cpuType, before, after: formatUuid(next) };
  });
}

/**
 * Rewrite LC_UUID on `executablePath` and apply a clean ad-hoc identifier signature
 * so arm64 will execute it before outer bundle signing runs.
 */
export function applyStableMacExecutableUuid(
  executablePath,
  appId = DEFAULT_MAC_APP_ID,
  uuidName = DEFAULT_MAC_UUID_NAME,
  { execFileSyncFn = execFileSync } = {},
) {
  const name = basename(executablePath);
  const buffer = readFileSync(executablePath);
  const changes = rewriteMachOUuids(buffer, appId, uuidName);
  const staging = mkdtempSync(join(dirname(executablePath), '.anymux-uuid-'));
  try {
    const staged = join(staging, name);
    writeFileSync(staged, buffer, { mode: 0o755 });
    execFileSyncFn('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', appId, staged], {
      stdio: 'pipe',
    });
    const freshInode = join(dirname(executablePath), `.${name}.uuid.${process.pid}`);
    copyFileSync(staged, freshInode);
    chmodSync(freshInode, 0o755);
    renameSync(freshInode, executablePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [executablePath, appId = DEFAULT_MAC_APP_ID, uuidName = DEFAULT_MAC_UUID_NAME] = process.argv.slice(2);
  if (!executablePath) {
    console.error('Usage: macos-executable-uuid.mjs <executablePath> [appId] [uuidName]');
    process.exit(1);
  }
  const changes = applyStableMacExecutableUuid(executablePath, appId, uuidName);
  for (const { cpuType, before, after } of changes) {
    console.log(`[macos-executable-uuid] ${basename(executablePath)} cpu ${cpuType}: ${before} -> ${after}`);
  }
}
