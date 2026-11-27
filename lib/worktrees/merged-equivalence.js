// Detect direct ancestor merge or squash/rebase patch equivalence against a base branch.
// Ported from stablyai/orca (MIT).

import { runGit as defaultRunGit } from '../api/git.js';

async function resolveDefaultBase(repoRoot, runGit) {
  for (const candidate of ['main', 'master', 'HEAD']) {
    try {
      await runGit(repoRoot, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch { /* try next */ }
  }
  return 'HEAD';
}

export async function checkMergedEquivalence({
  repoRoot,
  branch,
  head = null,
  baseBranch = null,
  runGit = defaultRunGit,
} = {}) {
  const ref = head || branch;
  if (!repoRoot || !ref) return { merged: false, method: 'none', baseRef: baseBranch || '' };
  const baseRef = baseBranch || await resolveDefaultBase(repoRoot, runGit);
  if (ref === baseRef) return { merged: false, method: 'same_ref', baseRef };

  // 1. Direct commit ancestor check
  try {
    await runGit(repoRoot, ['merge-base', '--is-ancestor', ref, baseRef]);
    return { merged: true, method: 'ancestor', baseRef };
  } catch { /* not a fast-forward/merge ancestor */ }

  // 2. Patch equivalence via git cherry (+ vs -) — all commits equivalent to base patches
  try {
    const cherryOut = String(await runGit(repoRoot, ['cherry', baseRef, ref], { allowExit: [128] }) || '').trim();
    if (cherryOut) {
      const lines = cherryOut.split('\n').filter(Boolean);
      const unmerged = lines.filter((line) => line.startsWith('+'));
      if (lines.length > 0 && unmerged.length === 0) {
        return { merged: true, method: 'cherry', baseRef };
      }
    }
  } catch { /* ignore */ }

  // 3. Squash tree equivalence (virtual squash commit compared via git cherry)
  try {
    const mergeBase = String(await runGit(repoRoot, ['merge-base', baseRef, ref]) || '').trim();
    const refTree = String(await runGit(repoRoot, ['rev-parse', `${ref}^{tree}`]) || '').trim();
    if (mergeBase && refTree) {
      const baseTree = String(await runGit(repoRoot, ['rev-parse', `${baseRef}^{tree}`]) || '').trim();
      if (refTree === baseTree) {
        return { merged: true, method: 'tree_equal', baseRef };
      }
      const squashSha = String(await runGit(repoRoot, ['commit-tree', refTree, '-p', mergeBase, '-m', 'squash-check']) || '').trim();
      if (squashSha) {
        const cherrySquash = String(await runGit(repoRoot, ['cherry', baseRef, squashSha]) || '').trim();
        if (cherrySquash.startsWith('-')) {
          return { merged: true, method: 'squash_equivalent', baseRef };
        }
      }
    }
  } catch { /* ignore */ }

  return { merged: false, method: 'none', baseRef };
}
