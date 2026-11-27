// Inspect modified, untracked, unpushed commits, and stashed work in a Git worktree.
// Ported from stablyai/orca (MIT).

import { runGit as defaultRunGit } from '../api/git.js';

export async function inspectAtRiskFiles({
  worktreePath,
  baseBranch = null,
  runGit = defaultRunGit,
} = {}) {
  if (!worktreePath) return { modified: [], untracked: [], aheadCommits: 0, dirtyCount: 0, hasRisk: false };

  let porcelain = '';
  try {
    porcelain = String(await runGit(worktreePath, ['status', '--porcelain=v1'], { allowExit: [128] }) || '');
  } catch {
    porcelain = '';
  }

  const modified = [];
  const untracked = [];
  for (const rawLine of porcelain.split('\n')) {
    if (!rawLine || rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    const file = rawLine.slice(3).trim();
    if (!file) continue;
    if (code === '??') untracked.push(file);
    else modified.push(file);
  }

  let aheadCommits = 0;
  try {
    const revOut = String(await runGit(worktreePath, ['rev-list', '--count', '@{u}..HEAD'], { allowExit: [128] }) || '').trim();
    const parsed = Number.parseInt(revOut, 10);
    if (Number.isFinite(parsed) && parsed > 0) aheadCommits = parsed;
  } catch {
    if (baseBranch) {
      try {
        const revOut = String(await runGit(worktreePath, ['rev-list', '--count', `${baseBranch}..HEAD`], { allowExit: [128] }) || '').trim();
        const parsed = Number.parseInt(revOut, 10);
        if (Number.isFinite(parsed) && parsed > 0) aheadCommits = parsed;
      } catch { /* no upstream or base ref */ }
    }
  }

  const dirtyCount = modified.length + untracked.length;
  return {
    modified,
    untracked,
    aheadCommits,
    dirtyCount,
    hasRisk: dirtyCount > 0 || aheadCommits > 0,
  };
}
