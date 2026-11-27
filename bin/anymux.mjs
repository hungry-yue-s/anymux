#!/usr/bin/env node
// anymux — script the panel from inside a pane.
//
//   anymux open [--dock|--background] [--replaces old] <file[#heading]|url>
//                                         show a file in the panel's preview, or with
//                                         --dock in the side panel next to this pane
//                                         (or a page in the browser block)
//   anymux doc path <name> [--html]       where to write a document draft; prints the path
//   anymux git show [commit] [--background] [--repo dir] register or open a commit preview
//   anymux split [-h] [-c dir] [cmd...]   split this pane, print the new pane id
//   anymux run [-t pane] <cmd...>         type a command into a pane and press Enter
//   anymux capture [-t pane] [-n lines]   print a pane's text (with scrollback)
//   anymux events [--filter a,b]          stream workspace events as JSON lines
//
// `open` and `doc` talk to this machine's panel with the node token from the
// pairing file; the others drive tmux directly, so open windows update live.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { appPathCandidates } from '../lib/legacy-names.js';

const USAGE = `usage:
  anymux open [--dock | --background] [--pane %N] [--replaces <old path>] <file[#heading] | url>
  anymux doc path <name> [--html]
  anymux git show [commit] [--background] [--repo <directory>] [--pane %N]
  anymux workspace list | new [--name <name>] [--cwd <dir>] [--session <id>]
  anymux worktree list [--repo <dir>] | new <branch> [--repo <dir>] [--base <ref>] [--open] | remove <path> [--repo <dir>] [--force]
  anymux sessions [--provider claude|codex|gemini] [--q <query>] [--limit <n>]
  anymux automation list | run <id>
  anymux pane new [--window @id] [--dir h|v] | open <kind> [--payload <json>|--url <url>|--path <path>] [--label <label>] [--dir h|v] [--window @id] | set-kind <kind> [--payload <json>|--url <url>|--path <path>] [--pane %N] | zoom [--pane %N] | break [--pane %N] | clear [--pane %N] | rename <label> [--pane %N]
  anymux browser status | open <url> | snapshot
  anymux split [-h] [-c dir] [cmd...]
  anymux run [-t pane] <cmd...>
  anymux capture [-t pane] [-n lines]
  anymux events [--filter event,...]`;

function die(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function tmux(args, options = {}) {
  return execFileSync('tmux', args, { encoding: 'utf8', ...options });
}

function currentPane() {
  return process.env.TMUX_PANE || null;
}

export function parseTmuxServerPid(tmuxEnv = process.env.TMUX) {
  const parts = String(tmuxEnv || '').split(',');
  if (parts.length < 3) return null;
  const pid = parts[parts.length - 2].trim();
  return /^\d+$/.test(pid) && Number(pid) > 0 ? pid : null;
}

export function collectSourceContext({ explicitPane = null, env = process.env, pid = process.pid } = {}) {
  const trimmedExplicit = typeof explicitPane === 'string' && explicitPane.trim() ? explicitPane.trim() : null;
  const trimmedEnv = typeof env?.TMUX_PANE === 'string' && env.TMUX_PANE.trim() ? env.TMUX_PANE.trim() : null;
  const paneSource = trimmedExplicit ? 'arg' : (trimmedEnv ? 'env' : 'none');
  const paneId = trimmedExplicit || trimmedEnv || null;
  const tmuxServerPid = parseTmuxServerPid(env?.TMUX ?? '');
  const rawThread = env?.CODEX_THREAD_ID || env?.CODEX_SESSION_ID || '';
  const codexThreadId = typeof rawThread === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(rawThread.trim())
    ? rawThread.trim() : null;
  return {
    ...(paneId ? { paneId } : {}),
    paneSource,
    ...(tmuxServerPid ? { tmuxServerPid } : {}),
    ...(Number.isInteger(pid) && pid > 1 ? { callerPid: pid } : {}),
    ...(codexThreadId ? { codexThreadId } : {}),
  };
}

function quoteArg(value) {
  const str = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

export function formatRetryCommand(subcommandArgs, { scriptPath = process.argv[1] } = {}) {
  const prefix = scriptPath ? ['node', quoteArg(scriptPath)] : ['anymux'];
  return [...prefix, ...subcommandArgs.map(quoteArg)].join(' ');
}

function appendRetryHint(error, retryCommand) {
  const message = error?.message || '';
  if (/\bpreview_source_(?:ambiguous|untrusted|unavailable|invalid_pane)\b/.test(message) && message.includes('--pane')) {
    error.message = `${message}\nRetry command:\n  ${retryCommand}`;
  }
  throw error;
}

function takeOption(args, names, { flag = false } = {}) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return flag ? false : null;
    if (names.includes(args[i])) {
      if (flag) { args.splice(i, 1); return true; }
      const value = args[i + 1];
      if (value === undefined) die(`${args[i]} needs a value`);
      args.splice(i, 2);
      return value;
    }
  }
  return flag ? false : null;
}

