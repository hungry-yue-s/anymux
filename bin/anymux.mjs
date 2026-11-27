#!/usr/bin/env node
// anymux — script the panel from inside a pane or over Hub /n/:serverId.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { assertLocalOnly, createPanelClient, resolveServerId } from '../lib/cli/client.js';
import { CliError, formatCliError, formatCliSuccess } from '../lib/cli/errors.js';
import {
  getBundledSkill,
  installBundledSkills,
  listBundledSkills,
  resolveEnabledCapabilities,
} from '../lib/cli/skills.js';
import {
  buildAgentContext,
  CLI_VERSION,
  COMMAND_SPECS,
  findCommandSpec,
  formatAgentContextSummary,
  formatCommandHelp,
  formatRootHelp,
  isCommandGroup,
  suggestCommands,
} from '../lib/cli/specs.js';

function tmux(args, options = {}) {
  return execFileSync('tmux', args, { encoding: 'utf8', ...options });
}

function currentPane(env = process.env) {
  return env?.TMUX_PANE || null;
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
    if (error instanceof CliError) {
      error.nextSteps = [`Run retry command: ${retryCommand}`];
    }
  }
  throw error;
}

function takeOption(args, names, { flag = false } = {}) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return flag ? false : null;
    if (names.includes(args[i])) {
      if (flag) { args.splice(i, 1); return true; }
      const value = args[i + 1];
      if (value === undefined || value === '--') {
        throw new CliError('invalid_argument', `${args[i]} needs a value`, { exitCode: 2 });
      }
      args.splice(i, 2);
      return value;
    }
  }
  return flag ? false : null;
}

function rest(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

/** A path as the panel takes it: absolute, `~/...`, or relative to this shell's directory. */
function absolutePath(target, cwd = process.cwd()) {
  return target.startsWith('/') || target.startsWith('~') ? target : resolve(cwd, target);
}

/**
 * `notes.md#Next steps` -> the file and the heading, but only when that file
 * exists and the whole string does not (a name may contain `#`).
 */
export function splitFragment(target, exists = existsSync) {
  const at = target.lastIndexOf('#');
  if (at <= 0 || at === target.length - 1 || exists(target)) return { target, fragment: null };
  const file = target.slice(0, at);
  return exists(file) ? { target: file, fragment: target.slice(at + 1) } : { target, fragment: null };
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

function usageError(commandPath) {
  const help = commandPath?.length ? formatCommandHelp(commandPath) : formatRootHelp();
  throw new CliError('invalid_argument', help || formatRootHelp(), { exitCode: 2 });
}

function extractGlobalOptions(argv, env) {
  const args = [...argv];
  let json = false;
  let help = false;
  let version = false;
  let serverFlag = null;
  const clean = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      clean.push(...args.slice(i));
      break;
    }
    if (token === '--json') {
      json = true;
    } else if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--version' || token === '-v') {
      version = true;
    } else if (token === '--server' || token === '-S') {
      const value = args[i + 1];
      if (value === undefined || value === '--') {
        throw new CliError('invalid_argument', `${token} needs a value`, {
          nextSteps: ['Pass a server ID such as `--server local` or run `anymux server list --json`.'],
          exitCode: 2,
        });
      }
      serverFlag = value;
      i += 1;
    } else if (token.startsWith('--server=')) {
      serverFlag = token.slice('--server='.length);
      if (!serverFlag) {
        throw new CliError('invalid_argument', '--server needs a non-empty value', { exitCode: 2 });
      }
    } else {
      clean.push(token);
    }
  }

  return {
    args: clean,
    json,
    help,
    version,
    serverId: resolveServerId({ flagValue: serverFlag, env }),
  };
}

function helpPathFromTokens(tokens) {
  if (!tokens.length) return [];
  const two = tokens.slice(0, 2);
  if (findCommandSpec(two) || isCommandGroup(two)) return two;
  return [tokens[0]];
}

