import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const AGENT_STATES = Object.freeze([
  'permission',
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  'interrupted',
  'done',
  'idle',
]);

export const STATUS_PRIORITY = Object.freeze({
  permission: 7,
  failed: 6,
  working: 5,
  monitoring: 4,
  unconfirmed: 3,
  interrupted: 2,
  done: 1,
  idle: 0,
});

export const SHELL_COMMANDS = new Set([
  'zsh',
  'bash',
  'sh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'nu',
  'nushell',
  'pwsh',
  'powershell',
  'cmd',
  'login',
]);

const AGENT_ALIASES = new Map([
  ['claude', 'claude'],
  ['claude-code', 'claude'],
  ['claudecode', 'claude'],
  ['codex', 'codex'],
  ['codex-cli', 'codex'],
  ['openai-codex', 'codex'],
  ['qoder', 'qoder'],
  ['qodercli', 'qoder'],
  ['gemini', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['opencode', 'opencode'],
  ['open-code', 'opencode'],
  ['cursor', 'cursor'],
  ['cursor-agent', 'cursor'],
  ['aider', 'aider'],
  ['goose', 'goose'],
  ['amp', 'amp'],
  ['kiro', 'kiro'],
  ['kiro-cli', 'kiro'],
  ['droid', 'droid'],
  ['factory', 'droid'],
  ['copilot', 'copilot'],
  ['gh-copilot', 'copilot'],
  ['cline', 'cline'],
  ['roo', 'roo'],
  ['roocode', 'roo'],
  ['windsurf', 'windsurf'],
  ['devin', 'devin'],
]);

const COMMAND_LINE_PATTERNS = [
  { agent: 'claude', re: /(?:^|[\/\s"'=])(?:claude-code|@anthropic-ai\/claude-code|claude)(?:\s|$|["'\/@:])/i },
  { agent: 'codex', re: /(?:^|[\/\s"'=])(?:@openai\/codex|openai-codex|codex-cli|codex)(?:\s|$|["'\/@:])/i },
  { agent: 'qoder', re: /(?:^|[\/\s"'=])(?:qodercli|qoder)(?:\s|$|["'\/@:])/i },
  { agent: 'gemini', re: /(?:^|[\/\s"'=])(?:@google\/gemini-cli|gemini-cli|gemini)(?:\s|$|["'\/@:])/i },
  { agent: 'opencode', re: /(?:^|[\/\s"'=])(?:opencode|sst\/opencode)(?:\s|$|["'\/@:])/i },
  { agent: 'cursor', re: /(?:^|[\/\s"'=])cursor-agent(?:\s|$|["'\/@:])/i },
  { agent: 'aider', re: /(?:^|[\/\s"'=])aider(?:\s|$|["'\/@:])/i },
  { agent: 'goose', re: /(?:^|[\/\s"'=])goose(?:\s|$|["'\/@:])/i },
  { agent: 'amp', re: /(?:^|[\/\s"'=])(?:@sourcegraph\/amp|amp)(?:\s|$|["'\/@:])/i },
  { agent: 'kiro', re: /(?:^|[\/\s"'=])(?:kiro-cli|kiro)(?:\s|$|["'\/@:])/i },
  { agent: 'droid', re: /(?:^|[\/\s"'=])(?:droid|factory-droid)(?:\s|$|["'\/@:])/i },
  { agent: 'copilot', re: /(?:^|[\/\s"'=])(?:gh-copilot|copilot)(?:\s|$|["'\/@:])/i },
  { agent: 'cline', re: /(?:^|[\/\s"'=])cline(?:\s|$|["'\/@:])/i },
];

const TITLE_AGENT_PATTERNS = [
  { agent: 'claude', re: /\bclaude(?:\s+code)?\b/i },
  { agent: 'codex', re: /\bcodex\b/i },
  { agent: 'qoder', re: /\bqoder(?:cli)?\b/i },
  { agent: 'gemini', re: /\bgemini(?:\s+cli)?\b/i },
  { agent: 'opencode', re: /\bopencode\b/i },
  { agent: 'cursor', re: /\bcursor(?:\s+agent)?\b/i },
  { agent: 'aider', re: /\baider\b/i },
  { agent: 'goose', re: /\bgoose\b/i },
  { agent: 'amp', re: /\bamp\b/i },
  { agent: 'kiro', re: /\bkiro\b/i },
  { agent: 'droid', re: /\bdroid\b/i },
  { agent: 'copilot', re: /\bcopilot\b/i },
];

const TOOL_GROUPS = [
  { kind: 'editor', cmds: ['vim', 'nvim', 'vi', 'nano', 'hx', 'helix', 'emacs', 'micro'] },
  { kind: 'ssh', cmds: ['ssh', 'mosh', 'scp', 'sftp'] },
  { kind: 'python', cmds: ['python', 'python3', 'python2', 'ipython', 'uv', 'pytest', 'pip', 'pip3', 'poetry'] },
  { kind: 'node', cmds: ['node', 'bun', 'deno', 'tsx', 'ts-node', 'npm', 'pnpm', 'yarn', 'npx'] },
  { kind: 'git', cmds: ['git', 'lazygit', 'tig', 'gh', 'gitui'] },
  { kind: 'container', cmds: ['docker', 'kubectl', 'k9s', 'podman', 'helm', 'compose'] },
  { kind: 'monitor', cmds: ['htop', 'btop', 'top', 'btm', 'glances', 'nvitop'] },
  { kind: 'rust', cmds: ['cargo', 'rustc', 'rustup'] },
  { kind: 'go', cmds: ['go', 'dlv'] },
  { kind: 'build', cmds: ['make', 'cmake', 'just', 'ninja', 'bazel'] },
  { kind: 'network', cmds: ['curl', 'wget', 'http', 'xh', 'nc', 'socat'] },
  { kind: 'db', cmds: ['psql', 'mysql', 'sqlite3', 'redis-cli', 'mongosh'] },
];

const TOOL_KIND_MAP = new Map();
for (const group of TOOL_GROUPS) {
  for (const cmd of group.cmds) {
    TOOL_KIND_MAP.set(cmd, group.kind);
  }
}

const SPINNER_CHAR_RE = /[\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◴◵◶◷⣾⣽⣻⢿⡿⣟⣯⣷✳✶✻✽✦✧✺✹✸✷✵✴]/;
const ATTENTION_CHAR_RE = /[⏸⚠❓✋🔔🔐]/;
const DONE_CHAR_RE = /[✓✔✅]/;
const FAILED_CHAR_RE = /[✗✘❌⨯]/;
const INTERRUPTED_CHAR_RE = /[⏹⊘]/;

const LEADING_DECORATION_RE = /^[\s\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◴◵◶◷⣾⣽⣻⢿⡿⣟⣯⣷✳✶✻✽✦✧✺✹✸✷✵✴⏸⚠❓✋🔔🔐✓✔✅✗✘❌⨯⏹⊘·•›>\-|:]+/;
const TITLE_PERMISSION_RE = /\b(?:permission|approval\s+required|requires\s+approval|needs\s+confirmation|waiting\s+for\s+(?:input|user|approval)|confirm(?:ation)?)\b/i;
const TITLE_FAILED_RE = /^(?:error|failed)\s*[:\-]|(?:\bfailed\b|\berror\b).*$/i;
const TITLE_INTERRUPTED_RE = /\b(?:interrupted|cancelled|canceled|aborted)\b/i;
const TITLE_DONE_RE = /\b(?:done|completed|finished|ready)\b/i;

const ACTIVE_AGENT_STATES = new Set(['working', 'permission', 'monitoring', 'unconfirmed']);
const UNREAD_AGENT_STATES = new Set(['done', 'permission', 'failed', 'interrupted']);
const HOOK_GRACE_MS = 5_000;
const PROCESS_CACHE_DEFAULT_TTL_MS = 1_500;

let processTableCache = {
  at: 0,
  map: new Map(),
};

export function rankAgentStatus(status) {
  if (!status || typeof status !== 'string') return 0;
  return STATUS_PRIORITY[status] ?? 0;
}

export function commandBasename(cmd) {
  if (!cmd) return '';
  const raw = String(cmd).trim();
  if (!raw) return '';
  const token = raw.split(/\s+/)[0];
  const base = token.split(/[\\/]+/).filter(Boolean).pop() || '';
  return base.replace(/^-+/, '').replace(/\.exe$/i, '').toLowerCase();
}

export function isShellCommand(cmd) {
  const base = commandBasename(cmd);
  if (!base) return true;
  return SHELL_COMMANDS.has(base);
}

export function normalizeAgentType(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = name.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return AGENT_ALIASES.get(clean) || '';
}

export function matchAgentFromCommand(cmd) {
  const base = commandBasename(cmd);
  if (!base) return '';
  return normalizeAgentType(base);
}

export function matchAgentFromCommandLine(cmdLine) {
  if (!cmdLine || typeof cmdLine !== 'string') return '';
  const direct = matchAgentFromCommand(cmdLine);
  if (direct) return direct;
  for (const { agent, re } of COMMAND_LINE_PATTERNS) {
    if (re.test(cmdLine)) return agent;
  }
  return '';
}

export function resolveAppKind(command, agentType = '') {
  const normalizedAgent = normalizeAgentType(agentType);
  if (normalizedAgent) return normalizedAgent;
  const matchedAgent = matchAgentFromCommand(command);
  if (matchedAgent) return matchedAgent;
  const base = commandBasename(command);
  if (!base || SHELL_COMMANDS.has(base)) return 'shell';
  return TOOL_KIND_MAP.get(base) || base;
}

export function parseProcessTable(stdout) {
  const map = new Map();
  if (!stdout || typeof stdout !== 'string') return map;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const stat = match[3];
    const command = match[4].trim();
    if (!Number.isFinite(pid) || pid <= 0) continue;
    map.set(pid, {
      pid,
      ppid: Number.isFinite(ppid) ? ppid : 0,
      stat,
      foreground: stat.includes('+'),
      command,
      basename: commandBasename(command),
    });
  }
  return map;
}

export function _resetProcessCache() {
  processTableCache = { at: 0, map: new Map() };
}

export async function scanProcessTable({ ttlMs = PROCESS_CACHE_DEFAULT_TTL_MS, force = false, runner } = {}) {
  if (process.platform === 'win32' && !runner) {
    return new Map();
  }
  const now = Date.now();
  if (!force && ttlMs > 0 && now - processTableCache.at < ttlMs) {
    return processTableCache.map;
  }
  try {
    const stdout = runner
      ? await runner()
      : (await execFileAsync('ps', ['-ww', '-eo', 'pid=,ppid=,stat=,command='], {
          timeout: 2000,
          maxBuffer: 4 * 1024 * 1024,
        })).stdout;
    const map = parseProcessTable(stdout);
    processTableCache = { at: now, map };
    return map;
  } catch {
    return processTableCache.map;
  }
}

export function resolvePaneAgentFromProcesses(panePid, processMap) {
  const rootPid = Number(panePid);
  if (!Number.isFinite(rootPid) || rootPid <= 0 || !(processMap instanceof Map) || processMap.size === 0) {
    return null;
  }

  const rootProc = processMap.get(rootPid);
  if (rootProc) {
    const rootAgent = matchAgentFromCommand(rootProc.basename) || matchAgentFromCommandLine(rootProc.command);
    if (rootAgent) {
      return {
        agentType: rootAgent,
        pid: rootProc.pid,
        command: rootProc.basename,
        commandLine: rootProc.command,
        foreground: rootProc.foreground,
      };
    }
  }

  const childrenByPpid = new Map();
  for (const proc of processMap.values()) {
    if (proc.ppid <= 0 || proc.pid === proc.ppid) continue;
    let list = childrenByPpid.get(proc.ppid);
    if (!list) {
      list = [];
      childrenByPpid.set(proc.ppid, list);
    }
    list.push(proc);
  }

  const visited = new Set([rootPid]);
  const queue = (childrenByPpid.get(rootPid) || []).map((proc) => ({ proc, depth: 1 }));
  let best = null;

  while (queue.length > 0) {
    const { proc, depth } = queue.shift();
    if (visited.has(proc.pid)) continue;
    visited.add(proc.pid);

    const directAgent = matchAgentFromCommand(proc.basename);
    const cliAgent = directAgent || matchAgentFromCommandLine(proc.command);
    if (cliAgent) {
      const score = (proc.foreground ? 100 : 0) + (directAgent ? 20 : 10) - depth;
      if (!best || score > best.score) {
        best = {
          score,
          agentType: cliAgent,
          pid: proc.pid,
          command: proc.basename,
          commandLine: proc.command,
          foreground: proc.foreground,
        };
      }
    }

    const children = childrenByPpid.get(proc.pid);
    if (children) {
      for (const child of children) {
        if (!visited.has(child.pid)) {
          queue.push({ proc: child, depth: depth + 1 });
        }
      }
    }
  }

  if (!best) return null;
  const { score: _score, ...result } = best;
  return result;
}

export function stripTitleDecorations(title) {
  if (!title || typeof title !== 'string') return '';
  return title.replace(LEADING_DECORATION_RE, '').trim();
}

export function parseOsc9999Payload(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let body = raw.trim();
  const prefixMatch = body.match(/^(?:9999|133);(.+)$/);
  if (prefixMatch) {
    body = prefixMatch[1].trim();
  }
  if (!body) return null;

  let obj = null;
  if (body.startsWith('{') && body.endsWith('}')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') obj = parsed;
    } catch {
      return null;
    }
  } else if (body.includes('=')) {
    obj = {};
    for (const part of body.split(/[;&]/)) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim().toLowerCase();
      const v = part.slice(idx + 1).trim();
      if (k) obj[k] = v;
    }
  }

  if (!obj) return null;
  const rawState = String(obj.state || obj.status || '').trim().toLowerCase();
  const stateMap = {
    working: 'working',
    running: 'working',
    busy: 'working',
    thinking: 'working',
    permission: 'permission',
    waiting: 'permission',
    attention: 'permission',
    failed: 'failed',
    error: 'failed',
    interrupted: 'interrupted',
    cancelled: 'interrupted',
    aborted: 'interrupted',
    done: 'done',
    completed: 'done',
    stopped: 'done',
    idle: 'idle',
    monitoring: 'monitoring',
  };
  const status = stateMap[rawState] || null;
  const agentType = normalizeAgentType(obj.agent || obj.agentType || obj.source || '');
  if (!status && !agentType) return null;

  return {
    status,
    agentType,
    model: obj.model ? String(obj.model) : '',
    prompt: obj.prompt ? String(obj.prompt) : '',
    label: obj.title || obj.label ? String(obj.title || obj.label) : '',
    subagentCount: Number.isFinite(Number(obj.subagents || obj.subagentCount))
      ? Number(obj.subagents || obj.subagentCount)
      : 0,
  };
}

export function detectAgentFromTitle(title, hintCommand = '') {
  if (!title || typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed) return null;

  const osc = parseOsc9999Payload(trimmed);
  if (osc) {
    return {
      status: osc.status,
      agentType: osc.agentType || normalizeAgentType(hintCommand),
      label: osc.label || stripTitleDecorations(trimmed),
      model: osc.model,
      prompt: osc.prompt,
      subagentCount: osc.subagentCount,
      spinner: osc.status === 'working',
      source: 'osc',
    };
  }

  let agentType = normalizeAgentType(hintCommand) || matchAgentFromCommand(hintCommand);
  if (!agentType) {
    for (const { agent, re } of TITLE_AGENT_PATTERNS) {
      if (re.test(trimmed)) {
        agentType = agent;
        break;
      }
    }
  }

  let status = null;
  let spinner = false;
  if (ATTENTION_CHAR_RE.test(trimmed) || (agentType && TITLE_PERMISSION_RE.test(trimmed))) {
    status = 'permission';
  } else if (FAILED_CHAR_RE.test(trimmed) || (agentType && TITLE_FAILED_RE.test(stripTitleDecorations(trimmed)))) {
    status = 'failed';
  } else if (SPINNER_CHAR_RE.test(trimmed)) {
    status = 'working';
    spinner = true;
  } else if (INTERRUPTED_CHAR_RE.test(trimmed) || (agentType && TITLE_INTERRUPTED_RE.test(trimmed))) {
    status = 'interrupted';
  } else if (DONE_CHAR_RE.test(trimmed) || (agentType && TITLE_DONE_RE.test(trimmed))) {
    status = 'done';
  }

  if (!status && !agentType) return null;
  return {
    status,
    agentType: agentType || '',
    label: stripTitleDecorations(trimmed) || trimmed,
    model: '',
    prompt: '',
    subagentCount: 0,
    spinner,
    source: 'title',
  };
}

export function formatShortModel(model) {
  if (!model || typeof model !== 'string') return '';
  let clean = model.trim();
  if (!clean) return '';

  // Strip provider prefix like "anthropic/claude-..."
  const slashIdx = clean.lastIndexOf('/');
  if (slashIdx >= 0 && slashIdx < clean.length - 1) {
    clean = clean.slice(slashIdx + 1);
  }
  // Strip trailing YYYYMMDD date suffix or -latest
  clean = clean.replace(/-(?:20\d{6}|latest)$/i, '');

  // Claude family: claude-opus-4-5 -> opus-4.5, claude-3-5-sonnet -> sonnet-3.5
  const claudeNew = clean.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-(.+))?$/i);
  if (claudeNew) {
    const ver = claudeNew[3] ? `${claudeNew[2]}.${claudeNew[3]}` : claudeNew[2];
    return `${claudeNew[1].toLowerCase()}-${ver}`;
  }
  const claudeOld = clean.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/i);
  if (claudeOld) {
    const ver = claudeOld[2] ? `${claudeOld[1]}.${claudeOld[2]}` : claudeOld[1];
    return `${claudeOld[3].toLowerCase()}-${ver}`;
  }

  // GPT / Codex family: gpt-5.3-codex -> gpt-5.3, gpt-4o-mini -> gpt-4o-mini
  const gptCodex = clean.match(/^(gpt-\d+(?:\.\d+)?)(?:-codex.*)?$/i);
  if (gptCodex) return gptCodex[1].toLowerCase();

  // Gemini family: gemini-2.5-pro-preview -> gemini-2.5
  const gemini = clean.match(/^(gemini-\d+(?:\.\d+)?)/i);
  if (gemini) return gemini[1].toLowerCase();

  if (clean.length > 18) return clean.slice(0, 18);
  return clean;
}

function mapHookStateToCanonical(hookState) {
  if (!hookState) return null;
  const raw = String(hookState.status || hookState.state || '').trim();
  const map = {
    agent_running: 'working',
    working: 'working',
    running: 'working',
    waiting_attention: 'permission',
    permission: 'permission',
    agent_stopped: hookState.interrupted ? 'interrupted' : 'done',
    done: 'done',
    failed: 'failed',
    interrupted: 'interrupted',
    session_ended: 'session_ended',
    monitoring: 'monitoring',
    unconfirmed: 'unconfirmed',
    idle: 'idle',
  };
  return map[raw] || null;
}

export function fusePaneAgentStatus({
  pane = {},
  hookState = null,
  processMatch = null,
  prevStatus = null,
  now = Date.now(),
} = {}) {
  const command = pane.command || '';
  const shell = isShellCommand(command);
  const directCmdAgent = matchAgentFromCommand(command);
  const processAgent = processMatch?.agentType || directCmdAgent || '';

  const hookCanonical = mapHookStateToCanonical(hookState);
  const hookUpdatedAt = Number(hookState?.updatedAt || hookState?.timestamp || 0);
  const hookAgent = normalizeAgentType(hookState?.agentType || hookState?.agent || '');

  const hintAgent = processAgent || hookAgent || prevStatus?.agentType || '';
  const titleMatch = detectAgentFromTitle(pane.title || '', hintAgent);

  let status = null;
  let source = 'process';
  let agentType = processAgent || titleMatch?.agentType || hookAgent || '';

  const hasLiveProcess = Boolean(processAgent);
  const hookAge = hookUpdatedAt > 0 ? Math.max(0, now - hookUpdatedAt) : Infinity;

  if (hookCanonical === 'session_ended' && !hasLiveProcess) {
    return null;
  }

  // 1. Hook event fusion (highest authority when valid for live process or terminal outcome)
  if (hookState && hookCanonical && hookCanonical !== 'session_ended') {
    if (ACTIVE_AGENT_STATES.has(hookCanonical)) {
      if (hasLiveProcess || !shell || hookAge <= HOOK_GRACE_MS) {
        status = hookCanonical;
        source = 'hook';
      } else if (prevStatus && prevStatus.status === 'working' && shell && !hasLiveProcess) {
        // Agent process exited back to shell while hook still claims working -> treat as done
        status = 'done';
        source = 'process';
      }
    } else if (hookCanonical === 'done' || hookCanonical === 'failed' || hookCanonical === 'interrupted') {
      status = hookCanonical;
      source = 'hook';
    } else if (hookCanonical === 'idle' && hasLiveProcess) {
      status = 'idle';
      source = 'hook';
    }
  }

  // 2. Title / OSC fusion (takes over when no hook, or when title detects active spinner/permission newer than done)
  if (!status && titleMatch) {
    if (titleMatch.status) {
      status = titleMatch.status;
      source = titleMatch.source || 'title';
    }
  } else if (status === 'done' && titleMatch?.status === 'working' && hasLiveProcess && hookAge > 2_000) {
    // Process/title resumed working after a prior completion hook without a new hook firing yet
    status = 'working';
    source = titleMatch.source || 'title';
  }

  // 3. Process-based fallback & transition edge detection
  if (!status && hasLiveProcess) {
    if (prevStatus && prevStatus.status === 'working' && prevStatus.agentType === processAgent) {
      // Running process lost spinner and has no working hook -> edge transition working -> done
      status = 'done';
      source = 'process';
    } else {
      status = 'idle';
      source = 'process';
    }
  }

  if (!status && !hasLiveProcess && prevStatus && prevStatus.agentType) {
    if (prevStatus.status === 'working' || prevStatus.status === 'permission' || prevStatus.status === 'monitoring') {
      status = 'done';
      agentType = prevStatus.agentType;
      source = 'process';
    } else if (prevStatus.status === 'done' || prevStatus.status === 'failed' || prevStatus.status === 'interrupted') {
      // Preserve finished/failed state until acknowledged or replaced
      status = prevStatus.status;
      agentType = prevStatus.agentType;
      source = prevStatus.source || 'process';
    }
  }

  if (!status && !agentType) {
    return null;
  }

  status = status || 'idle';
  const model = hookState?.model || titleMatch?.model || prevStatus?.model || '';
  const prompt = hookState?.prompt || titleMatch?.prompt || prevStatus?.prompt || '';
  const lastMessage = hookState?.lastMessage || prevStatus?.lastMessage || '';
  const label = (hookState?.prompt && hookState.prompt.trim())
    || (titleMatch?.label && titleMatch.label.trim())
    || (prevStatus?.label && prevStatus.label.trim())
    || pane.label
    || command
    || agentType
    || 'shell';
  const subagentCount = Number.isFinite(Number(hookState?.subagentCount))
    ? Number(hookState.subagentCount)
    : (Number.isFinite(Number(titleMatch?.subagentCount))
        ? Number(titleMatch.subagentCount)
        : Number(prevStatus?.subagentCount || 0));

  const stateChanged = !prevStatus || prevStatus.status !== status || prevStatus.agentType !== agentType;
  const startedAt = status === 'working'
    ? (prevStatus?.status === 'working' ? (prevStatus.startedAt || now) : now)
    : (prevStatus?.startedAt || null);

  const updatedAt = hookUpdatedAt && source === 'hook'
    ? hookUpdatedAt
    : (stateChanged ? now : (prevStatus?.updatedAt || now));

  const unread = UNREAD_AGENT_STATES.has(status)
    ? (stateChanged ? true : (prevStatus?.unread !== undefined ? Boolean(prevStatus.unread) : true))
    : false;

  return {
    paneId: pane.id || '',
    agentType: agentType || '',
    appKind: resolveAppKind(command, agentType),
    status,
    source,
    model,
    shortModel: formatShortModel(model),
    prompt,
    lastMessage,
    label,
    subagentCount,
    unread,
    startedAt,
    updatedAt,
    command,
  };
}

export function buildAgentStatusSnapshot({
  sessions: inputSessions = null,
  sessionId = '',
  windows = [],
  fusedPanes = new Map(),
  updatedAt = Date.now(),
} = {}) {
  const panes = {};
  const windowsOut = {};
  const sessionsOut = {};
  let hasAgents = false;

  const sessionList = Array.isArray(inputSessions)
    ? inputSessions
    : ((windows.length > 0 || sessionId) ? [{ id: sessionId, name: sessionId, windows }] : []);

  for (const sess of sessionList) {
    const sessKey = sess.id || sess.name || '';
    const sessName = sess.name || '';
    const sessWindows = Array.isArray(sess.windows) ? sess.windows : [];
    let sessionBestStatus = null;
    let sessionBestRank = -1;
    let sessionAppKind = '';
    let sessionAgentType = '';
    let sessionUnread = false;
    let sessionAgentCount = 0;
    let sessionUpdatedAt = 0;

    for (const win of sessWindows) {
      const winId = win.id || '';
      const winPanes = Array.isArray(win.panes) ? win.panes : [];
      let bestStatus = null;
      let bestRank = -1;
      let primaryAppKind = '';
      let primaryAgentType = '';
      let primaryLabel = '';
      let primaryModel = '';
      let winUnread = false;
      let agentCount = 0;
      let winUpdatedAt = 0;

      for (const pane of winPanes) {
        const fused = fusedPanes instanceof Map ? fusedPanes.get(pane.id) : fusedPanes?.[pane.id];
        if (!fused) continue;

        panes[pane.id] = fused;
        hasAgents = true;
        agentCount += 1;
        if (fused.unread) winUnread = true;
        if ((fused.updatedAt || 0) > winUpdatedAt) winUpdatedAt = fused.updatedAt || 0;

        const rank = rankAgentStatus(fused.status);
        if (rank > bestRank || (rank === bestRank && !primaryAgentType && fused.agentType)) {
          bestRank = rank;
          bestStatus = fused.status;
          primaryAppKind = fused.appKind || primaryAppKind;
          primaryAgentType = fused.agentType || primaryAgentType;
          primaryLabel = fused.label || primaryLabel;
          primaryModel = fused.shortModel || fused.model || primaryModel;
        }
      }

      if (agentCount > 0 && winId) {
        windowsOut[winId] = {
          windowId: winId,
          status: bestStatus || 'idle',
          appKind: primaryAppKind || resolveAppKind(winPanes[0]?.command || '', primaryAgentType),
          agentType: primaryAgentType,
          label: primaryLabel,
          shortModel: primaryModel,
          agentCount,
          unread: winUnread,
          updatedAt: winUpdatedAt || updatedAt,
        };

        sessionAgentCount += agentCount;
        if (winUnread) sessionUnread = true;
        if (winUpdatedAt > sessionUpdatedAt) sessionUpdatedAt = winUpdatedAt;
        if (bestRank > sessionBestRank) {
          sessionBestRank = bestRank;
          sessionBestStatus = bestStatus;
          sessionAppKind = primaryAppKind;
          sessionAgentType = primaryAgentType;
        }
      }
    }

    if (sessKey && sessionAgentCount > 0) {
      sessionsOut[sessKey] = {
        sessionId: sessKey,
        sessionName: sessName,
        status: sessionBestStatus || 'idle',
        appKind: sessionAppKind,
        agentType: sessionAgentType,
        agentCount: sessionAgentCount,
        unread: sessionUnread,
        updatedAt: sessionUpdatedAt || updatedAt,
      };
    }
  }

  return {
    hasAgents,
    updatedAt,
    panes,
    windows: windowsOut,
    sessions: sessionsOut,
  };
}
