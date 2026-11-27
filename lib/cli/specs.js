/**
 * Declarative CLI command specifications, machine-readable `agent-context` schema,
 * help rendering, and command suggestions.
 */

import { readFileSync } from 'node:fs';
import { repoPath } from '../paths.js';

export const CLI_SCHEMA_VERSION = 1;

export const CLI_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(repoPath('package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const GLOBAL_FLAGS = Object.freeze([
  { name: 'json', short: null, takesValue: false, description: 'Emit machine-readable JSON envelope ({ ok, data } / { ok: false, error }).' },
  { name: 'server', short: 'S', takesValue: true, valueName: '<id>', description: 'Target registered server ID via Hub /n/:serverId (overrides ANYMUX_SERVER; default: local).' },
  { name: 'help', short: 'h', takesValue: false, description: 'Show root help, group help, or command-specific help.' },
  { name: 'version', short: 'v', takesValue: false, description: 'Print the AnyMux CLI version.' },
]);

const GLOBAL_FLAG_NAMES = ['json', 'server', 'help'];

function spec(entry) {
  return Object.freeze({
    aliases: [],
    positionalArgs: [],
    examples: [],
    notes: [],
    ...entry,
    flags: [...new Set([...(entry.flags || []), ...GLOBAL_FLAG_NAMES])],
  });
}

