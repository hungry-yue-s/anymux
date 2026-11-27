import { access, constants, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { replaceFile } from './atomic-file.js';
import { appDir } from './legacy-names.js';
import { atomicWriteFile, backupAndPruneFile, withInstallLock } from './agent-hooks/install-lock.js';

export const EVENT_SPECS = [
  ['SessionStart', 'session_start'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['PreToolUse', 'pre_tool_use'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'agent_stop'],
  ['PermissionRequest', 'permission_wait'],
  ['Notification', 'notification'],
  ['StopFailure', 'stop_failure'],
  ['SessionEnd', 'session_end'],
  ['SubagentStart', 'subagent_start'],
  ['SubagentStop', 'subagent_stop'],
];

export const GEMINI_EVENT_SPECS = [
  ['SessionStart', 'session_start'],
  ['BeforeAgent', 'user_prompt_submit'],
  ['BeforeTool', 'pre_tool_use'],
  ['AfterTool', 'post_tool_use'],
  ['AfterAgent', 'agent_stop'],
  ['Notification', 'notification'],
  ['SessionEnd', 'session_end'],
];

export const ANTIGRAVITY_EVENT_SPECS = [
  ['SessionStart', 'session_start', { grouped: false, stdoutJson: '{}' }],
  ['PreInvocation', 'pre_invocation', { grouped: false, stdoutJson: '{}' }],
  ['PostInvocation', 'post_invocation', { grouped: false, stdoutJson: '{}' }],
  ['PreToolUse', 'pre_tool_use', { grouped: true, stdoutJson: '' }],
  ['PostToolUse', 'post_tool_use', { grouped: true, stdoutJson: '{}' }],
  ['Stop', 'agent_stop', { grouped: false, stdoutJson: '{"decision":""}' }],
];

export const DSH_EVENT_SPECS = [
  ['SessionStart', 'session_start'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['PreToolUse', 'pre_tool_use'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'agent_stop'],
  ['SubagentStart', 'subagent_start'],
  ['SubagentStop', 'subagent_stop'],
];

export const HOOK_AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    homeSubdir: '.claude',
    envVar: 'CLAUDE_CONFIG_DIR',
    configFile: 'settings.json',
    cliBins: ['claude'],
    schemaClean: true,
    events: EVENT_SPECS,
    root() { return {}; },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    homeSubdir: '.codex',
    envVar: 'CODEX_HOME',
    configFile: 'hooks.json',
    cliBins: ['codex'],
    schemaClean: false,
    events: EVENT_SPECS,
    root() { return { description: 'Codex hooks.', hooks: {} }; },
  },
  qoder: {
    id: 'qoder',
    label: 'Qoder',
    homeSubdir: '.qoder',
    envVar: 'QODER_CONFIG_DIR',
    configFile: 'settings.json',
    cliBins: ['qoder', 'qodercli'],
    schemaClean: false,
    events: EVENT_SPECS,
    root() { return {}; },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    homeSubdir: '.gemini',
    envVar: 'GEMINI_CLI_HOME',
    configFile: 'settings.json',
    cliBins: ['gemini'],
    schemaClean: true,
    events: GEMINI_EVENT_SPECS,
    root() { return {}; },
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity (agy)',
    homeSubdir: join('.gemini', 'config'),
    envVar: 'ANTIGRAVITY_CONFIG_DIR',
    configFile: 'hooks.json',
    cliBins: ['agy'],
    format: 'antigravity-named',
    managedKey: 'anymux-status',
    events: ANTIGRAVITY_EVENT_SPECS,
    root() { return {}; },
  },
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness (dsh)',
    homeSubdir: '.dsh',
    envVar: 'DSH_HOME',
    configFile: 'cordis.patch.yml',
    cliBins: ['dsh', 'dsh-tui'],
    format: 'dsh-cordis',
    events: DSH_EVENT_SPECS,
    root() { return {}; },
  },
};

export const DEFAULT_AGENTS = ['claude', 'qoder', 'codex'];
const MARKER_PREFIX = 'anymux-';
const LEGACY_MARKER_PREFIX = 'tmux-web-panel-';
const LEGACY_CLAUDE_BELL_MARKER = "printf '\\a'";
const MANAGED_ROUTER_VERSION = 'anymux-managed-hook-router v6';
const DSH_BEGIN = '# >>> anymux-managed-dsh-hooks (managed by Anymux; do not edit) >>>';
const DSH_END = '# <<< anymux-managed-dsh-hooks <<<';

function shSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function cmdDoubleQuote(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

function extraSearchDirs(home, platform) {
  if (platform === 'win32') return [];
  return [
    join(home, '.local', 'bin'),
    join(home, '.gemini', 'antigravity-cli', 'bin'),
    join(home, '.qoder', 'entry'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

async function isExecutableFile(filePath, platform) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectAgentCli(agentId, {
  home = homedir(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const spec = HOOK_AGENTS[agentId];
  if (!spec) return { found: false, path: null };

  const delimiter = platform === 'win32' ? ';' : ':';
  const rawPath = String(env.PATH || '');
  const dirs = [...new Set([
    ...rawPath.split(delimiter).filter(Boolean),
    ...extraSearchDirs(home, platform),
  ])];
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const bin of spec.cliBins) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, bin + ext);
        if (await isExecutableFile(candidate, platform)) {
          return { found: true, path: candidate };
        }
      }
    }
  }
  return { found: false, path: null };
}

export function resolveAgentConfigPath(agentId, { home = homedir(), env = process.env } = {}) {
  const spec = HOOK_AGENTS[agentId];
  if (!spec) throw new Error(`Unknown hook agent: ${agentId}`);
  const moved = env[spec.envVar];
  const baseDir = typeof moved === 'string' && moved.trim()
    ? resolve(moved.trim())
    : join(home, spec.homeSubdir);
  return join(baseDir, spec.configFile);
}

export function buildHookCommand({
  agent,
  eventName,
  scriptPath,
  nodeBin = process.execPath,
  platform = process.platform,
  stdoutJson = '',
} = {}) {
  if (platform === 'win32') {
    const suffix = stdoutJson ? ` --stdout-json ${cmdDoubleQuote(stdoutJson)}` : '';
    return `${cmdDoubleQuote(nodeBin)} ${cmdDoubleQuote(scriptPath)} --agent ${agent} --event ${eventName}${suffix}`;
  }
  const stdoutArg = stdoutJson ? ` --stdout-json ${shSingleQuote(stdoutJson)}` : '';
  const invoke = `${shSingleQuote(nodeBin)} ${shSingleQuote(scriptPath)} --agent ${agent} --event ${eventName}${stdoutArg}`;
  const fallback = stdoutJson
    ? `printf '%s\\n' ${shSingleQuote(stdoutJson)}; cat >/dev/null 2>&1 || :`
    : 'cat >/dev/null 2>&1 || :';
  return `if [ -n "\${TMUX_PANE-}" ] && [ -f ${shSingleQuote(scriptPath)} ]; then ${invoke}; else ${fallback}; fi`;
}

export function renderManagedRouterScript({
  nodeBin = process.execPath,
  configDir = appDir('config'),
  defaultPanelUrl = 'https://127.0.0.1:7681/api/agent-events',
  defaultTokenFileName = 'tokens.json',
  platform = process.platform,
} = {}) {
  const shebang = platform !== 'win32' && nodeBin.startsWith('/') && !/\s/.test(nodeBin)
    ? `#!${nodeBin}`
    : '#!/usr/bin/env node';

  return `${shebang}
// ${MANAGED_ROUTER_VERSION} — Managed by Anymux. Changes are overwritten on startup.

import http from 'node:http';
import https from 'node:https';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CONFIG_DIR = ${JSON.stringify(configDir)};
const DEFAULT_PANEL_URL = ${JSON.stringify(defaultPanelUrl)};
const DEFAULT_TOKEN_FILE = ${JSON.stringify(defaultTokenFileName)};

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

function parseArgs(argv) {
  const args = { bell: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-bell') args.bell = false;
    else if (arg === '--bell') args.bell = true;
    else if (arg.startsWith('--') && i + 1 < argv.length) args[arg.slice(2)] = argv[++i];
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

function readEndpointConfig(configDir) {
  try {
    const raw = readFileSync(join(configDir, 'hook-endpoint.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function localPanelToken(configDir, tokenFileName) {
  try {
    const file = join(configDir, tokenFileName || DEFAULT_TOKEN_FILE);
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

function postJson(url, payload, token) {
  if (!url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      rejectUnauthorized: !(target.hostname === '127.0.0.1' || target.hostname === 'localhost'),
      timeout: 1500,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        resolve();
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function spoolFailedEvent(configDir, payload) {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const spoolPath = join(configDir, 'agent-hook-spool.jsonl');
    const line = JSON.stringify({ ...payload, receivedAt: Date.now() }) + '\\n';
    if (existsSync(spoolPath)) {
      const prev = readFileSync(spoolPath, 'utf8');
      const lines = prev.split('\\n').filter(Boolean);
      if (lines.length >= 1000 || Buffer.byteLength(prev) + Buffer.byteLength(line) > 512 * 1024) {
        const kept = lines.slice(-900);
        kept.push(line.trimEnd());
        writeFileSync(spoolPath, kept.join('\\n') + '\\n', { mode: 0o600 });
        return;
      }
    }
    appendFileSync(spoolPath, line, { mode: 0o600 });
  } catch {
    // Spooling is best effort; never fail hook command exit status.
  }
}

function parseTmuxServerPid(tmuxEnv) {
  const parts = String(tmuxEnv || '').split(',');
  if (parts.length < 3) return '';
  const pid = parts[parts.length - 2].trim();
  return /^\\d+$/.test(pid) ? pid : '';
}

const args = parseArgs(process.argv);
if (args['stdout-json']) {
  process.stdout.write(String(args['stdout-json']) + '\\n');
}
const input = await readStdin();
const event = args.event || input.hook_event_name || input.hookEventName || input.event || 'notification';
const session = args.session || input.session || input.tmux_session || '';
const windowId = args.windowId || args['window-id'] || input.windowId || input.window_id || '';
const paneId = args.paneId || args['pane-id'] || input.paneId || input.pane_id || process.env.TMUX_PANE || '';
const tmuxServerPid = args.tmuxServerPid || args['tmux-server-pid'] || input.tmuxServerPid || input.tmux_server_pid || parseTmuxServerPid(process.env.TMUX);

if (!paneId && !session && !windowId && !process.env.TMUX && !process.env.TMUX_PANE) {
  process.exit(0);
}

const envConversationId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
const payload = {
  ...input,
  ...(envConversationId && !input.conversationId && !input.conversation_id ? { conversationId: envConversationId } : {}),
  agent: args.agent || input.agent || input.source || 'agent',
  event,
  session,
  windowIndex: args.windowIndex ?? args['window-index'] ?? input.windowIndex ?? input.window_index,
  windowId,
  paneId,
  ...(tmuxServerPid ? { tmuxServerPid } : {}),
  tty: args.tty || input.tty || process.env.TTY || '',
};

if (args.bell && BELL_EVENTS.has(event)) {
  try {
    writeFileSync('/dev/tty', '\\u0007');
  } catch {
    // Best effort.
  }
}

const configDir = process.env.ANYMUX_CONFIG_DIR || DEFAULT_CONFIG_DIR;
const endpoint = readEndpointConfig(configDir);
const effectiveConfigDir = endpoint.configDir || configDir;
const panelUrl = args.panelUrl || args['panel-url'] || process.env.ANYMUX_AGENT_EVENTS_URL || endpoint.url || DEFAULT_PANEL_URL;
const panelToken = args.panelToken || args['panel-token'] || process.env.ANYMUX_TOKEN || localPanelToken(effectiveConfigDir, endpoint.tokenFileName);
const monitorUrl = args.monitorUrl || args['monitor-url'] || process.env.AGENT_MONITOR_URL || '';
const monitorToken = args.monitorToken || args['monitor-token'] || process.env.AGENT_MONITOR_TOKEN || '';

const deliveries = await Promise.allSettled([
  postJson(panelUrl, payload, panelToken),
  postJson(monitorUrl, payload, monitorToken),
]);
if (panelUrl && deliveries[0]?.status === 'rejected') {
  spoolFailedEvent(effectiveConfigDir, payload);
}
`;
}

function installedNames(agent, hookEvent, prefix = MARKER_PREFIX) {
  const names = [`${prefix}${agent}-${hookEvent}`];
  if (agent === 'qoder') names.push(`${prefix}${hookEvent}`);
  return names;
}

function isManagedHook(hook, agent, hookEvent, prefixes = [MARKER_PREFIX, LEGACY_MARKER_PREFIX]) {
  if (!hook || typeof hook !== 'object') return false;
  if (typeof hook.command === 'string') {
    if (hook.command.includes(LEGACY_CLAUDE_BELL_MARKER)) return true;
    if (hook.command.includes('agent-event-router.js') || hook.command.includes('agent-event-router.mjs')) {
      return true;
    }
  }
  if (typeof hook.name === 'string') {
    return prefixes.some((prefix) => (
      hook.name.startsWith(`${prefix}${agent}-`)
      || (hookEvent && installedNames(agent, hookEvent, prefix).includes(hook.name))
      || (agent === 'qoder' && hook.name.startsWith(prefix))
    ));
  }
  return false;
}

function hookFor(agent, hookEvent, eventName, { scriptPath, nodeBin, platform }) {
  const spec = HOOK_AGENTS[agent];
  const command = buildHookCommand({ agent, eventName, scriptPath, nodeBin, platform });
  if (spec.schemaClean) {
    return {
      type: 'command',
      command,
      async: true,
      timeout: 5,
    };
  }
  return {
    type: 'command',
    command,
    name: `${MARKER_PREFIX}${agent}-${hookEvent}`,
    async: true,
    timeout: 5,
  };
}

function sameHookDefinition(existing, desired, schemaClean) {
  if (!existing || typeof existing !== 'object') return false;
  if (existing.type !== desired.type) return false;
  if (existing.command !== desired.command) return false;
  if (Boolean(existing.async) !== Boolean(desired.async)) return false;
  if (existing.timeout !== desired.timeout) return false;
  if (schemaClean) return existing.name === undefined && existing.args === undefined;
  return existing.name === desired.name && existing.args === undefined;
}

function installHooksIntoObject(agent, root, { scriptPath, nodeBin, platform }) {
  const spec = HOOK_AGENTS[agent];
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    root.hooks = {};
  }
  const hooks = root.hooks;
  const targetEventMap = new Map(spec.events);
  let changed = 0;

  // Strip managed hooks from events no longer targeted by this agent
  for (const existingEvent of Object.keys(hooks)) {
    if (targetEventMap.has(existingEvent)) continue;
    const list = Array.isArray(hooks[existingEvent]) ? hooks[existingEvent] : [];
    const next = [];
    for (const entry of list) {
      if (!Array.isArray(entry?.hooks)) {
        next.push(entry);
        continue;
      }
      const filtered = entry.hooks.filter((h) => !isManagedHook(h, agent, existingEvent));
      if (filtered.length !== entry.hooks.length) changed += 1;
      if (filtered.length > 0) next.push({ ...entry, hooks: filtered });
    }
    if (next.length > 0) hooks[existingEvent] = next;
    else if (hooks[existingEvent] !== undefined) {
      delete hooks[existingEvent];
      changed += 1;
    }
  }

  // Reconcile each expected event cleanly while preserving unrelated third-party hooks
  for (const [hookEvent, eventName] of spec.events) {
    const desired = hookFor(agent, hookEvent, eventName, { scriptPath, nodeBin, platform });
    const list = Array.isArray(hooks[hookEvent]) ? hooks[hookEvent] : [];
    const nextList = [];
    let hasExact = false;

    for (const entry of list) {
      if (!Array.isArray(entry?.hooks)) {
        nextList.push(entry);
        continue;
      }
      const kept = [];
      for (const h of entry.hooks) {
        if (!isManagedHook(h, agent, hookEvent)) {
          kept.push(h);
        } else if (!hasExact && sameHookDefinition(h, desired, spec.schemaClean)) {
          kept.push(h);
          hasExact = true;
        } else {
          changed += 1;
        }
      }
      if (kept.length > 0) {
        nextList.push(kept.length === entry.hooks.length ? entry : { ...entry, hooks: kept });
      }
    }

    if (!hasExact) {
      nextList.push({ matcher: '*', hooks: [desired] });
      changed += 1;
    }

    if (nextList.length > 0) hooks[hookEvent] = nextList;
  }

  return { added: changed };
}

