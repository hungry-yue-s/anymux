import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorktree, removeWorktree, listWorktrees } from '../../lib/worktrees/service.js';
import { inspectAtRiskFiles } from '../../lib/worktrees/at-risk-files.js';
import { checkMergedEquivalence } from '../../lib/worktrees/merged-equivalence.js';
import { isForbiddenTrustPath, listTrustedWorktrees, pretrustWorktree, revokeWorktreeTrust } from '../../lib/agent-launch/trust.js';

const exec = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'anymux-wt-life-')));
  tempDirs.push(base);
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'base\n');
  await exec('git', ['add', 'README.md'], { cwd: repo });
  await exec('git', ['commit', '-m', 'init'], { cwd: repo });
  return { base, repo };
}

describe('Worktrees lifecycle, squash merge equivalence, hooks, and pre-trust safety', () => {
  it('hard-refuses forbidden broad paths and manages reversible pre-trust ledger', async () => {
    expect(isForbiddenTrustPath(homedir())).toBe(true);
    expect(isForbiddenTrustPath('/')).toBe(true);
    expect(isForbiddenTrustPath('C:\\')).toBe(true);
    expect(isForbiddenTrustPath('/System')).toBe(true);
    expect(isForbiddenTrustPath('/Users/someone/repo/.anymux-worktrees/repo/wt-1')).toBe(false);

    const cfgDir = await mkdtemp(join(tmpdir(), 'anymux-trust-cfg-'));
    tempDirs.push(cfgDir);
    const claudeJson = join(cfgDir, 'claude.json');
    const wtPath = join(cfgDir, 'worktrees', 'feat-alpha');
    await expect(pretrustWorktree({ worktreePath: homedir(), configDir: cfgDir })).rejects.toThrow(/forbidden/i);

    const trusted = await pretrustWorktree({ worktreePath: wtPath, configDir: cfgDir, claudeConfigPath: claudeJson });
    expect(trusted.trusted).toBe(true);
    expect(trusted.claudeTrusted).toBe(true);
    expect((await listTrustedWorktrees({ configDir: cfgDir })).length).toBe(1);
    const claudeAfterAdd = JSON.parse(await readFile(claudeJson, 'utf8'));
    expect(claudeAfterAdd.projects[wtPath].hasTrustDialogAccepted).toBe(true);

    await revokeWorktreeTrust({ worktreePath: wtPath, configDir: cfgDir, claudeConfigPath: claudeJson });
    expect((await listTrustedWorktrees({ configDir: cfgDir })).length).toBe(0);
    const claudeAfterRevoke = JSON.parse(await readFile(claudeJson, 'utf8'));
    expect(claudeAfterRevoke.projects[wtPath]).toBeUndefined();
  });

  it('detects squash-merged equivalence, runs setup/teardown hooks, and revokes trust on removal', async () => {
    const { base, repo } = await makeRepo();
    const cfgDir = join(base, 'cfg');
    await writeFile(join(repo, 'anymux.json'), JSON.stringify({
      setupScript: 'node -e "require(\'fs\').writeFileSync(\'.setup-ran\', process.env.ANYMUX_WORKTREE_BRANCH)"',
      teardownScript: 'node -e "require(\'fs\').writeFileSync(\'../teardown-ran.txt\', process.env.ANYMUX_WORKTREE_BRANCH)"',
    }));
    await exec('git', ['add', 'anymux.json'], { cwd: repo });
    await exec('git', ['commit', '-m', 'add hooks'], { cwd: repo });

    const created = await createWorktree({
      repoPath: repo,
      autoName: true,
      configDir: cfgDir,
    });
    expect(created.setupHook.ok).toBe(true);
    expect(await readFile(join(created.path, '.setup-ran'), 'utf8')).toBe(created.branch);
    expect((await listTrustedWorktrees({ configDir: cfgDir })).length).toBe(1);

    // Dirty check detects untracked hook file until removed
    const risk = await inspectAtRiskFiles({ worktreePath: created.path, baseBranch: 'main' });
    expect(risk.hasRisk).toBe(true);
    await rm(join(created.path, '.setup-ran'));

    // Commit in worktree then squash-merge onto main
    await writeFile(join(created.path, 'feature.txt'), 'hello squash\n');
    await exec('git', ['add', 'feature.txt'], { cwd: created.path });
    await exec('git', ['commit', '-m', 'feat commit'], { cwd: created.path });

    await exec('git', ['merge', '--squash', created.branch], { cwd: repo });
    await exec('git', ['commit', '-m', 'squash feat'], { cwd: repo });

    const eq = await checkMergedEquivalence({ repoRoot: repo, branch: created.branch, baseBranch: 'main' });
    expect(eq.merged).toBe(true);

    const listed = await listWorktrees({ repoPath: repo, includeLifecycle: true, baseBranch: 'main' });
    const wtEntry = listed.worktrees.find((w) => !w.isMain);
    expect(wtEntry.lifecycle.status).toBe('merged');
    expect(wtEntry.lifecycle.safe).toBe(true);

    const removed = await removeWorktree({
      repoPath: repo,
      worktreePath: created.path,
      baseBranch: 'main',
      configDir: cfgDir,
      deleteBranch: true,
      force: true,
    });
    expect(removed.teardownHook.ok).toBe(true);
    expect((await listTrustedWorktrees({ configDir: cfgDir })).length).toBe(0);
    expect(await readFile(join(created.path, '..', 'teardown-ran.txt'), 'utf8')).toBe(created.branch);
  });
});