function formatStatusText(data) {
  const lines = [
    `server:   ${data.server}`,
    `version:  ${data.version || 'unknown'} (protocol ${data.protocol ?? '?'})`,
    `host:     ${data.hostname || 'unknown'} (${data.platform || '?'}/${data.arch || '?'})`,
    `tmux:     ${data.tmux?.available ? (data.tmux.version || 'available') : `unavailable (${data.tmux?.reason || 'missing'})`}`,
    `plugins:  ${Array.isArray(data.plugins) ? data.plugins.join(', ') : 'unknown'}`,
  ];
  const panes = data.agentStatus?.panes;
  if (panes) {
    const count = Array.isArray(panes) ? panes.length : (typeof panes === 'object' ? Object.keys(panes).length : 0);
    lines.push(`agents:   ${count} tracked pane(s)`);
  }
  return lines.join('\n');
}

function formatServerListText(data) {
  const servers = Array.isArray(data?.servers) ? data.servers : (Array.isArray(data) ? data : []);
  if (!servers.length) return 'No servers registered.';
  return servers.map((s) => {
    const id = s.id || '?';
    const name = s.name && s.name !== id ? ` (${s.name})` : '';
    const state = typeof s.status === 'string'
      ? s.status
      : (s.status?.state || s.state || (s.connected ? 'connected' : 'unknown'));
    const transport = s.mode || s.status?.workspace?.transport || (s.status?.node?.installed ? 'node' : '');
    const mode = transport ? ` [${transport}]` : '';
    return `${id}${name}: ${state}${mode}`;
  }).join('\n');
}

function formatSkillsListText(topics) {
  return topics.map((t) => `${t.name}: ${t.description}`).join('\n');
}

