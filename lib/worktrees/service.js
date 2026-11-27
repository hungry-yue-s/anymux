import { lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseStatus, runGit } from '../api/git.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { evaluateWorktreeCleanup } from './cleanup-evaluator.js';
import { runWorktreeHook } from './hooks-runner.js';
import { generateWorktreeSlug } from './naming.js';
import { pretrustWorktree, revokeWorktreeTrust } from '../agent-launch/trust.js';

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const CONFIG_CANDIDATES = ['.anymux/worktrees.json', 'anymux.json', 'orca.json'];

function failValidation(message, details = null) {
  const err = new AppError(ErrorCode.VALIDATION_ERROR, message);
  if (details) err.details = details;
  return err;
}

function assertSafeRef(value, label) {
  if (typeof value !== 'string') throw failValidation(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.startsWith('-') || CONTROL_CHARS.test(trimmed) || trimmed.includes('..') || trimmed.includes('@{')) {
    throw failValidation(`${label} 格式无效`);
  }
  return trimmed;
}

function safeRelativeDir(rel) {
  if (typeof rel !== 'string') return null;
  const raw = rel.trim();
  if (!raw || raw === '.' || raw.startsWith('/') || raw.startsWith('\\') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || CONTROL_CHARS.test(raw)) return null;
  const parts = raw.split(/[/\\]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}

function slugifyBranch(name) {
  return String(name || 'worktree')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'worktree';
}

function isSameOrChildPath(candidate, parent) {
  if (!candidate || !parent) return false;
  const normParent = resolve(parent);
  const normCand = resolve(candidate);
  return normCand === normParent || normCand.startsWith(normParent + sep);
}

export async function resolveRepoRoot(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) throw failValidation('缺少仓库路径');
  const root = String(await runGit(repoPath, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) throw failValidation('目标路径不是 Git 仓库');
  return realpath(root).catch(() => root);
}

export async function readWorktreeConfig(repoRoot) {
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      const raw = await readFile(join(repoRoot, candidate), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const shared = Array.isArray(parsed.sharedDirectories)
        ? parsed.sharedDirectories.map(safeRelativeDir).filter(Boolean)
        : [];
      return {
        configFile: candidate,
        sharedDirectories: [...new Set(shared)],
        setupScript: typeof parsed.setupScript === 'string' ? parsed.setupScript : null,
        teardownScript: typeof parsed.teardownScript === 'string' ? parsed.teardownScript : null,
      };
    } catch {
      /* ignore missing or invalid config candidate and continue */
    }
  }
  return { configFile: null, sharedDirectories: [], setupScript: null, teardownScript: null };
}

export function parseWorktreeList(porcelainText) {
  const blocks = String(porcelainText || '').trim().split(/\n\n+/);
  const items = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const entry = { path: '', head: '', branch: null, detached: false, bare: false, locked: false, prunable: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        entry.branch = ref.replace(/^refs\/heads\//, '');
      } else if (line === 'detached') entry.detached = true;
      else if (line === 'bare') entry.bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) entry.locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) entry.prunable = true;
    }
    if (entry.path) items.push(entry);
  }
  return items;
}

async function activePanesByWorktree(workspace, worktrees) {
  const result = new Map(worktrees.map((wt) => [wt.path, []]));
  if (!workspace?.getWorkspace) return result;
  let tree;
  try { tree = await workspace.getWorkspace(); } catch { return result; }
  for (const session of tree?.sessions || []) {
    for (const win of session.windows || []) {
      for (const pane of win.panes || []) {
        if (!pane.cwd) continue;
        for (const wt of worktrees) {
          if (isSameOrChildPath(pane.cwd, wt.path)) {
            result.get(wt.path).push({
              sessionId: session.id,
              sessionName: session.name,
              windowId: win.id,
              windowName: win.name,
              paneId: pane.id,
              command: pane.command || '',
              cwd: pane.cwd,
            });
          }
        }
      }
    }
  }
  return result;
}

