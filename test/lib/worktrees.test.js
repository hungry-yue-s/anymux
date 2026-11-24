import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  checkRemoveWorktree,
  createWorktree,
  listWorktrees,
  readWorktreeConfig,
  removeWorktree,
} from '../../lib/worktrees/service.js';

const exec = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeGitRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'anymux-wt-test-')));
  tempDirs.push(base);
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# test\n');
  await exec('git', ['add', 'README.md'], { cwd: repo });
  await exec('git', ['commit', '-m', 'init'], { cwd: repo });
  return { base, repo };
}

describe('Git Worktrees service (Orca MIT port)', () => {
  it('reads orca.json fallback config and ignores traversal paths', async () => {
    const { repo } = await makeGitRepo();
    await writeFile(join(repo, 'orca.json'), JSON.stringify({
      sharedDirectories: ['node_modules', '../escape', '/abs/path', 'packages/shared/.cache'],
    }));
    const cfg = await readWorktreeConfig(repo);
    expect(cfg.configFile).toBe('orca.json');
    expect(cfg.sharedDirectories).toEqual(['node_modules', 'packages/shared/.cache']);
  });

  it('creates a worktree, symlinks sharedDirectories, tracks active tmux panes, and enforces safe removal', async () => {
    const { base, repo } = await makeGitRepo();
    await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'pkg', 'index.js'), 'export default 1;\n');
    await writeFile(join(repo, 'orca.json'), JSON.stringify({ sharedDirectories: ['node_modules'] }));

    const wtDest = join(base, 'wt-feat');
    const tmuxCalls = [];
    const created = await createWorktree({
      repoPath: repo,
      branch: 'feat/parallel',
      targetDir: wtDest,
      openWindow: true,
      sessionId: '$1',
      tmux: { run: async (args) => { tmuxCalls.push(args); return '@9|%12'; } },
      workspace: { invalidate: vi.fn(), getWorkspace: async () => ({ sessions: [{ id: '$1', name: 'main', windows: [] }] }) },
    });

    expect(created.branch).toBe('feat/parallel');
    expect(created.linkedSharedDirectories).toEqual(['node_modules']);
    expect(created.openedWindow).toMatchObject({ windowId: '@9', paneId: '%12' });
    expect(tmuxCalls[0]).toContain('new-window');
    expect((await lstat(join(created.path, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await realpath(await readlink(join(created.path, 'node_modules')))).toBe(await realpath(join(repo, 'node_modules')));

    const workspaceWithPane = {
      invalidate: vi.fn(),
      getWorkspace: async () => ({
        sessions: [{ id: '$1', name: 'main', windows: [{ id: '@9', name: 'feat', panes: [{ id: '%12', cwd: created.path, command: 'claude' }] }] }],
      }),
    };
    const listed = await listWorktrees({ repoPath: repo, workspace: workspaceWithPane });
    expect(listed.worktrees).toHaveLength(2);
    const featEntry = listed.worktrees.find((w) => !w.isMain);
    expect(featEntry.activePanes).toHaveLength(1);

    // Dirty + active pane blocks non-forced removal
    await writeFile(join(created.path, 'untracked.txt'), 'dirty\n');
    const preflight = await checkRemoveWorktree({ repoPath: repo, worktreePath: created.path, workspace: workspaceWithPane });
    expect(preflight.safe).toBe(false);
    expect(preflight.reasons.length).toBeGreaterThanOrEqual(2);
    await expect(removeWorktree({ repoPath: repo, worktreePath: created.path, workspace: workspaceWithPane })).rejects.toMatchObject({ status: 409 });

    // Refuses removing main worktree even with force
    await expect(removeWorktree({ repoPath: repo, worktreePath: repo, force: true })).rejects.toBeDefined();

    // Forced removal cleans up worktree cleanly
    const removed = await removeWorktree({ repoPath: repo, worktreePath: created.path, force: true, deleteBranch: true, workspace: workspaceWithPane });
    expect(removed.removedPath).toBe(created.path);
    expect(removed.branchDeleted).toBe(true);
  });
});