function formatSkillInstallText(result) {
  const lines = result.results.map((r) => `${r.status.padEnd(9)} ${r.name} -> ${r.target} (${r.path})`);
  if (result.warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

async function cmdStatus({ client, json, writeOut }) {
  const info = await client.requestJson('GET', '/api/node/info');
  let agentStatus = null;
  try {
    agentStatus = await client.requestJson('GET', '/api/agent-status', null, { timeoutMs: 2000 });
  } catch {
    agentStatus = null;
  }
  const payload = {
    server: client.serverId,
    reachable: true,
    ...info,
    ...(agentStatus ? { agentStatus } : {}),
  };
  writeOut(formatCliSuccess(payload, { json, formatText: formatStatusText }));
}

function cmdAgentContext({ serverId, json, writeOut }) {
  assertLocalOnly('agent-context', serverId, ['Drop --server or pass `--server local`.']);
  const schema = buildAgentContext(COMMAND_SPECS);
  writeOut(formatCliSuccess(schema, { json, formatText: formatAgentContextSummary }));
}

async function cmdServer({ args, client, json, writeOut }) {
  const sub = args.shift() || 'list';
  if (sub !== 'list') usageError(['server', sub]);
  assertLocalOnly('server list', client.serverId, [
    'Server registry belongs to the local Hub; drop --server or pass `--server local`.',
  ]);
  const data = await client.requestJson('GET', '/api/servers', null, { scope: 'hub' });
  writeOut(formatCliSuccess(data, { json, formatText: formatServerListText }));
}

async function cmdSkills({ args, client, json, writeOut, projectDir, userHome, env }) {
  const sub = args.shift();
  if (!sub) usageError(['skills']);

  if (sub === 'list') {
    const topics = await listBundledSkills({ projectDir });
    writeOut(formatCliSuccess({ topics }, { json, formatText: (d) => formatSkillsListText(d.topics) }));
    return;
  }

  if (sub === 'get') {
    const listReferences = takeOption(args, ['--references'], { flag: true });
    const full = takeOption(args, ['--full'], { flag: true });
    const reference = takeOption(args, ['--reference']);
    const name = rest(args)[0];
    if (!name) usageError(['skills', 'get']);
    const caps = await resolveEnabledCapabilities({ client });
    const result = await getBundledSkill({
      name,
      reference,
      listReferences,
      full,
      projectDir,
      enabledCapabilities: caps.enabled,
      verified: caps.verified,
    });
    writeOut(formatCliSuccess(result.data, {
      json,
      warnings: result.warnings,
      formatText: (data) => {
        if (result.mode === 'references') return data.references.join('\n');
        return data.markdown;
      },
    }));
    return;
  }

  if (sub === 'install' || sub === 'update') {
    assertLocalOnly(`skills ${sub}`, client.serverId, ['Skill symlinks can only be managed on the local machine.']);
    const agents = takeOption(args, ['--agent']);
    const names = rest(args).filter(Boolean);
    const result = await installBundledSkills({
      names: names.length ? names : null,
      agents,
      update: sub === 'update',
      projectDir,
      userHome,
      env,
    });
    writeOut(formatCliSuccess(result, {
      json,
      warnings: result.warnings,
      formatText: formatSkillInstallText,
    }));
    return;
  }

  usageError(['skills']);
}

async function cmdOpen({ args, client, json, writeOut, env, pid, cwd, scriptPath }) {
  takeOption(args, ['--preview', '-p'], { flag: true });
  const dock = takeOption(args, ['--dock', '-d'], { flag: true });
  const background = takeOption(args, ['--background', '-b'], { flag: true });
  const replaces = takeOption(args, ['--replaces']);
  const kind = takeOption(args, ['--kind']);
  const owner = takeOption(args, ['--owner']);
  const explicitPane = takeOption(args, ['--pane', '-t']);
  const sourceCtx = collectSourceContext({ explicitPane, env, pid });
  const raw = rest(args)[0];
  if (!raw) usageError(['open']);
  let body;
  let retryArgs = null;
  if (/^https?:\/\//i.test(raw)) {
    body = { url: raw };
    if (sourceCtx.paneId) body.paneId = sourceCtx.paneId;
  } else {
    const { target, fragment } = splitFragment(raw);
    body = { path: absolutePath(target, cwd) };
    if (dock || background) {
      body.placement = 'dock';
      body.cwd = cwd;
      if (background) body.activate = false;
      Object.assign(body, sourceCtx);
      retryArgs = [
        'open',
        background ? '--background' : '--dock',
        '--pane', '<PANE_ID>',
        ...(replaces ? ['--replaces', absolutePath(replaces, cwd)] : []),
        ...(kind ? ['--kind', kind] : []),
        ...(owner ? ['--owner', owner] : []),
        raw,
      ];
    } else if (sourceCtx.paneId) {
      body.paneId = sourceCtx.paneId;
    }
    if (fragment) body.fragment = fragment;
    if (replaces) body.replaces = absolutePath(replaces, cwd);
    if (kind) body.kind = kind;
    if (owner) body.owner = owner;
  }
  const result = await client.postJson('/api/open', body).catch((error) => {
    if (retryArgs) appendRetryHint(error, formatRetryCommand(retryArgs, { scriptPath }));
    throw error;
  });
  writeOut(formatCliSuccess(result, {
    json,
    formatText: (res) => `requested ${res.path || res.url}${body.placement === 'dock' ? ` (side panel, window ${res.windowId}${res.paneId ? `, pane ${res.paneId}` : ''})` : ''}`,
  }));
}

async function cmdGit({ args, client, json, writeOut, env, pid, cwd, scriptPath }) {
  if (args.shift() !== 'show') usageError(['git', 'show']);
  const background = takeOption(args, ['--background', '-b'], { flag: true });
  const repo = takeOption(args, ['--repo', '-C']) || '.';
  const explicitPane = takeOption(args, ['--pane', '-t']);
  const sourceCtx = collectSourceContext({ explicitPane, env, pid });
  const remaining = rest(args);
  const commit = remaining[0] || 'HEAD';
  if (remaining.length > 1 || !/^(HEAD|[0-9a-f]{4,64})$/i.test(commit)) {
    throw new CliError('invalid_argument', 'expected a commit hash or HEAD', { exitCode: 2 });
  }
  const absRepo = absolutePath(repo, cwd);
  const retryArgs = [
    'git', 'show', commit,
    ...(background ? ['--background'] : []),
    '--repo', absRepo,
    '--pane', '<PANE_ID>',
  ];
  const data = await client.postJson('/api/git/open', {
    path: absRepo,
    commit,
    cwd,
    activate: !background,
    ...sourceCtx,
  }).catch((error) => appendRetryHint(error, formatRetryCommand(retryArgs, { scriptPath })));

  writeOut(formatCliSuccess(data, {
    json,
    formatText: (d) => `requested commit ${d.commit} in ${d.path} (window ${d.windowId}${d.paneId ? `, pane ${d.paneId}` : ''}${background ? ', background' : ''})`,
  }));
}

async function cmdDoc({ args, client, json, writeOut, cwd, platform }) {
  const [action, ...more] = args;
  if (action !== 'path') usageError(['doc', 'path']);
  const html = takeOption(more, ['--html'], { flag: true });
  const name = rest(more).join(' ').trim();
  if (!name) usageError(['doc', 'path']);
  const result = await client.postJson('/api/agent-docs/draft', { cwd, name, ext: html ? 'html' : undefined });
  writeOut(formatCliSuccess(result, {
    json,
    formatText: (res) => (platform === 'win32' ? res.nativePath : res.path),
  }));
}

function cmdSplit({ args, serverId, json, writeOut, env, cwd, execTmux }) {
  assertLocalOnly('split', serverId, ['Use `anymux pane new --server <id>` for remote windows.']);
  const horizontal = takeOption(args, ['-h'], { flag: true });
  const vertical = takeOption(args, ['-v'], { flag: true });
  const targetCwd = takeOption(args, ['-c', '--cwd']) || cwd;
  const target = takeOption(args, ['-t']) || currentPane(env);
  const command = rest(args);
  const tmuxArgs = ['split-window', '-P', '-F', '#{pane_id}', '-c', targetCwd];
  if (horizontal && !vertical) tmuxArgs.push('-h');
  if (target) tmuxArgs.push('-t', target);
  if (command.length) tmuxArgs.push(command.join(' '));
  const out = execTmux(tmuxArgs);
  const paneId = out.trim();
  writeOut(formatCliSuccess({ paneId }, { json, formatText: () => out.trimEnd() }));
}

function cmdRun({ args, serverId, json, writeOut, env, execTmux }) {
  assertLocalOnly('run', serverId, ['`run` targets local tmux directly.']);
  const target = takeOption(args, ['-t']) || currentPane(env);
  const command = rest(args).join(' ');
  if (!command) usageError(['run']);
  const base = target ? ['-t', target] : [];
  execTmux(['send-keys', ...base, '-l', command]);
  execTmux(['send-keys', ...base, 'Enter']);
  if (json) writeOut(formatCliSuccess({ paneId: target, sent: true }, { json: true }));
}

function cmdCapture({ args, serverId, json, writeOut, env, execTmux }) {
  assertLocalOnly('capture', serverId, ['`capture` targets local tmux directly.']);
  const target = takeOption(args, ['-t']) || currentPane(env);
  const lines = Number.parseInt(takeOption(args, ['-n']) || '0', 10);
  const tmuxArgs = ['capture-pane', '-p', '-J'];
  if (target) tmuxArgs.push('-t', target);
  if (lines > 0) tmuxArgs.push('-S', String(-lines));
  const content = execTmux(tmuxArgs);
  if (json) {
    writeOut(formatCliSuccess({ paneId: target, content }, { json: true }));
  } else {
    writeOut(content);
  }
}

function cmdEvents({ args, serverId, writeOut }) {
  assertLocalOnly('events', serverId, ['`events` streams local tmux control mode directly.']);
  const filter = takeOption(args, ['--filter', '-f']);
  const wanted = filter ? new Set(filter.split(',').map((name) => name.trim()).filter(Boolean)) : null;
  const panesByWindow = new Map();
  try {
    for (const row of tmux(['list-windows', '-a', '-F', '#{window_id} #{window_layout}']).split('\n')) {
      const [id, layout] = row.split(' ');
      if (id) panesByWindow.set(id, layoutPanes(layout || ''));
    }
  } catch {
    throw new CliError('panel_unavailable', 'no tmux server', { exitCode: 1 });
  }
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
        if (!wanted || wanted.has(event.event)) writeOut(JSON.stringify(event) + '\n');
      }
    }
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.stdin.end(); child.kill(); });
}