export async function listWorktrees({ repoPath, workspace = null, baseBranch = null, includeLifecycle = false } = {}) {
  const repoRoot = await resolveRepoRoot(repoPath);
  const raw = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const parsed = parseWorktreeList(raw);
  const config = await readWorktreeConfig(repoRoot);

  const resolved = await Promise.all(parsed.map(async (item, index) => {
    const canonical = await realpath(item.path).catch(() => resolve(item.path));
    let exists = true;
    let status = { branch: item.branch, ahead: 0, behind: 0, detached: item.detached, files: [] };
    try {
      await lstat(canonical);
      const rawStatus = await runGit(canonical, ['status', '--porcelain=v1', '-b', '-z'], { allowExit: [128] });
      if (rawStatus) status = parseStatus(rawStatus);
    } catch {
      exists = false;
    }
    return {
      path: canonical,
      head: item.head,
      branch: status.branch || item.branch,
      detached: item.detached || status.detached,
      bare: item.bare,
      locked: item.locked,
      prunable: item.prunable || !exists,
      exists,
      isMain: index === 0 || canonical === repoRoot,
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      dirtyCount: (status.files || []).length,
    };
  }));

  const panesMap = await activePanesByWorktree(workspace, resolved);
  let worktrees = resolved.map((wt) => ({ ...wt, activePanes: panesMap.get(wt.path) || [] }));
  if (includeLifecycle) {
    worktrees = await Promise.all(worktrees.map(async (wt) => ({
      ...wt,
      lifecycle: await evaluateWorktreeCleanup({ repoRoot, worktree: wt, baseBranch, runGit }),
    })));
  }
  return {
    repoRoot,
    config,
    worktrees,
  };
}

