import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir as nativeHomedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { findProjectRoot, pathSpace, withinRoots } from '../agent-docs/project.js';
import { IS_WINDOWS, toPosixPath } from '../msys.js';
import { parseWorktreeList } from '../worktrees/service.js';

const IDENTITY_TTL_MS = 30_000;
const DIR_ROOT_TTL_MS = 30_000;
const DEFAULT_MAX_PER_PANE = 24;
const DEFAULT_READ_TTL_MS = 2 * 3600_000;
const MAX_SCAN_STATS = 120;
const SCAN_BUDGET_MS = 80;
const MAX_PANE_CANDIDATES = 24;

const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS',
  'read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search',
  'view_file_outline', 'view_code_item', 'smart_search', 'smart_outline', 'smart_unfold',
]);

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content',
  'Bash', 'run_command', 'Shell', 'execute_command', 'apply_patch', 'create_file', 'delete_file',
]);

const WRITE_STATES = new Set(['agent_stopped', 'waiting_attention']);

const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'Path', 'TargetFile', 'AbsolutePath',
  'DirectoryPath', 'SearchPath', 'workdir', 'working_directory', 'cwd', 'Cwd',
  'directory', 'repo', 'repoPath', 'target', 'destination', 'source',
];

const ARRAY_PATH_KEYS = ['paths', 'files', 'TargetFiles'];

const SYSTEM_PREFIXES = [
  '/dev/', '/bin/', '/usr/', '/opt/', '/etc/', '/proc/', '/sys/', '/sbin/', '/var/run/',
];

const SKIP_SCAN_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', '.gradle', '.idea', 'Pods', 'DerivedData',
  'Library', 'Applications', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Documents',
]);

const WORKTREE_CONTAINER_DIRS = new Set(['.worktrees', '.anymux-worktrees', 'worktrees']);

const identityCache = new Map();

function homePath() {
  const h = nativeHomedir();
  return IS_WINDOWS ? toPosixPath(h) : h;
}

function normalizeDisplayPath(p) {
  return IS_WINDOWS ? toPosixPath(p) : p;
}

function expandHome(raw) {
  if (typeof raw !== 'string') return '';
  if (raw === '~') return homePath();
  if (raw.startsWith('~/')) return homePath().replace(/\/$/, '') + raw.slice(1);
  return raw;
}

function isSystemPath(p) {
  return SYSTEM_PREFIXES.some((prefix) => p.startsWith(prefix) || p === prefix.slice(0, -1));
}

function stripQuotes(token) {
  if (!token) return '';
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return token.slice(1, -1);
  }
  return token;
}

function resolveCandidatePath(raw, baseCwd) {
  if (typeof raw !== 'string') return null;
  let trimmed = stripQuotes(raw.trim());
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\n')) return null;
  if (/^[a-zA-Z]+:\/\//.test(trimmed)) return null;
  trimmed = expandHome(trimmed);
  const apiForm = pathSpace.toApi(trimmed);
  if (apiForm.startsWith('/')) return pathSpace.resolve(apiForm);
  if (baseCwd && pathSpace.toApi(baseCwd).startsWith('/')) {
    return pathSpace.resolve(pathSpace.toApi(baseCwd), apiForm);
  }
  return null;
}

function parseToolInput(raw) {
  const candidates = [raw.tool_input, raw.toolInput, raw.input, raw.arguments, raw.toolCall?.input, raw.toolCall?.arguments];
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === 'object' && !Array.isArray(item)) return item;
    if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* ignore malformed json */ }
    }
  }
  return null;
}

function extractCommandPaths(cmd, baseCwd) {
  const out = [];
  if (typeof cmd !== 'string' || !cmd.trim()) return out;

  const patterns = [
    /(?:^|[;&|\s])git\s+-C\s+("[^"]+"|'[^']+'|\S+)/g,
    /(?:^|[;&|\n])\s*cd\s+("[^"]+"|'[^']+'|\S+)/g,
    /(?:^|[;&|\s])git\s+worktree\s+add\s+(?:-[a-zA-Z]\s+\S+\s+|--\S+\s+)*("[^"]+"|'[^']+'|[^\s-]\S*)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cmd)) !== null) {
      const resolved = resolveCandidatePath(m[1], baseCwd);
      if (resolved && !isSystemPath(resolved)) out.push(resolved);
    }
  }

  const tokenRe = /("[^"]+"|'[^']+'|(?:~\/|\/)[^\s;|&"'`<>()]+)/g;
  let m;
  while ((m = tokenRe.exec(cmd)) !== null) {
    const token = stripQuotes(m[1]);
    if (!token.startsWith('/') && !token.startsWith('~/')) continue;
    const resolved = resolveCandidatePath(token, baseCwd);
    if (resolved && !isSystemPath(resolved)) out.push(resolved);
  }
  return out;
}