async function cmdWorkspace({ args, client, json, writeOut, cwd }) {
  const parsed = parseWorkspaceArgs(args);
  if (parsed.sub === 'list') {
    const ws = await client.requestJson('GET', '/api/workspace');
    writeOut(formatCliSuccess(ws, { json }));
    return;
  }
  if (parsed.sub === 'new') {
    let sessionId = parsed.session;
    if (!sessionId) {
      const ws = await client.requestJson('GET', '/api/workspace');
      sessionId = ws?.sessions?.[0]?.id;
    }
    if (!sessionId) {
      const created = await client.requestJson('POST', '/api/workspace/sessions', {
        name: parsed.name || 'work',
        ...(parsed.cwd ? { cwd: absolutePath(parsed.cwd, cwd) } : {}),
      });
      writeOut(formatCliSuccess(created, { json }));
      return;
    }
    const created = await client.requestJson('POST', `/api/workspace/sessions/${encodeURIComponent(sessionId)}/windows`, {
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.cwd ? { cwd: absolutePath(parsed.cwd, cwd) } : {}),
    });
    writeOut(formatCliSuccess(created, { json }));
    return;
  }
  usageError(['workspace']);
}

async function cmdWorktree({ args, client, json, writeOut, cwd }) {
  const parsed = parseWorktreeArgs(args, cwd);
  const repo = absolutePath(parsed.repo, cwd);
  if (parsed.sub === 'list') {
    const data = await client.requestJson('GET', `/api/worktrees?path=${encodeURIComponent(repo)}`);
    writeOut(formatCliSuccess(data, { json }));
    return;
  }
  if (parsed.sub === 'new' && parsed.target) {
    const data = await client.requestJson('POST', '/api/worktrees', {
      path: repo,
      branch: parsed.target,
      ...(parsed.baseRef ? { baseRef: parsed.baseRef } : {}),
      openWindow: parsed.openWindow,
    });
    writeOut(formatCliSuccess(data, { json }));
    return;
  }
  if (parsed.sub === 'remove' && parsed.target) {
    const data = await client.requestJson('DELETE', '/api/worktrees', {
      path: repo,
      worktreePath: absolutePath(parsed.target, cwd),
      force: parsed.force,
    });
    writeOut(formatCliSuccess(data, { json }));
    return;
  }
  usageError(['worktree']);
}