export const COMMAND_SPECS = Object.freeze([
  // Discovery & Runtime
  spec({
    command: 'status',
    path: ['status'],
    group: 'Discovery & Runtime',
    remoteScope: 'node',
    summary: 'Show panel reachability, version, tmux runtime, plugins, and agent status.',
    usage: 'anymux status [--server <id>] [--json]',
    examples: ['anymux status --json', 'anymux status --server prod --json'],
    notes: ['Probes GET /api/node/info and best-effort GET /api/agent-status on the target machine.'],
  }),
  spec({
    command: 'agent-context',
    path: ['agent-context'],
    group: 'Discovery & Runtime',
    remoteScope: 'local-only',
    summary: 'Print the machine-readable command schema for agents.',
    usage: 'anymux agent-context [--json]',
    examples: ['anymux agent-context', 'anymux agent-context --json'],
    notes: ['Runs locally without requiring the panel service to be online.'],
  }),
  spec({
    command: 'server list',
    path: ['server', 'list'],
    aliases: [['servers', 'list'], ['servers']],
    group: 'Discovery & Runtime',
    remoteScope: 'hub',
    summary: 'List servers registered on the local Hub and their connection state.',
    usage: 'anymux server list [--json]',
    examples: ['anymux server list', 'anymux server list --json'],
    notes: ['Talks to the Hub /api/servers endpoint; never sends a node pairing token.'],
  }),

  // Skills
  spec({
    command: 'skills list',
    path: ['skills', 'list'],
    group: 'Skills',
    remoteScope: 'local-only',
    summary: 'List bundled version-matched AnyMux skills.',
    usage: 'anymux skills list [--json]',
    examples: ['anymux skills list', 'anymux skills list --json'],
  }),
  spec({
    command: 'skills get',
    path: ['skills', 'get'],
    group: 'Skills',
    remoteScope: 'node',
    summary: 'Print a version-matched skill guide or one of its conditional references.',
    usage: 'anymux skills get <name> [--reference <ref> | --references | --full] [--server <id>] [--json]',
    flags: ['reference', 'references', 'full'],
    positionalArgs: ['name'],
    examples: [
      'anymux skills get anymux-cli',
      'anymux skills get anymux-cli --references',
      'anymux skills get anymux-cli --reference references/worktrees.md',
      'anymux skills get anymux-cli --full --json',
    ],
    notes: [
      'Filters capability-gated blocks against plugins active on the target server (GET /api/node/info).',
      'When the panel is offline, keeps capability blocks and emits a host_capabilities_unverified warning.',
    ],
  }),
  spec({
    command: 'skills install',
    path: ['skills', 'install'],
    group: 'Skills',
    remoteScope: 'local-only',
    summary: 'Install bundled AnyMux skills as conflict-safe symlinks for local agents.',
    usage: 'anymux skills install [<name>...] [--agent universal|codex|claude|qoder|dsh|gemini|all] [--json]',
    flags: ['agent'],
    positionalArgs: ['name'],
    examples: [
      'anymux skills install',
      'anymux skills install anymux-cli --agent codex,claude --json',
      'anymux skills install --agent all',
    ],
    notes: ['Never overwrites non-managed directories or external symlinks; conflicts are reported explicitly.'],
  }),
  spec({
    command: 'skills update',
    path: ['skills', 'update'],
    group: 'Skills',
    remoteScope: 'local-only',
    summary: 'Update or repair managed skill symlinks to match this AnyMux checkout.',
    usage: 'anymux skills update [<name>...] [--agent universal|codex|claude|qoder|dsh|gemini|all] [--json]',
    flags: ['agent'],
    positionalArgs: ['name'],
    examples: ['anymux skills update --json', 'anymux skills update anymux-cli --agent all'],
  }),

  // Docs & Preview
  spec({
    command: 'open',
    path: ['open'],
    group: 'Docs & Preview',
    remoteScope: 'node',
    summary: 'Preview a file in the panel modal/side dock or open a URL in the browser block.',
    usage: 'anymux open [--dock | --background] [--pane %N] [--replaces <old>] [--kind <k>] [--owner <o>] [--server <id>] [--json] <file[#heading] | url>',
    flags: ['dock', 'background', 'pane', 'replaces', 'kind', 'owner'],
    positionalArgs: ['target'],
    examples: [
      'anymux open --dock ./plan.md',
      'anymux open --dock ./plan.md#Next --pane %31',
      'anymux open https://localhost:3000',
    ],
  }),
  spec({
    command: 'doc path',
    path: ['doc', 'path'],
    group: 'Docs & Preview',
    remoteScope: 'node',
    summary: 'Allocate and print the draft path for an agent document.',
    usage: 'anymux doc path <name> [--html] [--server <id>] [--json]',
    flags: ['html'],
    positionalArgs: ['name'],
    examples: ['anymux doc path architecture-review', 'anymux doc path report --html --json'],
  }),
  spec({
    command: 'git show',
    path: ['git', 'show'],
    group: 'Docs & Preview',
    remoteScope: 'node',
    summary: 'Open or register a commit preview in the panel Git block.',
    usage: 'anymux git show [commit] [--background] [--repo <dir>] [--pane %N] [--server <id>] [--json]',
    flags: ['background', 'repo', 'pane'],
    positionalArgs: ['commit'],
    examples: ['anymux git show HEAD --background --repo .', 'anymux git show 3498cd2 --pane %31'],
  }),

  // Workspace & Panes
  spec({
    command: 'workspace list',
    path: ['workspace', 'list'],
    aliases: [['workspace']],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'List tmux sessions, windows, and panes managed on the target server.',
    usage: 'anymux workspace list [--server <id>] [--json]',
    examples: ['anymux workspace list --json', 'anymux workspace list --server prod --json'],
  }),
  spec({
    command: 'workspace new',
    path: ['workspace', 'new'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Create a new tmux window (or initial session if none exists).',
    usage: 'anymux workspace new [--name <name>] [--cwd <dir>] [--session <id>] [--server <id>] [--json]',
    flags: ['name', 'cwd', 'session'],
    examples: ['anymux workspace new --name worker --cwd /repo --json'],
  }),
  spec({
    command: 'pane new',
    path: ['pane', 'new'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Split a window to create a new terminal pane.',
    usage: 'anymux pane new [--window @id] [--pane %N] [--dir h|v] [--server <id>] [--json]',
    flags: ['window', 'pane', 'dir'],
    examples: ['anymux pane new --window @5 --dir v --json'],
  }),
  spec({
    command: 'pane open',
    path: ['pane', 'open'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Split and open a rich pane tile (browser, diff, doc, etc.).',
    usage: 'anymux pane open <kind> [--payload <json> | --url <url> | --path <path>] [--label <label>] [--dir h|v] [--window @id] [--pane %N] [--server <id>] [--json]',
    flags: ['payload', 'url', 'path', 'label', 'dir', 'window', 'pane'],
    positionalArgs: ['kind'],
    examples: ['anymux pane open browser --url http://127.0.0.1:3000 --dir v --json'],
  }),
  spec({
    command: 'pane set-kind',
    path: ['pane', 'set-kind'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Convert an existing pane between terminal and rich-pane kinds.',
    usage: 'anymux pane set-kind <kind> [--payload <json> | --url <url> | --path <path>] [--pane %N] [--server <id>] [--json]',
    flags: ['payload', 'url', 'path', 'pane'],
    positionalArgs: ['kind'],
    examples: ['anymux pane set-kind terminal --pane %9 --json'],
  }),
  spec({
    command: 'pane zoom',
    path: ['pane', 'zoom'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Toggle zoom for a pane.',
    usage: 'anymux pane zoom [--pane %N] [--server <id>] [--json]',
    flags: ['pane'],
  }),
  spec({
    command: 'pane break',
    path: ['pane', 'break'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Break a pane out into its own tmux window.',
    usage: 'anymux pane break [--pane %N] [--server <id>] [--json]',
    flags: ['pane'],
  }),
  spec({
    command: 'pane clear',
    path: ['pane', 'clear'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Clear scrollback/screen of a pane.',
    usage: 'anymux pane clear [--pane %N] [--server <id>] [--json]',
    flags: ['pane'],
  }),
  spec({
    command: 'pane rename',
    path: ['pane', 'rename'],
    group: 'Workspace & Panes',
    remoteScope: 'node',
    summary: 'Set a custom label on a pane.',
    usage: 'anymux pane rename <label> [--pane %N] [--server <id>] [--json]',
    flags: ['pane', 'label'],
    positionalArgs: ['label'],
  }),

  // Worktrees
  spec({
    command: 'worktree list',
    path: ['worktree', 'list'],
    aliases: [['worktree']],
    group: 'Worktrees',
    remoteScope: 'node',
    summary: 'List Git worktrees and active AnyMux panes for a repository.',
    usage: 'anymux worktree list [--repo <dir>] [--server <id>] [--json]',
    flags: ['repo'],
  }),
  spec({
    command: 'worktree new',
    path: ['worktree', 'new'],
    group: 'Worktrees',
    remoteScope: 'node',
    summary: 'Create a Git worktree with sharedDirectories linking and optional tmux window.',
    usage: 'anymux worktree new <branch> [--repo <dir>] [--base <ref>] [--open] [--server <id>] [--json]',
    flags: ['repo', 'base', 'open'],
    positionalArgs: ['branch'],
  }),
  spec({
    command: 'worktree remove',
    path: ['worktree', 'remove'],
    group: 'Worktrees',
    remoteScope: 'node',
    summary: 'Remove a Git worktree with dirty/active-pane safety checks.',
    usage: 'anymux worktree remove <path> [--repo <dir>] [--force] [--server <id>] [--json]',
    flags: ['repo', 'force'],
    positionalArgs: ['path'],
  }),

  // Sessions & Automations
  spec({
    command: 'sessions',
    path: ['sessions'],
    group: 'Sessions & Automations',
    remoteScope: 'node',
    summary: 'Search archived local agent transcripts (Claude, Codex, Gemini).',
    usage: 'anymux sessions [--provider claude|codex|gemini] [--q <query>] [--limit <n>] [--server <id>] [--json]',
    flags: ['provider', 'q', 'limit'],
  }),
  spec({
    command: 'automation list',
    path: ['automation', 'list'],
    aliases: [['automation']],
    group: 'Sessions & Automations',
    remoteScope: 'node',
    summary: 'List scheduled AnyMux automations.',
    usage: 'anymux automation list [--server <id>] [--json]',
  }),
  spec({
    command: 'automation run',
    path: ['automation', 'run'],
    group: 'Sessions & Automations',
    remoteScope: 'node',
    summary: 'Trigger a scheduled automation immediately.',
    usage: 'anymux automation run <id> [--server <id>] [--json]',
    positionalArgs: ['id'],
  }),

  // Browser
  spec({
    command: 'browser status',
    path: ['browser', 'status'],
    aliases: [['browser']],
    group: 'Browser',
    remoteScope: 'node',
    summary: 'Check whether agent-browser is available on the target server.',
    usage: 'anymux browser status [--server <id>] [--json]',
  }),
  spec({
    command: 'browser open',
    path: ['browser', 'open'],
    group: 'Browser',
    remoteScope: 'node',
    summary: 'Open a URL in agent-browser (or fall back to panel URL preview).',
    usage: 'anymux browser open <url> [--server <id>] [--json]',
    positionalArgs: ['url'],
  }),
  spec({
    command: 'browser snapshot',
    path: ['browser', 'snapshot'],
    group: 'Browser',
    remoteScope: 'node',
    summary: 'Capture an accessibility snapshot via agent-browser.',
    usage: 'anymux browser snapshot [--server <id>] [--json]',
  }),
  spec({
    command: 'browser screenshot',
    path: ['browser', 'screenshot'],
    group: 'Browser',
    remoteScope: 'node',
    summary: 'Take a screenshot via agent-browser.',
    usage: 'anymux browser screenshot [--server <id>] [--json]',
  }),
  spec({
    command: 'browser get-url',
    path: ['browser', 'get-url'],
    group: 'Browser',
    remoteScope: 'node',
    summary: 'Read the active page URL from agent-browser.',
    usage: 'anymux browser get-url [--server <id>] [--json]',
  }),
  spec({
    command: 'browser close',
    path: ['browser', 'close'],
    group: 'Browser',
    remoteScope: 'node',
    summary: 'Close the active agent-browser page/session.',
    usage: 'anymux browser close [--server <id>] [--json]',
  }),

  // Local tmux
  spec({
    command: 'split',
    path: ['split'],
    group: 'Local tmux',
    remoteScope: 'local-only',
    summary: 'Split a local tmux pane directly and print the new pane ID.',
    usage: 'anymux split [-h|-v] [-c dir] [-t pane] [cmd...]',
    flags: ['h', 'v', 'c', 't'],
    positionalArgs: ['cmd'],
  }),
  spec({
    command: 'run',
    path: ['run'],
    group: 'Local tmux',
    remoteScope: 'local-only',
    summary: 'Type a command into a local tmux pane and press Enter.',
    usage: 'anymux run [-t pane] <cmd...>',
    flags: ['t'],
    positionalArgs: ['cmd'],
  }),
  spec({
    command: 'capture',
    path: ['capture'],
    group: 'Local tmux',
    remoteScope: 'local-only',
    summary: 'Capture text and scrollback from a local tmux pane.',
    usage: 'anymux capture [-t pane] [-n lines] [--json]',
    flags: ['t', 'n'],
  }),
  spec({
    command: 'events',
    path: ['events'],
    group: 'Local tmux',
    remoteScope: 'local-only',
    summary: 'Stream local tmux control-mode workspace events as JSON lines.',
    usage: 'anymux events [--filter event,...]',
    flags: ['filter'],
  }),
]);

function samePath(a, b) {
  return a.length === b.length && a.every((part, idx) => part === b[idx]);
}

export function findCommandSpec(pathParts, specs = COMMAND_SPECS) {
  if (!Array.isArray(pathParts) || !pathParts.length) return null;
  for (const item of specs) {
    if (samePath(item.path, pathParts)) return item;
    if ((item.aliases || []).some((alias) => samePath(alias, pathParts))) return item;
  }
  return null;
}

export function isCommandGroup(prefixParts, specs = COMMAND_SPECS) {
  if (!Array.isArray(prefixParts) || !prefixParts.length) return false;
  return specs.some((item) => item.path.length > prefixParts.length
    && prefixParts.every((part, idx) => item.path[idx] === part));
}

export function buildAgentContext(specs = COMMAND_SPECS) {
  const commands = specs
    .map((item) => ({
      command: item.command,
      path: [...item.path],
      aliases: item.aliases.map((alias) => [...alias]),
      group: item.group,
      remoteScope: item.remoteScope,
      summary: item.summary,
      usage: item.usage,
      flags: [...item.flags],
      positionalArgs: [...item.positionalArgs],
      examples: [...item.examples],
      notes: [...item.notes],
    }))
    .sort((a, b) => a.command.localeCompare(b.command));

  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    cliVersion: CLI_VERSION,
    commandCount: commands.length,
    globalFlags: GLOBAL_FLAGS.map((flag) => ({ ...flag })),
    commands,
  };
}

export function formatAgentContextSummary(schema) {
  return [
    `${schema.commandCount} commands (schema v${schema.schemaVersion}, cli v${schema.cliVersion}).`,
    'Run `anymux agent-context --json` for the full machine-readable command schema.',
  ].join('\n');
}

export function formatRootHelp(specs = COMMAND_SPECS) {
  const groups = new Map();
  for (const item of specs) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  const lines = [`anymux v${CLI_VERSION}`, '', 'Usage: anymux <command> [options]', ''];
  for (const [group, items] of groups) {
    lines.push(`${group}:`);
    for (const item of items) {
      lines.push(`  ${item.command.padEnd(22)} ${item.summary}`);
    }
    lines.push('');
  }
  lines.push('Global Options:');
  for (const flag of GLOBAL_FLAGS) {
    const label = flag.short
      ? `--${flag.name}, -${flag.short}${flag.valueName ? ' ' + flag.valueName : ''}`
      : `--${flag.name}${flag.valueName ? ' ' + flag.valueName : ''}`;
    lines.push(`  ${label.padEnd(22)} ${flag.description}`);
  }
  lines.push('');
  lines.push('Run `anymux <command> --help` for details, or `anymux agent-context --json` for machine schema.');
  return lines.join('\n');
}

export function formatCommandHelp(pathParts, specs = COMMAND_SPECS) {
  const exact = findCommandSpec(pathParts, specs);
  if (exact && !isCommandGroup(pathParts, specs)) {
    const lines = [
      exact.command,
      '',
      `Summary: ${exact.summary}`,
      `Usage:   ${exact.usage}`,
      `Scope:   ${exact.remoteScope}`,
      `Flags:   ${exact.flags.map((f) => (f.length === 1 ? `-${f}` : `--${f}`)).join(', ')}`,
    ];
    if (exact.examples.length) {
      lines.push('', 'Examples:');
      for (const ex of exact.examples) lines.push(`  ${ex}`);
    }
    if (exact.notes.length) {
      lines.push('', 'Notes:');
      for (const note of exact.notes) lines.push(`  - ${note}`);
    }
    return lines.join('\n');
  }

  const groupItems = specs.filter((item) => item.path.length >= pathParts.length
    && pathParts.every((part, idx) => item.path[idx] === part));
  if (!groupItems.length) return null;

  const lines = [`anymux ${pathParts.join(' ')} <subcommand>`, '', 'Subcommands:'];
  for (const item of groupItems) {
    lines.push(`  ${item.command.padEnd(22)} ${item.summary}`);
  }
  lines.push('', 'Run `anymux <subcommand> --help` for usage and flags.');
  return lines.join('\n');
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

export function suggestCommands(input, specs = COMMAND_SPECS, limit = 3) {
  const query = String(input || '').trim().toLowerCase();
  if (!query) return [];
  const candidates = [...new Set(specs.flatMap((s) => [s.command, s.path[0]]))];
  return candidates
    .map((name) => {
      const lower = name.toLowerCase();
      const score = lower.startsWith(query) || query.startsWith(lower)
        ? 0
        : (lower.includes(query) ? 1 : editDistance(query, lower) + 2);
      return { name, score };
    })
    .filter((entry) => entry.score <= Math.max(4, Math.ceil(query.length / 2) + 2))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}
