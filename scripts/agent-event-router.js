#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adoptLegacyEnv, appDir } from '../lib/legacy-names.js';

adoptLegacyEnv();

function parseArgs(argv) {
  const args = { bell: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-bell') {
      args.bell = false;
    } else if (arg === '--bell') {
      args.bell = true;
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    }
  }
  return args;
}

async function readStdin(timeoutMs = 250) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('error', finish);
      process.stdin.pause();
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ message: data.trim() });
      }
    };
    const onData = (chunk) => { data += chunk; };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

const BELL_EVENTS = new Set([
  'Stop',
  'agent_stop',
  'agent_stopped',
  'PermissionRequest',
  'permission_wait',
  'waiting_attention',
  'Notification',
  'notification',
  'StopFailure',
  'stop_failure',
  'failed',
]);

function shouldBell(event) {
  return BELL_EVENTS.has(event);
}

function localPanelToken(configDir, tokenFileName = 'tokens.json') {
  try {
    const file = join(configDir, tokenFileName);
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(entries)) return '';
    const now = Date.now();
    const valid = entries.find((entry) => {
      const meta = Array.isArray(entry) ? entry[1] : null;
      return meta && (meta.expiresAt === null || Number(meta.expiresAt) > now);
    });
    return valid && typeof valid[0] === 'string' ? valid[0] : '';
  } catch {
    return '';
  }
}

function readEndpointConfig(configDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'hook-endpoint.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function postJson(url, payload, token) {
  if (!url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      rejectUnauthorized: !(target.hostname === '127.0.0.1' || target.hostname === 'localhost'),
      timeout: 4000,
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const args = parseArgs(process.argv);
const input = await readStdin();
const event = args.event || input.hook_event_name || input.event || 'notification';
const session = args.session || input.session || input.tmux_session || '';
const windowId = args.windowId || args['window-id'] || input.windowId || input.window_id || '';
const paneId = args.paneId || args['pane-id'] || input.paneId || input.pane_id || process.env.TMUX_PANE || '';
if (!paneId && !session && !windowId && !process.env.TMUX && !process.env.TMUX_PANE) {
  process.exit(0);
}
const payload = {
  ...input,
  agent: args.agent || input.agent || input.source || 'agent',
  event,
  session,
  windowIndex: args.windowIndex ?? args['window-index'] ?? input.windowIndex ?? input.window_index,
  windowId,
  paneId,
  tty: args.tty || input.tty || process.env.TTY || '',
};

if (args.bell && shouldBell(event)) {
  try {
    writeFileSync('/dev/tty', '\u0007');
  } catch {
    // Best effort.
  }
}

const configDir = process.env.ANYMUX_CONFIG_DIR || appDir('config');
const endpoint = readEndpointConfig(configDir);
const effectiveConfigDir = endpoint.configDir || configDir;
const panelUrl = args.panelUrl || args['panel-url'] || process.env.ANYMUX_AGENT_EVENTS_URL || endpoint.url || 'https://127.0.0.1:7681/api/agent-events';
const panelToken = args.panelToken || args['panel-token'] || process.env.ANYMUX_TOKEN || localPanelToken(effectiveConfigDir, endpoint.tokenFileName);
const monitorUrl = args.monitorUrl || args['monitor-url'] || process.env.AGENT_MONITOR_URL || '';
const monitorToken = args.monitorToken || args['monitor-token'] || process.env.AGENT_MONITOR_TOKEN || '';

await Promise.allSettled([
  postJson(panelUrl, payload, panelToken),
  postJson(monitorUrl, payload, monitorToken),
]);
