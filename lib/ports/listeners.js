// Cross-platform listening TCP port discovery (Linux ss, macOS lsof, Windows netstat).
// Ported from stablyai/orca (MIT).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSsOutput } from '../ports.js';

const execFileAsync = promisify(execFile);
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const EXEC_TIMEOUT_MS = 5000;

export function parseLsofOutput(output) {
  if (!output || !String(output).trim()) return [];
  const lines = String(output).split('\n');
  const results = [];
  const seen = new Set();

  // Supports `lsof -nP -iTCP -sTCP:LISTEN` tabular format and `-F pcn` field format
  let curPid = 0;
  let curCmd = '';
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line[0] === 'p' && /^p\d+$/.test(line)) {
      curPid = Number(line.slice(1));
      continue;
    }
    if (line[0] === 'c' && curPid > 0) {
      curCmd = line.slice(1);
      continue;
    }
    if (line[0] === 'n' && curPid > 0) {
      const m = line.match(/:(\d+)$/);
      if (m) {
        const port = Number(m[1]);
        if (port > PORT_MIN && port <= PORT_MAX) {
          const key = `${curPid}:${port}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ port, pid: curPid, address: line.slice(1), command: curCmd });
          }
        }
      }
      continue;
    }

    // Tabular fallback: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || parts[0] === 'COMMAND') continue;
    const cmd = parts[0];
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const addrToken = parts[parts.length - 1] === '(LISTEN)' ? parts[parts.length - 2] : parts[parts.length - 1];
    const m = addrToken.match(/:(\d+)$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (port <= PORT_MIN || port > PORT_MAX) continue;
    const key = `${pid}:${port}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ port, pid, address: addrToken, command: cmd });
    }
  }
  return results;
}

export function parseNetstatWindowsOutput(output) {
  if (!output || !String(output).trim()) return [];
  const results = [];
  const seen = new Set();
  for (const rawLine of String(output).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('TCP')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const state = parts[3]?.toUpperCase();
    if (state !== 'LISTENING') continue;
    const localAddr = parts[1];
    const pid = Number(parts[4]);
    const m = localAddr.match(/:(\d+)$/);
    if (!m || !Number.isFinite(pid) || pid <= 0) continue;
    const port = Number(m[1]);
    if (port <= PORT_MIN || port > PORT_MAX) continue;
    const key = `${pid}:${port}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ port, pid, address: localAddr, command: '' });
    }
  }
  return results;
}

export async function listListeningPorts({
  platform = process.platform,
  exec = execFileAsync,
} = {}) {
  try {
    if (platform === 'darwin') {
      const { stdout } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeout: EXEC_TIMEOUT_MS });
      return parseLsofOutput(stdout);
    }
    if (platform === 'win32') {
      const { stdout } = await exec('netstat', ['-ano', '-p', 'TCP'], { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
      return parseNetstatWindowsOutput(stdout);
    }
    const { stdout } = await exec('ss', ['-tlnp'], { timeout: EXEC_TIMEOUT_MS });
    return parseSsOutput(stdout).map((entry) => ({ ...entry, address: `:${entry.port}`, command: '' }));
  } catch {
    return [];
  }
}