function rest(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

function readPairing() {
  // A panel installed as tmux-web-panel that has not restarted since still writes the old path.
  const defaultPaths = appPathCandidates('config', 'node.json');
  const paths = process.env.ANYMUX_CONFIG_DIR
    ? [join(process.env.ANYMUX_CONFIG_DIR, 'node.json'), ...defaultPaths]
    : defaultPaths;
  for (const path of paths) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch { /* try the next location */ }
  }
  return die(`anymux: no panel on this machine (${paths[0]} not found)`);
}

/** TLS socket whose certificate matches the pinned fingerprint, checked before any byte is sent. */
function pinnedSocket(pairing) {
  return new Promise((resolveSocket, reject) => {
    const socket = tls.connect({ host: pairing.host, port: pairing.port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      if (fingerprint !== pairing.tlsFingerprint) {
        socket.destroy();
        reject(new Error('panel certificate does not match the pairing file'));
      } else resolveSocket(socket);
    });
    socket.on('error', reject);
  });
}

async function requestJson(method, path, body = null) {
  const pairing = readPairing();
  const payload = body == null ? null : JSON.stringify(body);
  const socket = pairing.tls ? await pinnedSocket(pairing) : null;
  const headers = { Authorization: `Bearer ${pairing.token}` };
  if (payload != null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  const options = {
    host: pairing.host,
    port: pairing.port,
    path,
    method,
    headers,
  };
  if (socket) options.createConnection = () => socket;
  return new Promise((resolveResponse, reject) => {
    const req = (pairing.tls ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && (!data || data.success !== false)) resolveResponse(data?.data ?? data);
        else reject(new Error((data && (data.error && data.error.message || data.error)) || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (payload != null) req.end(payload);
    else req.end();
  });
}

function postJson(path, body) {
  return requestJson('POST', path, body);
}

/** A path as the panel takes it: absolute, `~/...`, or relative to this shell's directory. */
function absolutePath(target) {
  // Windows: a native cwd (C:\...) is converted by the panel; MSYS paths pass through.
  return target.startsWith('/') || target.startsWith('~') ? target : resolve(process.cwd(), target);
}

/**
 * `notes.md#Next steps` → the file and the heading, but only when that file
 * exists and the whole string does not (a name may contain `#`).
 */
export function splitFragment(target, exists = existsSync) {
  const at = target.lastIndexOf('#');
  if (at <= 0 || at === target.length - 1 || exists(target)) return { target, fragment: null };
  const file = target.slice(0, at);
  return exists(file) ? { target: file, fragment: target.slice(at + 1) } : { target, fragment: null };
}

async function cmdOpen(args) {
  takeOption(args, ['--preview', '-p'], { flag: true }); // previewing is the only mode; kept for muscle memory
  const dock = takeOption(args, ['--dock', '-d'], { flag: true });
  const background = takeOption(args, ['--background', '-b'], { flag: true });
  const replaces = takeOption(args, ['--replaces']);
  const kind = takeOption(args, ['--kind']);
  const owner = takeOption(args, ['--owner']);
  const explicitPane = takeOption(args, ['--pane', '-t']);
  const sourceCtx = collectSourceContext({ explicitPane });
  const raw = rest(args)[0];
  if (!raw) die(USAGE);
  let body;
  let retryArgs = null;
  if (/^https?:\/\//i.test(raw)) {
    body = { url: raw };
    if (sourceCtx.paneId) body.paneId = sourceCtx.paneId;
  } else {
    const { target, fragment } = splitFragment(raw);
    body = { path: absolutePath(target) };
    if (dock || background) {
      body.placement = 'dock';
      body.cwd = process.cwd();
      if (background) body.activate = false;
      Object.assign(body, sourceCtx);
      retryArgs = [
        'open',
        background ? '--background' : '--dock',
        '--pane', '<PANE_ID>',
        ...(replaces ? ['--replaces', absolutePath(replaces)] : []),
        ...(kind ? ['--kind', kind] : []),
        ...(owner ? ['--owner', owner] : []),
        raw,
      ];
    } else if (sourceCtx.paneId) {
      body.paneId = sourceCtx.paneId;
    }
    if (fragment) body.fragment = fragment;
    if (replaces) body.replaces = absolutePath(replaces);
    if (kind) body.kind = kind;
    if (owner) body.owner = owner;
  }
  const result = await postJson('/api/open', body).catch((error) => {
    if (retryArgs) appendRetryHint(error, formatRetryCommand(retryArgs));
    throw error;
  });
  process.stdout.write(`requested ${result.path || result.url}${body.placement === 'dock' ? ` (side panel, window ${result.windowId}${result.paneId ? `, pane ${result.paneId}` : ''})` : ''}\n`);
}

async function cmdGit(args) {
  if (args.shift() !== 'show') die(USAGE);
  const background = takeOption(args, ['--background', '-b'], { flag: true });
  const repo = takeOption(args, ['--repo', '-C']) || '.';
  const explicitPane = takeOption(args, ['--pane', '-t']);
  const sourceCtx = collectSourceContext({ explicitPane });
  const remaining = rest(args);
  const commit = remaining[0] || 'HEAD';
  if (remaining.length > 1 || !/^(HEAD|[0-9a-f]{4,64})$/i.test(commit)) die('anymux: expected a commit hash or HEAD');
  const absRepo = absolutePath(repo);
  const retryArgs = [
    'git', 'show', commit,
    ...(background ? ['--background'] : []),
    '--repo', absRepo,
    '--pane', '<PANE_ID>',
  ];
  const data = await postJson('/api/git/open', {
    path: absRepo,
    commit,
    cwd: process.cwd(),
    activate: !background,
    ...sourceCtx,
  }).catch((error) => appendRetryHint(error, formatRetryCommand(retryArgs)));
  process.stdout.write(`requested commit ${data.commit} in ${data.path} (window ${data.windowId}${data.paneId ? `, pane ${data.paneId}` : ''}${background ? ', background' : ''})\n`);
}

async function cmdDoc(args) {
  const [action, ...more] = args;
  if (action !== 'path') die(USAGE);
  const html = takeOption(more, ['--html'], { flag: true });
  const name = rest(more).join(' ').trim();
  if (!name) die(USAGE);
  const result = await postJson('/api/agent-docs/draft', { cwd: process.cwd(), name, ext: html ? 'html' : undefined });
  // The agent writes it with its own tools, which on Windows take native paths.
  process.stdout.write((process.platform === 'win32' ? result.nativePath : result.path) + '\n');
}

function cmdSplit(args) {
  const horizontal = takeOption(args, ['-h'], { flag: true });
  const vertical = takeOption(args, ['-v'], { flag: true });
  const cwd = takeOption(args, ['-c', '--cwd']) || process.cwd();
  const target = takeOption(args, ['-t']) || currentPane();
  const command = rest(args);
  const tmuxArgs = ['split-window', '-P', '-F', '#{pane_id}', '-c', cwd];
  if (horizontal && !vertical) tmuxArgs.push('-h');
  if (target) tmuxArgs.push('-t', target);
  if (command.length) tmuxArgs.push(command.join(' '));
  process.stdout.write(tmux(tmuxArgs));
}

function cmdRun(args) {
  const target = takeOption(args, ['-t']) || currentPane();
  const command = rest(args).join(' ');
  if (!command) die(USAGE);
  const base = target ? ['-t', target] : [];
  tmux(['send-keys', ...base, '-l', command]);
  tmux(['send-keys', ...base, 'Enter']);
}

function cmdCapture(args) {
  const target = takeOption(args, ['-t']) || currentPane();
  const lines = Number.parseInt(takeOption(args, ['-n']) || '0', 10);
  const tmuxArgs = ['capture-pane', '-p', '-J'];
  if (target) tmuxArgs.push('-t', target);
  if (lines > 0) tmuxArgs.push('-S', String(-lines));
  process.stdout.write(tmux(tmuxArgs));
}

/** Pane ids in a tmux layout string: leaves are `WxH,X,Y,ID`. */
export function layoutPanes(layout) {
  const ids = new Set();
  const re = /\d+x\d+,\d+,\d+,(\d+)/g;
  let match;
  while ((match = re.exec(layout))) ids.add('%' + match[1]);
  return ids;
}

/** Turns one control-mode line into zero or more events. */
export function controlEvents(line, panesByWindow) {
  const parts = line.split(' ');
  const at = new Date().toISOString();
  switch (parts[0]) {
    case '%layout-change': {
      const windowId = parts[1];
      const next = layoutPanes(parts[2] || '');
      const previous = panesByWindow.get(windowId) || new Set();
      panesByWindow.set(windowId, next);
      const events = [];
      for (const id of next) if (!previous.has(id) && previous.size) events.push({ event: 'pane_spawned', at, windowId, paneId: id });
      for (const id of previous) if (!next.has(id)) events.push({ event: 'pane_closed', at, windowId, paneId: id });
      events.push({ event: 'layout_changed', at, windowId, layout: parts[2] });
      return events;
    }
    case '%window-add': return [{ event: 'window_added', at, windowId: parts[1] }];
    case '%window-close':
    case '%unlinked-window-close':
      panesByWindow.delete(parts[1]);
      return [{ event: 'window_closed', at, windowId: parts[1] }];
    case '%window-renamed': return [{ event: 'window_renamed', at, windowId: parts[1], name: parts.slice(2).join(' ') }];
    case '%window-pane-changed': return [{ event: 'pane_focused', at, windowId: parts[1], paneId: parts[2] }];
    case '%session-window-changed': return [{ event: 'window_focused', at, sessionId: parts[1], windowId: parts[2] }];
    case '%sessions-changed': return [{ event: 'sessions_changed', at }];
    case '%session-renamed': return [{ event: 'session_renamed', at, sessionId: parts[1], name: parts.slice(2).join(' ') }];
    case '%pane-mode-changed': return [{ event: 'pane_mode_changed', at, paneId: parts[1] }];
    case '%exit': return [{ event: 'exit', at }];
    default: return [];
  }
}

function cmdEvents(args) {
  const filter = takeOption(args, ['--filter', '-f']);
  const wanted = filter ? new Set(filter.split(',').map((name) => name.trim()).filter(Boolean)) : null;
  const panesByWindow = new Map();
  try {
    for (const row of tmux(['list-windows', '-a', '-F', '#{window_id} #{window_layout}']).split('\n')) {
      const [id, layout] = row.split(' ');
      if (id) panesByWindow.set(id, layoutPanes(layout || ''));
    }
  } catch {
    die('anymux: no tmux server');
  }
  // A read-only control client that ignores sizes and pane output: it only listens.
  const child = spawn('tmux', ['-C', 'attach-session', '-f', 'read-only,ignore-size,no-output'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      for (const event of controlEvents(line, panesByWindow)) {
        if (!wanted || wanted.has(event.event)) process.stdout.write(JSON.stringify(event) + '\n');
      }
    }
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.stdin.end(); child.kill(); });
}

export function parseWorkspaceArgs(argv) {
  const args = [...argv];
  const sub = args.shift() || 'list';
  const name = takeOption(args, ['--name', '-n']);
  const cwd = takeOption(args, ['--cwd', '-c']);
  const session = takeOption(args, ['--session', '-s']);
  return { sub, name, cwd, session };
}

export function parseWorktreeArgs(argv, cwdDefault = process.cwd()) {
  const args = [...argv];
  const sub = args.shift() || 'list';
  const repo = takeOption(args, ['--repo', '-C']) || cwdDefault;
  const baseRef = takeOption(args, ['--base', '-b']);
  const openWindow = takeOption(args, ['--open'], { flag: true });
  const force = takeOption(args, ['--force', '-f'], { flag: true });
  const target = rest(args)[0] || null;
  return { sub, repo, baseRef, openWindow, force, target };
}

export function parsePaneArgs(argv, envPane = currentPane()) {
  const args = [...argv];
  const sub = args.shift();
  const pane = takeOption(args, ['--pane', '-t']) || envPane;
  const windowId = takeOption(args, ['--window', '-w']);
  const dir = takeOption(args, ['--dir', '--direction', '-d']) || 'horizontal';
  const payloadRaw = takeOption(args, ['--payload']);
  const url = takeOption(args, ['--url']);
  const path = takeOption(args, ['--path']);
  const optLabel = takeOption(args, ['--label']);
  const positionals = rest(args);
  let payload = payloadRaw ?? '';
  if (url || path) {
    let base = {};
    if (payload) {
      try { base = JSON.parse(payload); } catch { base = {}; }
    }
    if (url) base.url = url;
    if (path) base.path = path;
    payload = JSON.stringify(base);
  }
  const kind = (sub === 'open' || sub === 'set-kind') ? (positionals[0] || '') : '';
  const label = optLabel ?? (sub === 'rename' ? positionals.join(' ').trim() : '');
  return {
    sub, pane, windowId, dir, label,
    ...(sub === 'open' || sub === 'set-kind' ? { kind, payload } : {}),
  };
}

export function parseSessionsArgs(argv) {
  const args = [...argv];
  const provider = takeOption(args, ['--provider', '-p']) || '';
  const q = takeOption(args, ['--q', '-q']) || '';
  const limit = Number(takeOption(args, ['--limit', '-l']) || '50') || 50;
  return { provider, q, limit };
}

async function cmdWorkspace(args) {
  const parsed = parseWorkspaceArgs(args);
  if (parsed.sub === 'list') {
    const ws = await requestJson('GET', '/api/workspace');
    process.stdout.write(JSON.stringify(ws, null, 2) + '\n');
    return;
  }
  if (parsed.sub === 'new') {
    let sessionId = parsed.session;
    if (!sessionId) {
      const ws = await requestJson('GET', '/api/workspace');
      sessionId = ws?.sessions?.[0]?.id;
    }
    if (!sessionId) {
      const created = await requestJson('POST', '/api/workspace/sessions', {
        name: parsed.name || 'work',
        ...(parsed.cwd ? { cwd: absolutePath(parsed.cwd) } : {}),
      });
      process.stdout.write(JSON.stringify(created, null, 2) + '\n');
      return;
    }
    const created = await requestJson('POST', `/api/workspace/sessions/${encodeURIComponent(sessionId)}/windows`, {
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.cwd ? { cwd: absolutePath(parsed.cwd) } : {}),
    });
    process.stdout.write(JSON.stringify(created, null, 2) + '\n');
    return;
  }
  die(USAGE);
}

async function cmdWorktree(args) {
  const parsed = parseWorktreeArgs(args);
  const repo = absolutePath(parsed.repo);
  if (parsed.sub === 'list') {
    const data = await requestJson('GET', `/api/worktrees?path=${encodeURIComponent(repo)}`);
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (parsed.sub === 'new' && parsed.target) {
    const data = await requestJson('POST', '/api/worktrees', {
      path: repo,
      branch: parsed.target,
      ...(parsed.baseRef ? { baseRef: parsed.baseRef } : {}),
      openWindow: parsed.openWindow,
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (parsed.sub === 'remove' && parsed.target) {
    const data = await requestJson('DELETE', '/api/worktrees', {
      path: repo,
      worktreePath: absolutePath(parsed.target),
      force: parsed.force,
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  die(USAGE);
}

async function cmdSessions(args) {
  const { provider, q, limit } = parseSessionsArgs(args);
  const query = new URLSearchParams();
  if (provider) query.set('provider', provider);
  if (q) query.set('q', q);
  if (limit) query.set('limit', String(limit));
  const data = await requestJson('GET', `/api/session-vault/sessions?${query}`);
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

async function cmdAutomation(args) {
  const sub = args.shift() || 'list';
  if (sub === 'list') {
    const data = await requestJson('GET', '/api/automations');
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (sub === 'run' && args[0]) {
    const data = await requestJson('POST', `/api/automations/${encodeURIComponent(args[0])}/run`, {});
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  die(USAGE);
}

async function cmdPane(args) {
  const parsed = parsePaneArgs(args);
  if (parsed.sub === 'new' || parsed.sub === 'open') {
    const winId = parsed.windowId || (await requestJson('GET', '/api/workspace'))?.sessions?.[0]?.windows?.[0]?.id;
    if (!winId) die('anymux: window id required (--window @id)');
    const direction = parsed.dir === 'v' || parsed.dir === 'vertical' ? 'vertical' : 'horizontal';
    if (parsed.sub === 'open' && !parsed.kind) die('anymux: pane kind required (e.g. browser|diff|doc)');
    const data = await requestJson('POST', `/api/workspace/windows/${encodeURIComponent(winId)}/panes`, {
      ...(parsed.pane ? { paneId: parsed.pane } : {}),
      direction,
      ...(parsed.sub === 'open' ? { kind: parsed.kind, ...(parsed.payload ? { payload: parsed.payload } : {}), ...(parsed.label ? { label: parsed.label } : {}) } : {}),
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (!parsed.pane) die('anymux: pane id required (--pane %N)');
  const encodedPane = encodeURIComponent(parsed.pane);
  if (parsed.sub === 'set-kind') {
    if (!parsed.kind) die('anymux: pane kind required (e.g. terminal|browser|diff|doc)');
    const body = { kind: parsed.kind, ...(parsed.payload !== '' ? { payload: parsed.payload } : {}) };
    process.stdout.write(JSON.stringify(await requestJson('PATCH', `/api/workspace/panes/${encodedPane}`, body)) + '\n');
  } else if (parsed.sub === 'zoom') {
    process.stdout.write(JSON.stringify(await requestJson('POST', `/api/workspace/panes/${encodedPane}/zoom`, {})) + '\n');
  } else if (parsed.sub === 'break') {
    process.stdout.write(JSON.stringify(await requestJson('POST', `/api/workspace/panes/${encodedPane}/break`, {})) + '\n');
  } else if (parsed.sub === 'clear') {
    process.stdout.write(JSON.stringify(await requestJson('POST', `/api/workspace/panes/${encodedPane}/clear`, {})) + '\n');
  } else if (parsed.sub === 'rename' && parsed.label) {
    process.stdout.write(JSON.stringify(await requestJson('PATCH', `/api/workspace/panes/${encodedPane}`, { label: parsed.label })) + '\n');
  } else {
    die(USAGE);
  }
}

async function cmdBrowser(args) {
  const sub = args.shift() || 'status';
  if (sub === 'status') {
    const status = await requestJson('GET', '/api/browser/agent-browser');
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return;
  }
  if (sub === 'open' || sub === 'snapshot' || sub === 'screenshot' || sub === 'get-url' || sub === 'close') {
    try {
      const result = await requestJson('POST', '/api/browser/agent-browser', { command: sub, args });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    } catch (err) {
      if (sub === 'open' && args[0] && /^https?:\/\//i.test(args[0])) {
        const opened = await postJson('/api/open', { url: args[0], ...(currentPane() ? { paneId: currentPane() } : {}) });
        process.stdout.write(JSON.stringify(opened, null, 2) + '\n');
        return;
      }
      throw err;
    }
  }
  die(USAGE);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'open': return cmdOpen(args);
    case 'doc': return cmdDoc(args);
    case 'git': return cmdGit(args);
    case 'workspace': return cmdWorkspace(args);
    case 'worktree': return cmdWorktree(args);
    case 'sessions': return cmdSessions(args);
    case 'automation': return cmdAutomation(args);
    case 'pane': return cmdPane(args);
    case 'browser': return cmdBrowser(args);
    case 'split': return cmdSplit(args);
    case 'run': return cmdRun(args);
    case 'capture': return cmdCapture(args);
    case 'events': return cmdEvents(args);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE + '\n');
      return undefined;
    default:
      return die(USAGE);
  }
}

const invokedDirectly = process.argv[1] && /anymux(\.mjs)?$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main().catch((error) => die(`anymux: ${error.message}`));
}