function uninstallHooksFromObject(agent, root, prefixes = [MARKER_PREFIX, LEGACY_MARKER_PREFIX]) {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    return { removed: 0 };
  }
  const hooks = root.hooks;
  let removed = 0;

  for (const hookEvent of Object.keys(hooks)) {
    const list = Array.isArray(hooks[hookEvent]) ? hooks[hookEvent] : [];
    const next = [];
    for (const entry of list) {
      if (!Array.isArray(entry?.hooks)) {
        next.push(entry);
        continue;
      }
      const filtered = entry.hooks.filter((h) => !isManagedHook(h, agent, hookEvent, prefixes));
      removed += entry.hooks.length - filtered.length;
      if (filtered.length > 0) {
        next.push(filtered.length === entry.hooks.length ? entry : { ...entry, hooks: filtered });
      }
    }
    if (next.length > 0) hooks[hookEvent] = next;
    else delete hooks[hookEvent];
  }

  return { removed };
}

function antigravityDesiredBlock(agentId, { scriptPath, nodeBin, platform }) {
  const spec = HOOK_AGENTS[agentId];
  const block = {};
  for (const [hookEvent, eventName, opts = {}] of spec.events) {
    const handler = {
      type: 'command',
      command: buildHookCommand({
        agent: agentId,
        eventName,
        scriptPath,
        nodeBin,
        platform,
        stdoutJson: opts.stdoutJson || '',
      }),
      timeout: 5,
    };
    block[hookEvent] = opts.grouped ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  return block;
}

function inspectAntigravityObject(agentId, parsed, { scriptPath, nodeBin, platform }) {
  const spec = HOOK_AGENTS[agentId];
  const desired = antigravityDesiredBlock(agentId, { scriptPath, nodeBin, platform });
  const section = parsed?.[spec.managedKey];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { exactCount: 0, outdatedCount: 0 };
  }
  let exactCount = 0;
  let outdatedCount = 0;
  const expectedKeys = new Set(spec.events.map(([k]) => k));
  for (const [hookEvent] of spec.events) {
    if (section[hookEvent] === undefined) continue;
    if (JSON.stringify(section[hookEvent]) === JSON.stringify(desired[hookEvent])) {
      exactCount += 1;
    } else {
      outdatedCount += 1;
    }
  }
  for (const key of Object.keys(section)) {
    if (!expectedKeys.has(key)) outdatedCount += 1;
  }
  return { exactCount, outdatedCount };
}