export async function linkSharedDirectories(repoRoot, destPath, requested = []) {
  const config = await readWorktreeConfig(repoRoot);
  const merged = [...new Set([...config.sharedDirectories, ...(Array.isArray(requested) ? requested.map(safeRelativeDir).filter(Boolean) : [])])];
  const linked = [];
  const rootReal = await realpath(repoRoot).catch(() => resolve(repoRoot));
  for (const rel of merged) {
    const src = resolve(rootReal, rel);
    if (!isSameOrChildPath(src, rootReal) || src === rootReal) continue;
    const srcReal = await realpath(src).catch(() => null);
    if (!srcReal || !isSameOrChildPath(srcReal, rootReal)) continue;
    const dst = resolve(destPath, rel);
    if (!isSameOrChildPath(dst, destPath)) continue;
    try {
      await lstat(dst);
      continue; // never overwrite an existing file/directory/link
    } catch {
      await mkdir(dirname(dst), { recursive: true });
      await symlink(srcReal, dst, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(rel);
    }
  }
  return linked;
}

export async function createWorktree({
  repoPath,
  branch = null,
  name = null,
  baseRef = null,
  createBranch = true,
  targetDir = null,
  sharedDirectories = [],
  openWindow = false,
  sessionId = null,
  autoName = false,
  configDir = null,
  claudeConfigPath = null,
  agentTypes = ['claude', 'codex'],
  tmux = null,
  workspace = null,
}) {
  const repoRoot = await resolveRepoRoot(repoPath);
  const effectiveBranch = (!branch && autoName) ? generateWorktreeSlug(name || '') : branch;
  const cleanBranch = assertSafeRef(effectiveBranch, '分支名');
  const slug = slugifyBranch(name || cleanBranch);
  const dest = targetDir
    ? resolve(targetDir)
    : join(dirname(repoRoot), '.anymux-worktrees', basename(repoRoot), slug);

  if (isSameOrChildPath(repoRoot, dest) || dest === repoRoot) {
    throw failValidation('Worktree 目录不能与主仓库重叠');
  }

  const args = ['worktree', 'add'];
  if (createBranch) {
    args.push('-b', cleanBranch, dest);
    if (baseRef) args.push(assertSafeRef(baseRef, '基线分支'));
  } else {
    args.push(dest, cleanBranch);
  }
  await runGit(repoRoot, args);
  const canonicalDest = await realpath(dest).catch(() => dest);
  const config = await readWorktreeConfig(repoRoot);
  const linked = await linkSharedDirectories(repoRoot, canonicalDest, sharedDirectories);

  let trustResult = null;
  if (configDir || claudeConfigPath) {
    trustResult = await pretrustWorktree({
      worktreePath: canonicalDest,
      configDir,
      claudeConfigPath,
      agentTypes,
    }).catch((err) => ({ trusted: false, error: err.message }));
  }

  const setupHook = config.setupScript
    ? await runWorktreeHook({
      script: config.setupScript,
      cwd: canonicalDest,
      env: {
        ANYMUX_REPO_ROOT: repoRoot,
        ANYMUX_WORKTREE_PATH: canonicalDest,
        ANYMUX_WORKTREE_BRANCH: cleanBranch,
      },
    })
    : { ran: false, ok: true };

  let openedWindow = null;
  if (openWindow && tmux?.run) {
    let targetSession = sessionId;
    if (!targetSession && workspace?.getWorkspace) {
      const tree = await workspace.getWorkspace().catch(() => null);
      targetSession = tree?.sessions?.[0]?.id || null;
    }
    const tmuxArgs = ['new-window', '-d', '-P', '-F', '#{window_id}|#{pane_id}', '-n', slug, '-c', canonicalDest];
    if (targetSession) tmuxArgs.push('-t', targetSession);
    const out = String(await tmux.run(tmuxArgs)).trim();
    const [windowId, paneId] = out.split('|');
    openedWindow = { windowId: windowId || null, paneId: paneId || null, sessionId: targetSession };
  }
  workspace?.invalidate?.();

  return {
    repoRoot,
    path: canonicalDest,
    branch: cleanBranch,
    linkedSharedDirectories: linked,
    setupHook,
    trust: trustResult,
    openedWindow,
  };
}

export async function checkRemoveWorktree({ repoPath, worktreePath, baseBranch = null, workspace = null }) {
  const { repoRoot, worktrees } = await listWorktrees({ repoPath, workspace });
  const targetReal = await realpath(worktreePath).catch(() => resolve(worktreePath));
  const match = worktrees.find((wt) => wt.path === targetReal);
  if (!match) {
    throw new AppError(ErrorCode.NOT_FOUND, '未找到指定的 Worktree');
  }
  const evaluation = await evaluateWorktreeCleanup({ repoRoot, worktree: match, baseBranch, runGit });
  return {
    safe: evaluation.safe,
    status: evaluation.status,
    isMain: match.isMain || match.path === repoRoot,
    reasons: evaluation.reasons,
    atRisk: evaluation.atRisk,
    mergeInfo: evaluation.mergeInfo,
    worktree: match,
  };
}

export async function removeWorktree({
  repoPath,
  worktreePath,
  force = false,
  deleteBranch = false,
  baseBranch = null,
  configDir = null,
  claudeConfigPath = null,
  workspace = null,
}) {
  const check = await checkRemoveWorktree({ repoPath, worktreePath, baseBranch, workspace });
  if (check.isMain) {
    throw failValidation('不能移除主仓库工作区');
  }
  if (!check.safe && !force) {
    const err = new AppError(ErrorCode.VALIDATION_ERROR, `Worktree 当前不满足安全移除条件：${check.reasons.join('；')}`);
    err.status = 409;
    err.code = 'WORKTREE_NOT_SAFE';
    err.details = check;
    throw err;
  }

  const repoRoot = await resolveRepoRoot(repoPath);
  const config = await readWorktreeConfig(repoRoot);
  const teardownHook = config.teardownScript
    ? await runWorktreeHook({
      script: config.teardownScript,
      cwd: check.worktree.path,
      env: {
        ANYMUX_REPO_ROOT: repoRoot,
        ANYMUX_WORKTREE_PATH: check.worktree.path,
        ANYMUX_WORKTREE_BRANCH: check.worktree.branch || '',
      },
    })
    : { ran: false, ok: true };

  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(check.worktree.path);
  await runGit(repoRoot, args);

  if (configDir || claudeConfigPath) {
    await revokeWorktreeTrust({
      worktreePath: check.worktree.path,
      configDir,
      claudeConfigPath,
    }).catch(() => {});
  }

  let branchDeleted = false;
  if (deleteBranch && check.worktree.branch && !check.worktree.detached) {
    try {
      await runGit(repoRoot, ['branch', force ? '-D' : '-d', check.worktree.branch]);
      branchDeleted = true;
    } catch {
      branchDeleted = false;
    }
  }
  workspace?.invalidate?.();
  return {
    removedPath: check.worktree.path,
    branch: check.worktree.branch,
    branchDeleted,
    teardownHook,
  };
}