/** Extracts candidate paths and access kind ('read' | 'write') from an agent hook payload. */
export function extractPathsFromAgentPayload(raw = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const toolName = String(obj.tool_name || obj.toolName || obj.toolCall?.name || '').trim();
  const eventName = String(obj.event || obj.hook_event_name || obj.hookEventName || '').trim();
  const stateName = String(obj.state || '').trim();
  const input = parseToolInput(obj);
  const baseCwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? expandHome(obj.cwd.trim()) : '';

  const cmdText = String(input?.command || input?.CommandLine || input?.cmd || obj.command || '').trim();
  let kind = 'read';
  if (WRITE_TOOLS.has(toolName) || WRITE_STATES.has(stateName) || eventName === 'Stop' || eventName === 'AfterAgent' || eventName === 'agent_stop') {
    kind = 'write';
  } else if (READ_TOOLS.has(toolName)) {
    kind = 'read';
  } else if (cmdText) {
    kind = 'write';
  }

  const found = [];
  const push = (value) => {
    const resolved = resolveCandidatePath(value, baseCwd);
    if (resolved && !isSystemPath(resolved)) found.push(resolved);
  };

  if (baseCwd) push(baseCwd);
  if (input) {
    for (const key of PATH_KEYS) {
      if (typeof input[key] === 'string' && input[key].trim()) push(input[key]);
    }
    for (const key of ARRAY_PATH_KEYS) {
      if (Array.isArray(input[key])) {
        for (const item of input[key]) {
          if (typeof item === 'string' && item.trim()) push(item);
        }
      }
    }
    for (const cmdKey of ['command', 'CommandLine', 'cmd']) {
      if (typeof input[cmdKey] === 'string' && input[cmdKey].trim()) {
        for (const p of extractCommandPaths(input[cmdKey], baseCwd)) found.push(p);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const p of found) {
    const key = pathSpace.key(p);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= 8) break;
  }
  return { kind, paths: unique };
}

/** Formats an absolute path concisely relative to `cwd` or `$HOME`. */
export function formatDisplayPath(absPath, { home = homePath(), cwd = '' } = {}) {
  const target = normalizeDisplayPath(String(absPath || ''));
  if (!target) return '';
  const normCwd = cwd ? normalizeDisplayPath(String(cwd)).replace(/\/+$/, '') : '';
  if (normCwd && target.startsWith(normCwd + '/')) {
    return './' + target.slice(normCwd.length + 1);
  }
  const normHome = home ? normalizeDisplayPath(String(home)).replace(/\/+$/, '') : '';
  if (normHome && (target === normHome || target.startsWith(normHome + '/'))) {
    return '~' + target.slice(normHome.length);
  }
  return target;
}

/**
 * Inspects a Git checkout to distinguish main repository vs linked worktree.
 * Results are cached briefly by `repoRoot` because worktree structure rarely changes.
 */
export async function inspectRepoIdentity(repoRoot, { runGit, now = Date.now } = {}) {
  const key = pathSpace.key(normalizeDisplayPath(repoRoot));
  const cached = identityCache.get(key);
  if (cached && now() - cached.at < IDENTITY_TTL_MS) return cached.data;

  const out = await runGit(repoRoot, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], {
    env: { GIT_OPTIONAL_LOCKS: '0' },
  });
  const [rawTop = repoRoot, rawGitDir = '', rawCommonDir = ''] = String(out || '').trim().split('\n');
  const resolveGitPath = async (p, base) => {
    const abs = isAbsolute(p) ? p : resolve(base, p);
    return realpath(abs).catch(() => resolve(abs));
  };
  const toplevel = await realpath(rawTop).catch(() => resolve(rawTop));
  const gitDir = rawGitDir ? await resolveGitPath(rawGitDir, toplevel) : join(toplevel, '.git');
  const commonDir = rawCommonDir ? await resolveGitPath(rawCommonDir, toplevel) : gitDir;
  const isWorktree = pathSpace.key(gitDir) !== pathSpace.key(commonDir);
  const mainRoot = isWorktree
    ? (basename(commonDir) === '.git' ? dirname(commonDir) : commonDir)
    : toplevel;

  let hasWorktrees = isWorktree;
  if (!hasWorktrees) {
    try {
      const entries = await readdir(join(commonDir, 'worktrees'));
      hasWorktrees = entries.length > 0;
    } catch {
      hasWorktrees = false;
    }
  }

  const displayRoot = normalizeDisplayPath(toplevel);
  const displayMainRoot = normalizeDisplayPath(mainRoot);
  const data = {
    root: displayRoot,
    mainRoot: displayMainRoot,
    repoName: basename(displayMainRoot) || displayMainRoot,
    isWorktree,
    hasWorktrees,
    worktreeName: isWorktree ? (basename(displayRoot) || null) : null,
  };
  identityCache.set(key, { at: now(), data });
  return data;
}