async function cmdSessions({ args, client, json, writeOut }) {
  const { provider, q, limit } = parseSessionsArgs(args);
  const query = new URLSearchParams();
  if (provider) query.set('provider', provider);
  if (q) query.set('q', q);
  if (limit) query.set('limit', String(limit));
  const data = await client.requestJson('GET', `/api/session-vault/sessions?${query}`);
  writeOut(formatCliSuccess(data, { json }));
}

async function cmdAutomation({ args, client, json, writeOut }) {
  const sub = args.shift() || 'list';
  if (sub === 'list') {
    const data = await client.requestJson('GET', '/api/automations');
    writeOut(formatCliSuccess(data, { json }));
    return;
  }
  if (sub === 'run' && args[0]) {
    const data = await client.requestJson('POST', `/api/automations/${encodeURIComponent(args[0])}/run`, {});
    writeOut(formatCliSuccess(data, { json }));
    return;
  }
  usageError(['automation']);
}

async function cmdPane({ args, client, json, writeOut, env }) {
  const parsed = parsePaneArgs(args, currentPane(env));
  if (parsed.sub === 'new' || parsed.sub === 'open') {
    const winId = parsed.windowId || (await client.requestJson('GET', '/api/workspace'))?.sessions?.[0]?.windows?.[0]?.id;
    if (!winId) throw new CliError('invalid_argument', 'window id required (--window @id)', { exitCode: 2 });
    const direction = parsed.dir === 'v' || parsed.dir === 'vertical' ? 'vertical' : 'horizontal';
    if (parsed.sub === 'open' && !parsed.kind) {
      throw new CliError('invalid_argument', 'pane kind required (e.g. browser|diff|doc)', { exitCode: 2 });
    }
    const data = await client.requestJson('POST', `/api/workspace/windows/${encodeURIComponent(winId)}/panes`, {
      ...(parsed.pane ? { paneId: parsed.pane } : {}),
      direction,
      ...(parsed.sub === 'open' ? { kind: parsed.kind, ...(parsed.payload ? { payload: parsed.payload } : {}), ...(parsed.label ? { label: parsed.label } : {}) } : {}),
    });
    writeOut(formatCliSuccess(data, { json }));
    return;
  }
  if (!parsed.pane) throw new CliError('invalid_argument', 'pane id required (--pane %N)', { exitCode: 2 });
  const encodedPane = encodeURIComponent(parsed.pane);
  if (parsed.sub === 'set-kind') {
    if (!parsed.kind) throw new CliError('invalid_argument', 'pane kind required (e.g. terminal|browser|diff|doc)', { exitCode: 2 });
    const body = { kind: parsed.kind, ...(parsed.payload !== '' ? { payload: parsed.payload } : {}) };
    const data = await client.requestJson('PATCH', `/api/workspace/panes/${encodedPane}`, body);
    writeOut(formatCliSuccess(data, { json, formatText: (d) => JSON.stringify(d) }));
  } else if (parsed.sub === 'zoom') {
    const data = await client.requestJson('POST', `/api/workspace/panes/${encodedPane}/zoom`, {});
    writeOut(formatCliSuccess(data, { json, formatText: (d) => JSON.stringify(d) }));
  } else if (parsed.sub === 'break') {
    const data = await client.requestJson('POST', `/api/workspace/panes/${encodedPane}/break`, {});
    writeOut(formatCliSuccess(data, { json, formatText: (d) => JSON.stringify(d) }));
  } else if (parsed.sub === 'clear') {
    const data = await client.requestJson('POST', `/api/workspace/panes/${encodedPane}/clear`, {});
    writeOut(formatCliSuccess(data, { json, formatText: (d) => JSON.stringify(d) }));
  } else if (parsed.sub === 'rename' && parsed.label) {
    const data = await client.requestJson('PATCH', `/api/workspace/panes/${encodedPane}`, { label: parsed.label });
    writeOut(formatCliSuccess(data, { json, formatText: (d) => JSON.stringify(d) }));
  } else {
    usageError(['pane']);
  }
}

