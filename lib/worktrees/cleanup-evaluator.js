// Evaluate a worktree's lifecycle safety for automated cleanup hints.
// Ported from stablyai/orca (MIT).

import { inspectAtRiskFiles } from './at-risk-files.js';
import { checkMergedEquivalence } from './merged-equivalence.js';
import { runGit as defaultRunGit } from '../api/git.js';

export async function evaluateWorktreeCleanup({
  repoRoot,
  worktree,
  baseBranch = null,
  runGit = defaultRunGit,
} = {}) {
  if (!worktree) {
    return { status: 'at_risk', safe: false, reasons: ['无效的 worktree'], atRisk: null, mergeInfo: null };
  }
  const reasons = [];
  if (worktree.isMain || worktree.path === repoRoot) {
    return { status: 'protected', safe: false, reasons: ['主仓库工作区受保护'], atRisk: null, mergeInfo: null };
  }
  if (worktree.locked) {
    return { status: 'protected', safe: false, reasons: ['Worktree 已锁定'], atRisk: null, mergeInfo: null };
  }
  if ((worktree.activePanes || []).length > 0) {
    reasons.push(`仍有 ${worktree.activePanes.length} 个活动终端窗格位于此目录`);
  }

  const atRisk = worktree.exists !== false
    ? await inspectAtRiskFiles({ worktreePath: worktree.path, baseBranch, runGit })
    : { modified: [], untracked: [], aheadCommits: 0, dirtyCount: 0, hasRisk: false };

  if (atRisk.dirtyCount > 0) reasons.push(`有 ${atRisk.dirtyCount} 个未提交变更`);

  const mergeInfo = worktree.branch && !worktree.detached
    ? await checkMergedEquivalence({ repoRoot, branch: worktree.branch, head: worktree.head, baseBranch, runGit })
    : { merged: false, method: 'none', baseRef: baseBranch || '' };

  if (atRisk.aheadCommits > 0 && !mergeInfo.merged) {
    reasons.push(`有 ${atRisk.aheadCommits} 个尚未合入或推送的提交`);
  }

  let status = 'safe';
  if (reasons.length > 0) status = 'at_risk';
  else if (mergeInfo.merged) status = 'merged';

  return {
    status,
    safe: reasons.length === 0,
    reasons,
    atRisk,
    mergeInfo,
  };
}