export function invalidateRepoIdentityCache(repoRoot = null) {
  if (!repoRoot) {
    identityCache.clear();
    return;
  }
  identityCache.delete(pathSpace.key(normalizeDisplayPath(repoRoot)));
}

/** Tracks Git repositories touched by agent tools or explicit opens per tmux pane. */
export class PaneRepoTracker {
  constructor({ pathGuard = null, roots = [], now = Date.now, onChange = null, maxPerPane = DEFAULT_MAX_PER_PANE, readTtlMs = DEFAULT_READ_TTL_MS } = {}) {
    this.pathGuard = pathGuard;
    this.roots = roots;
    this.now = now;
    this.onChange = onChange;
    this.maxPerPane = maxPerPane;
    this.readTtlMs = readTtlMs;
    this._panes = new Map();
    this._dirRootCache = new Map();
  }

  _prunePane(map, currentNow) {
    for (const [key, entry] of map.entries()) {
      if (entry.kind === 'read' && currentNow - entry.lastTouchedAt > this.readTtlMs) {
        map.delete(key);
      }
    }
    while (map.size > this.maxPerPane) {
      let victimKey = null;
      let victimAt = Infinity;
      for (const [key, entry] of map.entries()) {
        if (entry.kind === 'read' && entry.lastTouchedAt < victimAt) {
          victimAt = entry.lastTouchedAt;
          victimKey = key;
        }
      }
      if (!victimKey) {
        for (const [key, entry] of map.entries()) {
          if (entry.lastTouchedAt < victimAt) {
            victimAt = entry.lastTouchedAt;
            victimKey = key;
          }
        }
      }
      if (!victimKey) break;
      map.delete(victimKey);
    }
  }

  async _resolveRepoRoot(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    const apiPath = pathSpace.toApi(rawPath);
    if (!apiPath.startsWith('/')) return null;
    if (this.roots.length && !withinRoots(apiPath, this.roots, pathSpace)) return null;

    let checkDir = apiPath;
    try {
      const info = await lstat(pathSpace.toFs(apiPath));
      if (!info.isDirectory()) checkDir = posix.dirname(apiPath);
    } catch {
      checkDir = posix.dirname(apiPath);
    }

    const dirKey = pathSpace.key(checkDir);
    const cached = this._dirRootCache.get(dirKey);
    const currentNow = this.now();
    if (cached && currentNow - cached.at < DIR_ROOT_TTL_MS) {
      return cached.root;
    }

    const found = await findProjectRoot(checkDir, pathSpace).catch(() => null);
    let root = found?.root || null;
    if (root && this.roots.length && !withinRoots(root, this.roots, pathSpace)) {
      root = null;
    }
    if (root) {
      root = pathSpace.toApi(await realpath(pathSpace.toFs(root)).catch(() => root));
    }
    this._dirRootCache.set(dirKey, { at: currentNow, root });
    if (this._dirRootCache.size > 512) {
      const firstKey = this._dirRootCache.keys().next().value;
      this._dirRootCache.delete(firstKey);
    }
    return root;
  }

  recordRepo(paneId, repoRoot, { kind = 'read' } = {}) {
    if (!paneId || !/^%\d+$/.test(String(paneId)) || !repoRoot) return false;
    const normRoot = normalizeDisplayPath(repoRoot);
    if (this.roots.length && !withinRoots(normRoot, this.roots, pathSpace)) return false;

    const currentNow = this.now();
    let map = this._panes.get(paneId);
    if (!map) {
      map = new Map();
      this._panes.set(paneId, map);
    }
    const key = pathSpace.key(normRoot);
    const existing = map.get(key);
    const nextKind = existing?.kind === 'write' || kind === 'write' ? 'write' : 'read';
    const isNew = !existing;
    const upgraded = Boolean(existing && existing.kind === 'read' && nextKind === 'write');

    map.set(key, {
      root: existing?.root || normRoot,
      kind: nextKind,
      lastTouchedAt: currentNow,
      touchCount: (existing?.touchCount || 0) + 1,
    });
    this._prunePane(map, currentNow);
    if (this.onChange && (isNew || upgraded || nextKind === 'write')) {
      this.onChange(paneId, normRoot, nextKind);
    }
    return true;
  }

