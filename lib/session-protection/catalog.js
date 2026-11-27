/**
 * Which programs session protection reopens after tmux restarts.
 *
 * The user picks groups ("editors"), not process names: a group says in plain
 * words what reopening means for its programs. Programs outside every group
 * are offered one by one, and only once they have actually been seen in a
 * pane, because rerunning an arbitrary command (a deploy, a migration) must be
 * a deliberate choice.
 */

const SHELLS = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu', 'elvish', 'xonsh', 'pwsh'];

export const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

const CANONICAL_AGENTS = Object.freeze({
  agy: 'antigravity',
  antigravity: 'antigravity',
  'antigravity-cli': 'antigravity',
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  codex: 'codex',
  'codex-cli': 'codex',
  'openai-codex': 'codex',
  dsh: 'dsh',
  'dsh-tui': 'dsh',
  deepseek: 'dsh',
  'deepseek-harness': 'dsh',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
});

const AGENT_FALLBACK_RESUME = Object.freeze({
  antigravity: 'agy --continue',
  claude: 'claude --continue',
  codex: 'codex resume --last',
  dsh: 'dsh tui',
  gemini: null,
});

export function isSafeAgentSessionId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return Boolean(trimmed) && SAFE_SESSION_ID_RE.test(trimmed) && !trimmed.includes('..');
}

export function canonicalAgentType(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return CANONICAL_AGENTS[normalized] || null;
}

export const PROGRAM_GROUPS = Object.freeze([
  {
    id: 'ai',
    label: 'AI 编程助手',
    detail: 'agy、claude、codex、dsh、gemini：重新打开并精确恢复原会话（无会话 ID 时在单窗格目录续接最近对话）',
    members: ['agy', 'antigravity', 'claude', 'codex', 'dsh', 'dsh-tui', 'gemini'],
    // A plain rerun would start a fresh conversation; these resume instead.
    resume: {
      agy: 'agy --continue',
      antigravity: 'agy --continue',
      claude: 'claude --continue',
      codex: 'codex resume --last',
      dsh: 'dsh tui',
      'dsh-tui': 'dsh tui',
      gemini: 'gemini',
    },
    defaultOn: true,
  },
  {
    id: 'editors',
    label: '编辑器',
    detail: 'vim、nvim、emacs、nano 等：重新打开上次打开的文件',
    members: ['vim', 'nvim', 'vi', 'view', 'emacs', 'nano', 'micro', 'hx', 'helix'],
    defaultOn: true,
  },
  {
    id: 'viewers',
    label: '查看器',
    detail: 'less、man、tail 等：重新打开上次查看的内容',
    members: ['less', 'more', 'man', 'tail', 'bat'],
    defaultOn: true,
  },
  {
    id: 'monitors',
    label: '系统监控',
    detail: 'top、htop、btop',
    members: ['top', 'htop', 'btop', 'glances'],
    defaultOn: true,
  },
  {
    id: 'shells',
    label: '在窗格里另开的 shell',
    detail: '例如在 bash 窗格里又打开的 fish、zsh',
    members: SHELLS,
    defaultOn: true,
  },
]);

export const DEFAULT_PROGRAMS = Object.freeze(PROGRAM_GROUPS.filter((group) => group.defaultOn).map((group) => group.id));

const OTHER_PREFIX = 'cmd:';
const NAME_RE = /^[\w.+-]{1,64}$/;

/** `C:\x\claude.exe --y` / `/usr/bin/vim a` / `-bash` → `claude` / `vim` / `bash`. */
export function programName(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  // printf %q escapes spaces and backslashes; undo it for the first word only.
  const match = text.match(/^((?:\\.|[^\s\\])+)/);
  const first = (match ? match[1] : text).replace(/\\(.)/g, '$1');
  const base = first.split(/[\\/]/).pop().replace(/^-/, '').replace(/\.exe$/i, '');
  return base ? base.toLowerCase() : null;
}

function groupOf(name) {
  return PROGRAM_GROUPS.find((group) => group.members.includes(name)) || null;
}

/** The choice id a program falls under: a group id, or `cmd:<name>`. */
export function choiceFor(name) {
  if (!name) return null;
  const group = groupOf(name);
  return group ? group.id : OTHER_PREFIX + name;
}

export function isValidChoice(id) {
  if (typeof id !== 'string') return false;
  if (PROGRAM_GROUPS.some((group) => group.id === id)) return true;
  return id.startsWith(OTHER_PREFIX) && NAME_RE.test(id.slice(OTHER_PREFIX.length));
}

export function exactAgentResumeCommand(agent, { allowFallback = true } = {}) {
  const type = canonicalAgentType(agent?.type);
  if (!type) return null;
  const sid = typeof agent?.sessionId === 'string' ? agent.sessionId.trim() : '';
  if (sid && isSafeAgentSessionId(sid)) {
    switch (type) {
      case 'antigravity': return `agy --conversation ${sid}`;
      case 'codex': return `codex resume ${sid}`;
      case 'claude': return `claude --resume ${sid}`;
      case 'dsh': return `dsh tui --resume ${sid}`;
      case 'gemini': return `gemini --resume ${sid}`;
    }
  }
  if (!allowFallback) return null;
  return AGENT_FALLBACK_RESUME[type] ?? null;
}