async function cmdBrowser({ args, client, json, writeOut, env }) {
  const sub = args.shift() || 'status';
  if (sub === 'status') {
    const status = await client.requestJson('GET', '/api/browser/agent-browser');
    writeOut(formatCliSuccess(status, { json }));
    return;
  }
  if (sub === 'open' || sub === 'snapshot' || sub === 'screenshot' || sub === 'get-url' || sub === 'close') {
    try {
      const result = await client.requestJson('POST', '/api/browser/agent-browser', { command: sub, args });
      writeOut(formatCliSuccess(result, { json }));
      return;
    } catch (err) {
      if (sub === 'open' && args[0] && /^https?:\/\//i.test(args[0])) {
        const opened = await client.postJson('/api/open', { url: args[0], ...(currentPane(env) ? { paneId: currentPane(env) } : {}) });
        writeOut(formatCliSuccess(opened, { json }));
        return;
      }
      throw err;
    }
  }
  usageError(['browser']);
}

export async function runCli(argv, deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const pid = deps.pid ?? process.pid;
  const platform = deps.platform || process.platform;
  const scriptPath = deps.scriptPath !== undefined ? deps.scriptPath : process.argv[1];
  const writeOut = deps.writeOut || ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr || ((text) => process.stderr.write(text));
  const execTmux = deps.execTmux || tmux;

  let jsonFlag = false;
  try {
    const parsed = extractGlobalOptions(argv, env);
    jsonFlag = parsed.json;
    const args = parsed.args;
    const serverId = parsed.serverId;

    if (parsed.version && args.length === 0) {
      writeOut(formatCliSuccess({ version: CLI_VERSION }, {
        json: jsonFlag,
        formatText: (d) => d.version,
      }));
      return 0;
    }

    if (args[0] === 'help') {
      const target = helpPathFromTokens(args.slice(1));
      const helpText = target.length ? formatCommandHelp(target) : formatRootHelp();
      if (!helpText) {
        throw new CliError('unknown_command', `Unknown help topic: ${args.slice(1).join(' ')}`, {
          nextSteps: ['Run `anymux --help` to see available commands.'],
          exitCode: 2,
        });
      }
      writeOut(helpText + '\n');
      return 0;
    }

    if (parsed.help || args.length === 0) {
      const target = helpPathFromTokens(args);
      const helpText = target.length ? (formatCommandHelp(target) || formatRootHelp()) : formatRootHelp();
      writeOut(helpText + '\n');
      return 0;
    }

    const client = deps.client || createPanelClient({
      serverId,
      env,
      ...(deps.readPairingFn ? { readPairingFn: deps.readPairingFn } : {}),
      ...(deps.transport ? { transport: deps.transport } : {}),
    });

    const [command, ...restArgs] = args;
    switch (command) {
      case 'status':
        await cmdStatus({ client, json: jsonFlag, writeOut });
        return 0;
      case 'agent-context':
        cmdAgentContext({ serverId, json: jsonFlag, writeOut });
        return 0;
      case 'server':
      case 'servers':
        await cmdServer({ args: restArgs, client, json: jsonFlag, writeOut });
        return 0;
      case 'skills':
        await cmdSkills({
          args: restArgs,
          client,
          json: jsonFlag,
          writeOut,
          projectDir: deps.projectDir,
          userHome: deps.userHome,
          env,
        });
        return 0;
      case 'open':
        await cmdOpen({ args: restArgs, client, json: jsonFlag, writeOut, env, pid, cwd, scriptPath });
        return 0;
      case 'doc':
        await cmdDoc({ args: restArgs, client, json: jsonFlag, writeOut, cwd, platform });
        return 0;
      case 'git':
        await cmdGit({ args: restArgs, client, json: jsonFlag, writeOut, env, pid, cwd, scriptPath });
        return 0;
      case 'workspace':
        await cmdWorkspace({ args: restArgs, client, json: jsonFlag, writeOut, cwd });
        return 0;
      case 'worktree':
        await cmdWorktree({ args: restArgs, client, json: jsonFlag, writeOut, cwd });
        return 0;
      case 'sessions':
        await cmdSessions({ args: restArgs, client, json: jsonFlag, writeOut });
        return 0;
      case 'automation':
        await cmdAutomation({ args: restArgs, client, json: jsonFlag, writeOut });
        return 0;
      case 'pane':
        await cmdPane({ args: restArgs, client, json: jsonFlag, writeOut, env });
        return 0;
      case 'browser':
        await cmdBrowser({ args: restArgs, client, json: jsonFlag, writeOut, env });
        return 0;
      case 'split':
        cmdSplit({ args: restArgs, serverId, json: jsonFlag, writeOut, env, cwd, execTmux });
        return 0;
      case 'run':
        cmdRun({ args: restArgs, serverId, json: jsonFlag, writeOut, env, execTmux });
        return 0;
      case 'capture':
        cmdCapture({ args: restArgs, serverId, json: jsonFlag, writeOut, env, execTmux });
        return 0;
      case 'events':
        cmdEvents({ args: restArgs, serverId, writeOut });
        return 0;
      default: {
        const candidates = suggestCommands(command);
        const nextSteps = [];
        if (candidates.length) nextSteps.push(`Did you mean: ${candidates.join(', ')}?`);
        nextSteps.push('Run `anymux --help` or `anymux agent-context --json`.');
        throw new CliError('unknown_command', `Unknown command: ${command}`, {
          data: { command, suggestions: candidates },
          nextSteps,
          exitCode: 2,
        });
      }
    }
  } catch (error) {
    const formatted = formatCliError(error, { json: jsonFlag });
    if (formatted.stream === 'stdout') writeOut(formatted.text);
    else writeErr(formatted.text);
    return formatted.exitCode;
  }
}

const invokedDirectly = process.argv[1] && /anymux(\.mjs)?$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code) process.exit(code);
  });
}