  async recordPath(paneId, rawPath, { kind = 'read' } = {}) {
    if (!paneId || !/^%\d+$/.test(String(paneId))) return null;
    const root = await this._resolveRepoRoot(rawPath);
    if (!root) return null;
    this.recordRepo(paneId, root, { kind });
    return root;
  }

  async ingestAgentEvent(rawPayload, event = null) {
    const paneId = event?.paneId || rawPayload?.paneId || rawPayload?.pane_id;
    if (!paneId || !/^%\d+$/.test(String(paneId))) return [];
    const { kind, paths } = extractPathsFromAgentPayload({ ...(rawPayload || {}), ...(event ? { state: event.state, cwd: event.cwd || rawPayload?.cwd } : {}) });
    const recorded = [];
    for (const p of paths) {
      const root = await this.recordPath(paneId, p, { kind });
      if (root) recorded.push(root);
    }
    return recorded;
  }

  getPaneRepos(paneId) {
    const map = this._panes.get(paneId);
    if (!map) return [];
    const currentNow = this.now();
    this._prunePane(map, currentNow);
    return [...map.values()].map((entry) => ({ ...entry }));
  }

  deletePane(paneId) {
    return this._panes.delete(paneId);
  }

  clear() {
    this._panes.clear();
    this._dirRootCache.clear();
  }
}