export function paneProgramName(pane, defaultShell = null) {
  const fullName = programName(pane?.fullCommand);
  const cmdName = programName(pane?.command);
  if ((!fullName || fullName === defaultShell) && cmdName && cmdName !== defaultShell) {
    return { name: cmdName, fromCommand: true };
  }
  return { name: fullName || cmdName || null, fromCommand: !fullName && Boolean(cmdName) };
}

export function paneAgentInfo(pane, defaultShell = null) {
  const explicitType = canonicalAgentType(pane?.agent?.type);
  if (explicitType) {
    return {
      type: explicitType,
      sessionId: isSafeAgentSessionId(pane.agent?.sessionId) ? pane.agent.sessionId.trim() : '',
    };
  }
  const { name } = paneProgramName(pane, defaultShell);
  const inferred = canonicalAgentType(name);
  return inferred ? { type: inferred, sessionId: '' } : null;
}

export function ambiguousAgentCwdKeys(sessionsOrSession, defaultShell = null) {
  const sessions = Array.isArray(sessionsOrSession)
    ? sessionsOrSession
    : (sessionsOrSession ? [sessionsOrSession] : []);
  const counts = new Map();
  for (const session of sessions) {
    for (const win of session?.windows || []) {
      for (const pane of win?.panes || []) {
        const info = paneAgentInfo(pane, defaultShell);
        if (!info || info.sessionId) continue;
        const key = `${info.type}\0${pane.path || ''}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  const ambiguous = new Set();
  for (const [key, count] of counts.entries()) {
    if (count > 1) ambiguous.add(key);
  }
  return ambiguous;
}

/**
 * What to type into a restored pane, or null to leave it at its shell.
 * @param {{ command: string, fullCommand: string, agent?: { type?: string, sessionId?: string } }} pane as saved
 * @param {string[]} selected choice ids
 * @param {string|null} defaultShell the shell tmux starts panes with
 */
export function restoreCommand(pane, selected, defaultShell, { allowAgentFallback = true } = {}) {
  const explicitType = canonicalAgentType(pane?.agent?.type);
  if (explicitType) {
    if (!selected.includes('ai')) return null;
    return exactAgentResumeCommand({ type: explicitType, sessionId: pane.agent?.sessionId }, { allowFallback: allowAgentFallback });
  }
  const full = String(pane.fullCommand || '').trim();
  const { name, fromCommand } = paneProgramName(pane, defaultShell);
  if (!name || name === defaultShell) return null;
  const choice = choiceFor(name);
  if (!selected.includes(choice)) return null;
  if (choice === 'ai') {
    return exactAgentResumeCommand({ type: name, sessionId: '' }, { allowFallback: allowAgentFallback });
  }
  return fromCommand ? name : (full || name);
}

/**
 * The choices to show: every group, plus programs seen in panes that no group
 * covers. `seen` maps a program name to an example full command.
 */
export function choiceList(selected, seen = new Map(), defaultShell = null) {
  const choices = PROGRAM_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    detail: group.detail,
    selected: selected.includes(group.id),
  }));
  const others = [...seen.entries()]
    .filter(([name]) => name && name !== defaultShell && !groupOf(name) && NAME_RE.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [name, example] of others) {
    choices.push({
      id: OTHER_PREFIX + name,
      label: name,
      detail: example ? '重新运行上次的命令：' + example.slice(0, 80) : '重新运行上次的命令',
      selected: selected.includes(OTHER_PREFIX + name),
    });
  }
  // A chosen program that is no longer around stays visible so it can be unchecked.
  for (const id of selected) {
    if (id.startsWith(OTHER_PREFIX) && !choices.some((choice) => choice.id === id)) {
      choices.push({ id, label: id.slice(OTHER_PREFIX.length), detail: '重新运行上次的命令', selected: true });
    }
  }
  return choices;
}

/**
 * The same choices as tmux-resurrect options, so its own prefix + Ctrl-r
 * reopens what the panel would. Returned as option values.
 */
export function resurrectProcessOptions(selected) {
  const entries = [];
  for (const id of selected) {
    const group = PROGRAM_GROUPS.find((candidate) => candidate.id === id);
    if (group) {
      for (const member of group.members) {
        const resume = group.resume && group.resume[member];
        entries.push(resume ? `"~${member}->${resume}"` : member);
      }
    } else if (id.startsWith(OTHER_PREFIX)) {
      entries.push(id.slice(OTHER_PREFIX.length));
    }
  }
  return {
    // Replace resurrect's built-in list so unchecking a group really removes
    // it. Not '': resurrect reads an empty option as unset and falls back.
    defaultProcesses: '_anymux_none_',
    processes: entries.length ? entries.join(' ') : 'false',
  };
}