function installAntigravityHooksIntoObject(agentId, root, { scriptPath, nodeBin, platform }) {
  const spec = HOOK_AGENTS[agentId];
  const desired = antigravityDesiredBlock(agentId, { scriptPath, nodeBin, platform });
  if (JSON.stringify(root[spec.managedKey]) === JSON.stringify(desired)) {
    return { added: 0 };
  }
  root[spec.managedKey] = desired;
  return { added: spec.events.length };
}

function uninstallAntigravityHooksFromObject(agentId, root) {
  const spec = HOOK_AGENTS[agentId];
  if (!root || typeof root !== 'object' || !Object.hasOwn(root, spec.managedKey)) {
    return { removed: 0 };
  }
  delete root[spec.managedKey];
  return { removed: spec.events.length };
}

function dshDesiredHooksObject({ scriptPath, nodeBin, platform }) {
  const hooks = {};
  for (const [hookEvent, eventName] of HOOK_AGENTS.dsh.events) {
    hooks[hookEvent] = [{
      hooks: [{
        type: 'command',
        command: buildHookCommand({
          agent: 'dsh',
          eventName,
          scriptPath,
          nodeBin,
          platform,
        }),
        timeout: 5,
      }],
    }];
  }
  return { hooks };
}

function renderDshCordisBlock(dshHooksPath) {
  const quoted = "'" + String(dshHooksPath).replace(/'/g, "''") + "'";
  return [
    DSH_BEGIN,
    '- insert:',
    '    - id: anymux-agent-hooks',
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: ${quoted}`,
    DSH_END,
  ].join('\n');
}

function dshCordisSpan(text) {
  const start = text.indexOf(DSH_BEGIN);
  const end = text.indexOf(DSH_END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < 0 || end < start || text.indexOf(DSH_BEGIN, start + 1) >= 0 || text.indexOf(DSH_END, end + 1) >= 0) {
    return 'malformed';
  }
  return { start, end: end + DSH_END.length };
}

async function readTextOptional(file) {
  try {
    return { text: await readFile(file, 'utf8'), error: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { text: null, error: null };
    return { text: null, error: err };
  }
}

async function readJsonOptional(file) {
  try {
    const raw = await readFile(file, 'utf8');
    return { raw, parsed: JSON.parse(raw), error: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { raw: null, parsed: null, error: null };
    return { raw: null, parsed: null, error: err };
  }
}

async function backupFile(file) {
  return backupAndPruneFile(file, { keep: 3 });
}

export class AgentHookManager {
  constructor({
    dataDir,
    configDir,
    userHome = homedir(),
    env = process.env,
    platform = process.platform,
    nodeBin = process.execPath,
    panelUrl = 'https://127.0.0.1:7681/api/agent-events',
    tokenFileName = 'tokens.json',
    detectCli = detectAgentCli,
  } = {}) {
    this.userHome = userHome;
    this.env = env;
    this.platform = platform;
    this.nodeBin = nodeBin;
    this.panelUrl = panelUrl;
    this.tokenFileName = tokenFileName;
    this.dataDir = dataDir || appDir('data', { home: userHome });
    this.configDir = configDir || appDir('config', { home: userHome });
    this.scriptPath = join(this.dataDir, 'agent-hooks', 'agent-event-router.mjs');
    this.dshHooksPath = join(this.dataDir, 'agent-hooks', 'dsh-hooks.json');
    this.endpointPath = join(this.configDir, 'hook-endpoint.json');
    this.settingsPath = join(this.configDir, 'agent-hooks.json');
    this._detectCli = detectCli;
  }

  async loadSettings() {
    const { parsed } = await readJsonOptional(this.settingsPath);
    if (!parsed || typeof parsed !== 'object') {
      return { autoInstall: true, disabledAgents: [] };
    }
    return {
      autoInstall: parsed.autoInstall !== false,
      disabledAgents: Array.isArray(parsed.disabledAgents)
        ? parsed.disabledAgents.filter((a) => Object.hasOwn(HOOK_AGENTS, a))
        : [],
    };
  }

  async saveSettings(settings) {
    const next = {
      autoInstall: settings.autoInstall !== false,
      disabledAgents: [...new Set(
        Array.isArray(settings.disabledAgents)
          ? settings.disabledAgents.filter((a) => Object.hasOwn(HOOK_AGENTS, a))
          : [],
      )],
    };
    await mkdir(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    await writeFile(this.settingsPath + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await replaceFile(this.settingsPath + '.tmp', this.settingsPath);
    return next;
  }

  async refreshManagedScript() {
    const scriptContent = renderManagedRouterScript({
      nodeBin: this.nodeBin,
      configDir: this.configDir,
      defaultPanelUrl: this.panelUrl,
      defaultTokenFileName: this.tokenFileName,
      platform: this.platform,
    });
    await mkdir(dirname(this.scriptPath), { recursive: true });
    let existingScript = null;
    try { existingScript = await readFile(this.scriptPath, 'utf8'); } catch {}
    if (existingScript !== scriptContent) {
      await writeFile(this.scriptPath + '.tmp', scriptContent, { mode: 0o755 });
      await replaceFile(this.scriptPath + '.tmp', this.scriptPath);
    }

    const endpointPayload = JSON.stringify({
      url: this.panelUrl,
      configDir: this.configDir,
      tokenFileName: this.tokenFileName,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n';
    await mkdir(dirname(this.endpointPath), { recursive: true, mode: 0o700 });
    await writeFile(this.endpointPath + '.tmp', endpointPayload, { mode: 0o600 });
    await replaceFile(this.endpointPath + '.tmp', this.endpointPath);
    return { scriptPath: this.scriptPath, endpointPath: this.endpointPath };
  }

  async _inspectDsh(agentId, spec, cli, disabled, configPath) {
    const { text: ymlRaw, error: ymlError } = await readTextOptional(configPath);
    if (ymlError) {
      return {
        agent: agentId,
        label: spec.label,
        cliFound: cli.found,
        cliPath: cli.path,
        disabled,
        configPath,
        state: 'error',
        detail: ymlError.message,
      };
    }
    const { parsed: jsonParsed, error: jsonError } = await readJsonOptional(this.dshHooksPath);
    if (jsonError) {
      return {
        agent: agentId,
        label: spec.label,
        cliFound: cli.found,
        cliPath: cli.path,
        disabled,
        configPath,
        state: 'error',
        detail: jsonError.message,
      };
    }

    const ymlText = (ymlRaw ?? '').replace(/\r\n/g, '\n');
    const span = dshCordisSpan(ymlText);
    if (span === 'malformed') {
      return {
        agent: agentId,
        label: spec.label,
        cliFound: cli.found,
        cliPath: cli.path,
        disabled,
        configPath,
        state: 'error',
        detail: 'Malformed Anymux markers in cordis.patch.yml',
      };
    }

    const desiredBlock = renderDshCordisBlock(this.dshHooksPath);
    const blockPresent = Boolean(span);
    const blockExact = blockPresent && ymlText.slice(span.start, span.end) === desiredBlock;

    const desiredJson = dshDesiredHooksObject({
      scriptPath: this.scriptPath,
      nodeBin: this.nodeBin,
      platform: this.platform,
    });
    const hooksObj = jsonParsed?.hooks && typeof jsonParsed.hooks === 'object' ? jsonParsed.hooks : {};
    let exactCount = 0;
    let outdatedCount = 0;
    for (const [hookEvent] of spec.events) {
      if (hooksObj[hookEvent] === undefined) continue;
      if (JSON.stringify(hooksObj[hookEvent]) === JSON.stringify(desiredJson.hooks[hookEvent])) {
        exactCount += 1;
      } else {
        outdatedCount += 1;
      }
    }
    if (blockPresent && !blockExact) outdatedCount += 1;

    let state = 'not_installed';
    if (disabled && !blockPresent && exactCount === 0 && outdatedCount === 0) state = 'disabled';
    else if (blockExact && exactCount === spec.events.length && outdatedCount === 0) state = 'installed';
    else if (outdatedCount > 0 || (blockPresent !== (exactCount > 0))) state = 'outdated';
    else if (exactCount > 0) state = 'partial';

    return {
      agent: agentId,
      label: spec.label,
      cliFound: cli.found,
      cliPath: cli.path,
      disabled,
      configPath,
      state,
      installedEvents: blockExact ? exactCount : 0,
      totalEvents: spec.events.length,
    };
  }

  async inspectAgent(agentId, settings = null) {
    const spec = HOOK_AGENTS[agentId];
    if (!spec) throw new Error(`Unknown hook agent: ${agentId}`);
    const cfg = settings || await this.loadSettings();
    const configPath = resolveAgentConfigPath(agentId, { home: this.userHome, env: this.env });
    const cli = await this._detectCli(agentId, { home: this.userHome, env: this.env, platform: this.platform });
    const disabled = cfg.disabledAgents.includes(agentId);

    if (spec.format === 'dsh-cordis') {
      return this._inspectDsh(agentId, spec, cli, disabled, configPath);
    }

    const { parsed, error } = await readJsonOptional(configPath);

    if (error) {
      return {
        agent: agentId,
        label: spec.label,
        cliFound: cli.found,
        cliPath: cli.path,
        disabled,
        configPath,
        state: 'error',
        detail: error.message,
      };
    }

    let exactCount = 0;
    let outdatedCount = 0;

    if (spec.format === 'antigravity-named') {
      ({ exactCount, outdatedCount } = inspectAntigravityObject(agentId, parsed, {
        scriptPath: this.scriptPath,
        nodeBin: this.nodeBin,
        platform: this.platform,
      }));
    } else {
      const hooks = parsed?.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {};
      for (const [hookEvent, eventName] of spec.events) {
        const desired = hookFor(agentId, hookEvent, eventName, {
          scriptPath: this.scriptPath,
          nodeBin: this.nodeBin,
          platform: this.platform,
        });
        const list = Array.isArray(hooks[hookEvent]) ? hooks[hookEvent] : [];
        const entries = list.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
        if (entries.some((h) => sameHookDefinition(h, desired, spec.schemaClean))) {
          exactCount += 1;
        } else if (entries.some((h) => isManagedHook(h, agentId, hookEvent))) {
          outdatedCount += 1;
        }
      }

      // Also count outdated managed hooks sitting on extraneous event keys
      const expectedKeys = new Set(spec.events.map(([k]) => k));
      for (const [k, list] of Object.entries(hooks)) {
        if (expectedKeys.has(k) || !Array.isArray(list)) continue;
        if (list.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => isManagedHook(h, agentId, k)))) {
          outdatedCount += 1;
        }
      }
    }

    let state = 'not_installed';
    if (disabled && exactCount === 0 && outdatedCount === 0) state = 'disabled';
    else if (exactCount === spec.events.length && outdatedCount === 0) state = 'installed';
    else if (outdatedCount > 0) state = 'outdated';
    else if (exactCount > 0) state = 'partial';

    return {
      agent: agentId,
      label: spec.label,
      cliFound: cli.found,
      cliPath: cli.path,
      disabled,
      configPath,
      state,
      installedEvents: exactCount,
      totalEvents: spec.events.length,
    };
  }

  async status() {
    const settings = await this.loadSettings();
    const agents = await Promise.all(
      Object.keys(HOOK_AGENTS).map((agentId) => this.inspectAgent(agentId, settings)),
    );
    return {
      autoInstall: settings.autoInstall,
      disabledAgents: settings.disabledAgents,
      scriptPath: this.scriptPath,
      scriptReady: existsSync(this.scriptPath),
      endpointPath: this.endpointPath,
      agents,
    };
  }

  async _resolveTargets(target, { respectCli = false, settings = null } = {}) {
    if (target && target !== 'all') {
      if (!Object.hasOwn(HOOK_AGENTS, target)) throw new Error(`Unknown hook agent: ${target}`);
      return [target];
    }
    if (!respectCli) return [...DEFAULT_AGENTS];
    const cfg = settings || await this.loadSettings();
    const disabledSet = new Set(cfg.disabledAgents);
    const detected = [];
    for (const agentId of Object.keys(HOOK_AGENTS)) {
      if (disabledSet.has(agentId)) continue;
      const cli = await this._detectCli(agentId, { home: this.userHome, env: this.env, platform: this.platform });
      if (cli.found) detected.push(agentId);
    }
    return detected;
  }

  async _installDsh(agentId, configPath) {
    const desiredJsonText = JSON.stringify(dshDesiredHooksObject({
      scriptPath: this.scriptPath,
      nodeBin: this.nodeBin,
      platform: this.platform,
    }), null, 2) + '\n';
    const { text: prevJsonText } = await readTextOptional(this.dshHooksPath);
    const jsonChanged = prevJsonText !== desiredJsonText;
    if (jsonChanged) {
      await mkdir(dirname(this.dshHooksPath), { recursive: true });
      await writeFile(this.dshHooksPath + '.tmp', desiredJsonText, { mode: 0o644 });
      await replaceFile(this.dshHooksPath + '.tmp', this.dshHooksPath);
    }

    const { text: rawYml, error: ymlError } = await readTextOptional(configPath);
    if (ymlError) {
      return { agent: agentId, path: configPath, backup: null, added: jsonChanged ? HOOK_AGENTS[agentId].events.length : 0, error: ymlError.message };
    }
    const normalizedYml = (rawYml ?? '').replace(/\r\n/g, '\n');
    const span = dshCordisSpan(normalizedYml);
    if (span === 'malformed') {
      return { agent: agentId, path: configPath, backup: null, added: jsonChanged ? HOOK_AGENTS[agentId].events.length : 0, error: 'Malformed Anymux markers in cordis.patch.yml' };
    }
    const block = renderDshCordisBlock(this.dshHooksPath);
    let nextYml = normalizedYml;
    if (span) {
      nextYml = normalizedYml.slice(0, span.start) + block + normalizedYml.slice(span.end);
    } else {
      nextYml = (normalizedYml.trim() ? normalizedYml.replace(/\n*$/, '\n') : '') + block + '\n';
    }
    if (nextYml === normalizedYml && rawYml !== null) {
      return { agent: agentId, path: configPath, backup: null, added: jsonChanged ? HOOK_AGENTS[agentId].events.length : 0 };
    }
    await mkdir(dirname(configPath), { recursive: true });
    const backup = await backupFile(configPath);
    const output = rawYml && rawYml.includes('\r\n') ? nextYml.replace(/\n/g, '\r\n') : nextYml;
    await atomicWriteFile(configPath, output);
    return { agent: agentId, path: configPath, backup, added: HOOK_AGENTS[agentId].events.length };
  }

  async _uninstallDsh(agentId, configPath) {
    let removed = 0;
    try {
      await unlink(this.dshHooksPath);
      removed += HOOK_AGENTS[agentId].events.length;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const { text: rawYml, error: ymlError } = await readTextOptional(configPath);
    if (ymlError) {
      return { agent: agentId, path: configPath, backup: null, removed, error: ymlError.message };
    }
    if (!rawYml) {
      return { agent: agentId, path: configPath, backup: null, removed };
    }
    const normalizedYml = rawYml.replace(/\r\n/g, '\n');
    const span = dshCordisSpan(normalizedYml);
    if (span === 'malformed') {
      return { agent: agentId, path: configPath, backup: null, removed, error: 'Malformed Anymux markers in cordis.patch.yml' };
    }
    if (!span) {
      return { agent: agentId, path: configPath, backup: null, removed };
    }

    const before = normalizedYml.slice(0, span.start).replace(/\n+$/, '');
    const after = normalizedYml.slice(span.end).replace(/^\n+/, '');
    const nextYml = before && after ? `${before}\n${after}` : (before ? `${before}\n` : after);
    const backup = await backupFile(configPath);
    const output = rawYml.includes('\r\n') ? nextYml.replace(/\n/g, '\r\n') : nextYml;
    await atomicWriteFile(configPath, output);
    return { agent: agentId, path: configPath, backup, removed: HOOK_AGENTS[agentId].events.length };
  }

  async install(target = 'all', { respectCli = false } = {}) {
    await this.refreshManagedScript();
    const settings = await this.loadSettings();
    const targets = await this._resolveTargets(target, { respectCli, settings });
    const lockPath = join(this.configDir, 'agent-hooks.lock');
    return withInstallLock(lockPath, async () => {
      const results = [];

      for (const agentId of targets) {
        const spec = HOOK_AGENTS[agentId];
        const configPath = resolveAgentConfigPath(agentId, { home: this.userHome, env: this.env });
        if (spec.format === 'dsh-cordis') {
          results.push(await this._installDsh(agentId, configPath));
          continue;
        }

        const { parsed, error } = await readJsonOptional(configPath);
        if (error) {
          results.push({ agent: agentId, path: configPath, backup: null, added: 0, error: error.message });
          continue;
        }
        const root = parsed && typeof parsed === 'object' ? parsed : spec.root();
        const res = spec.format === 'antigravity-named'
          ? installAntigravityHooksIntoObject(agentId, root, {
              scriptPath: this.scriptPath,
              nodeBin: this.nodeBin,
              platform: this.platform,
            })
          : installHooksIntoObject(agentId, root, {
              scriptPath: this.scriptPath,
              nodeBin: this.nodeBin,
              platform: this.platform,
            });
        if (res.added === 0 && parsed !== null) {
          results.push({ agent: agentId, path: configPath, backup: null, added: 0 });
          continue;
        }
        await mkdir(dirname(configPath), { recursive: true });
        const backup = await backupFile(configPath);
        await atomicWriteFile(configPath, JSON.stringify(root, null, 2) + '\n');
        results.push({ agent: agentId, path: configPath, backup, added: res.added });
      }
      return results;
    });
  }

  async uninstall(target = 'all') {
    const targets = target === 'all'
      ? Object.keys(HOOK_AGENTS)
      : (Object.hasOwn(HOOK_AGENTS, target) ? [target] : (() => { throw new Error(`Unknown hook agent: ${target}`); })());
    const lockPath = join(this.configDir, 'agent-hooks.lock');
    return withInstallLock(lockPath, async () => {
      const results = [];

      for (const agentId of targets) {
        const spec = HOOK_AGENTS[agentId];
        const configPath = resolveAgentConfigPath(agentId, { home: this.userHome, env: this.env });
        if (spec.format === 'dsh-cordis') {
          results.push(await this._uninstallDsh(agentId, configPath));
          continue;
        }

        const { parsed, error } = await readJsonOptional(configPath);
        if (error) {
          results.push({ agent: agentId, path: configPath, backup: null, removed: 0, error: error.message });
          continue;
        }
        if (!parsed || typeof parsed !== 'object') {
          results.push({ agent: agentId, path: configPath, backup: null, removed: 0 });
          continue;
        }
        const res = spec.format === 'antigravity-named'
          ? uninstallAntigravityHooksFromObject(agentId, parsed)
          : uninstallHooksFromObject(agentId, parsed);
        if (res.removed === 0) {
          results.push({ agent: agentId, path: configPath, backup: null, removed: 0 });
          continue;
        }
        await mkdir(dirname(configPath), { recursive: true });
        const backup = await backupFile(configPath);
        await atomicWriteFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
        results.push({ agent: agentId, path: configPath, backup, removed: res.removed });
      }
      return results;
    });
  }

  async reconcileOnStartup() {
    await this.refreshManagedScript();
    const settings = await this.loadSettings();
    if (!settings.autoInstall) {
      return { autoInstall: false, results: [] };
    }
    const disabledResults = [];
    for (const disabledAgent of settings.disabledAgents) {
      disabledResults.push(...await this.uninstall(disabledAgent));
    }
    const results = await this.install('all', { respectCli: true });
    return { autoInstall: true, results: [...results, ...disabledResults] };
  }

  async updateSettings(patch = {}) {
    const current = await this.loadSettings();
    const next = await this.saveSettings({
      autoInstall: patch.autoInstall !== undefined ? Boolean(patch.autoInstall) : current.autoInstall,
      disabledAgents: patch.disabledAgents !== undefined ? patch.disabledAgents : current.disabledAgents,
    });
    if (!next.autoInstall) {
      await this.uninstall('all');
    } else {
      await this.reconcileOnStartup();
    }
    return this.status();
  }
}

export { installHooksIntoObject, uninstallHooksFromObject };