async function dirExists(path) {
  try {
    const s = await lstat(pathSpace.toFs(path));
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function scanWorkspaceRepos(cwd, roots) {
  const results = [];
  const deadline = Date.now() + SCAN_BUDGET_MS;
  let statBudget = MAX_SCAN_STATS;
  const seen = new Set();

  const probeGit = async (dir) => {
    if (statBudget <= 0 || Date.now() > deadline) return false;
    statBudget -= 1;
    try {
      await lstat(pathSpace.toFs(join(dir, '.git')));
      const canonical = pathSpace.toApi(await realpath(pathSpace.toFs(dir)).catch(() => dir));
      if (roots.length && !withinRoots(canonical, roots, pathSpace)) return false;
      const key = pathSpace.key(canonical);
      if (!seen.has(key)) {
        seen.add(key);
        results.push(canonical);
      }
      return true;
    } catch {
      return false;
    }
  };

  let entries;
  try {
    entries = await readdir(pathSpace.toFs(cwd), { withFileTypes: true });
  } catch {
    return results;
  }

  const level1Dirs = [];
  const worktreeContainers = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (WORKTREE_CONTAINER_DIRS.has(entry.name)) {
      worktreeContainers.push(join(cwd, entry.name));
      continue;
    }
    if (entry.name.startsWith('.') || SKIP_SCAN_DIRS.has(entry.name)) continue;
    level1Dirs.push(join(cwd, entry.name));
  }

  for (const container of worktreeContainers) {
    if (statBudget <= 0 || Date.now() > deadline || results.length >= MAX_PANE_CANDIDATES) break;
    let subEntries;
    try {
      subEntries = await readdir(pathSpace.toFs(container), { withFileTypes: true });
    } catch { continue; }
    for (const sub of subEntries) {
      if (statBudget <= 0 || Date.now() > deadline || results.length >= MAX_PANE_CANDIDATES) break;
      if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
      const subDir = join(container, sub.name);
      if (await probeGit(subDir)) continue;
      let nested;
      try {
        nested = await readdir(pathSpace.toFs(subDir), { withFileTypes: true });
      } catch { continue; }
      for (const wt of nested) {
        if (statBudget <= 0 || Date.now() > deadline || results.length >= MAX_PANE_CANDIDATES) break;
        if (!wt.isDirectory() && !wt.isSymbolicLink()) continue;
        await probeGit(join(subDir, wt.name));
      }
    }
  }

  const nonGitLevel1 = [];
  for (const dir of level1Dirs) {
    if (statBudget <= 0 || Date.now() > deadline || results.length >= MAX_PANE_CANDIDATES) break;
    if (!(await probeGit(dir))) nonGitLevel1.push(dir);
  }

  if (pathSpace.key(cwd) !== pathSpace.key(homePath()) && results.length < 12) {
    for (const dir of nonGitLevel1) {
      if (statBudget <= 0 || Date.now() > deadline || results.length >= 16) break;
      let sub;
      try {
        sub = await readdir(pathSpace.toFs(dir), { withFileTypes: true });
      } catch { continue; }
      for (const child of sub) {
        if (statBudget <= 0 || Date.now() > deadline || results.length >= 16) break;
        if ((!child.isDirectory() && !child.isSymbolicLink()) || child.name.startsWith('.') || SKIP_SCAN_DIRS.has(child.name)) continue;
        await probeGit(join(dir, child.name));
      }
    }
  }

  return results;
}

const SOURCE_PRIORITY = {
  cwd: 5,
  'agent-write': 4,
  worktree: 3,
  workspace: 2,
  'agent-read': 1,
};

/** Discovers all candidate Git repositories relevant to a pane's cwd and recent agent actions. */
export async function discoverPaneRepos({ paneId, cwd, roots = [], tracker = null, runGit }) {
  const candidates = new Map();
  const add = (root, source, extra = {}) => {
    if (!root) return;
    const norm = normalizeDisplayPath(root);
    if (roots.length && !withinRoots(norm, roots, pathSpace)) return;
    const key = pathSpace.key(norm);
    const prev = candidates.get(key);
    if (!prev) {
      candidates.set(key, { root: norm, source, lastTouchedAt: extra.lastTouchedAt || 0, touchCount: extra.touchCount || 0 });
      return;
    }
    const nextSource = SOURCE_PRIORITY[source] > SOURCE_PRIORITY[prev.source] ? source : prev.source;
    candidates.set(key, {
      root: prev.root,
      source: nextSource,
      lastTouchedAt: Math.max(prev.lastTouchedAt, extra.lastTouchedAt || 0),
      touchCount: Math.max(prev.touchCount, extra.touchCount || 0),
    });
  };

  let cwdRepoRoot = null;
  if (cwd) {
    const found = await findProjectRoot(cwd, pathSpace).catch(() => null);
    if (found?.root && (!roots.length || withinRoots(found.root, roots, pathSpace))) {
      cwdRepoRoot = pathSpace.toApi(await realpath(pathSpace.toFs(found.root)).catch(() => found.root));
      add(cwdRepoRoot, 'cwd');
    }
  }

  const touched = tracker ? tracker.getPaneRepos(paneId) : [];
  const writeRoots = [];
  for (const entry of touched) {
    if (!(await dirExists(entry.root))) continue;
    const src = entry.kind === 'write' ? 'agent-write' : 'agent-read';
    add(entry.root, src, { lastTouchedAt: entry.lastTouchedAt, touchCount: entry.touchCount });
    if (entry.kind === 'write') writeRoots.push(entry);
  }
  writeRoots.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);

  const worktreeSeeds = [];
  if (cwdRepoRoot) worktreeSeeds.push(cwdRepoRoot);
  for (const item of writeRoots.slice(0, 2)) {
    if (!worktreeSeeds.some((s) => pathSpace.key(s) === pathSpace.key(item.root))) {
      worktreeSeeds.push(item.root);
    }
  }

  for (const seed of worktreeSeeds) {
    try {
      const id = await inspectRepoIdentity(seed, { runGit });
      if (!id.isWorktree && !id.hasWorktrees) continue;
      const rawWt = await runGit(seed, ['worktree', 'list', '--porcelain'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
      for (const wt of parseWorktreeList(rawWt)) {
        if (!wt.path || wt.bare || wt.prunable) continue;
        const canonical = pathSpace.toApi(await realpath(wt.path).catch(() => resolve(wt.path)));
        if (await dirExists(canonical)) add(canonical, 'worktree');
      }
    } catch { /* ignore worktree enumeration failure */ }
  }

  if (!cwdRepoRoot && cwd && (await dirExists(cwd))) {
    const scanned = await scanWorkspaceRepos(cwd, roots);
    for (const root of scanned) add(root, 'workspace');
  }

  const list = [...candidates.values()].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] || 0;
    const pb = SOURCE_PRIORITY[b.source] || 0;
    if (pa !== pb) return pb - pa;
    return b.lastTouchedAt - a.lastTouchedAt;
  }).slice(0, MAX_PANE_CANDIDATES);

  return { cwd: cwd || '', cwdRepoRoot, candidates: list };
}
