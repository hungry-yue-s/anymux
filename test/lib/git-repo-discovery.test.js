import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPathGuard } from '../../lib/api/files.js';
import { createGitRouter, runGit } from '../../lib/api/git.js';
import {
  PaneRepoTracker,
  discoverPaneRepos,
  extractPathsFromAgentPayload,
  formatDisplayPath,
  inspectRepoIdentity,
} from '../../lib/git/repo-discovery.js';
import { IS_WINDOWS, toPosixPath } from '../../lib/msys.js';

const apiPath = (native) => (IS_WINDOWS ? toPosixPath(native) : native);

function initRepo(dir, branch = 'main') {
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
}

function commitFile(dir, name, content, msg) {
  execFileSync('git', ['-C', dir, 'add', name]);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', msg]);
}

describe('git repo discovery & worktree identity', () => {
  let rootDir;
  let workspaceDir;
  let mainRepo;
  let wtRepo;
  let siblingRepo;
  let externalRepo;

  beforeAll(async () => {
    rootDir = await realpath(await mkdtemp(join(tmpdir(), 'anymux-git-disc-')));
    workspaceDir = join(rootDir, 'workspace');
    mainRepo = join(workspaceDir, 'app-main');
    wtRepo = join(workspaceDir, '.anymux-worktrees', 'app-main', 'feat-ui');
    siblingRepo = join(workspaceDir, 'sdk-lib');
    externalRepo = join(rootDir, 'external-service');

    await mkdir(workspaceDir, { recursive: true });
    initRepo(mainRepo, 'main');
    await writeFile(join(mainRepo, 'README.md'), '# main\n');
    commitFile(mainRepo, 'README.md', '# main\n', 'init main');

    await mkdir(join(workspaceDir, '.anymux-worktrees', 'app-main'), { recursive: true });
    execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', '-b', 'feat/ui', wtRepo]);
    await writeFile(join(wtRepo, 'dirty.txt'), 'uncommitted\n');

    initRepo(siblingRepo, 'dev');
    await writeFile(join(siblingRepo, 'index.js'), 'export const v = 1;\n');
    commitFile(siblingRepo, 'index.js', 'export const v = 1;\n', 'init sdk');
    await writeFile(join(siblingRepo, 'index.js'), 'export const v = 2;\n');

    initRepo(externalRepo, 'main');
    await writeFile(join(externalRepo, 'srv.js'), 'console.log(1);\n');
    commitFile(externalRepo, 'srv.js', 'console.log(1);\n', 'init srv');
    await writeFile(join(externalRepo, 'srv.js'), 'console.log(2);\n');
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('distinguishes main repository from linked worktree', async () => {
    const mainId = await inspectRepoIdentity(mainRepo, { runGit });
    expect(mainId).toMatchObject({
      root: apiPath(mainRepo),
      mainRoot: apiPath(mainRepo),
      repoName: 'app-main',
      isWorktree: false,
      hasWorktrees: true,
      worktreeName: null,
    });

    const wtId = await inspectRepoIdentity(wtRepo, { runGit });
    expect(wtId).toMatchObject({
      root: apiPath(wtRepo),
      mainRoot: apiPath(mainRepo),
      repoName: 'app-main',
      isWorktree: true,
      hasWorktrees: true,
      worktreeName: 'feat-ui',
    });
  });

  it('formats display paths concisely relative to cwd or home', () => {
    expect(formatDisplayPath('/home/alice/projects/app', { home: '/home/alice', cwd: '/home/alice/projects' }))
      .toBe('./app');
    expect(formatDisplayPath('/home/alice/other/repo', { home: '/home/alice', cwd: '/home/alice/projects' }))
      .toBe('~/other/repo');
    expect(formatDisplayPath('/var/repos/x', { home: '/home/alice', cwd: '/home/alice/projects' }))
      .toBe('/var/repos/x');
  });

  it('extracts paths and distinguishes read vs write from agent hook payloads', () => {
    const readEv = extractPathsFromAgentPayload({
      tool_name: 'read_file',
      cwd: workspaceDir,
      tool_input: { AbsolutePath: join(externalRepo, 'srv.js') },
    });
    expect(readEv.kind).toBe('read');
    expect(readEv.paths).toContain(apiPath(join(externalRepo, 'srv.js')));

    const writeEv = extractPathsFromAgentPayload({
      tool_name: 'Edit',
      cwd: workspaceDir,
      tool_input: { file_path: 'sdk-lib/index.js' },
    });
    expect(writeEv.kind).toBe('write');
    expect(writeEv.paths).toContain(apiPath(join(siblingRepo, 'index.js')));

    const bashEv = extractPathsFromAgentPayload({
      tool_name: 'Bash',
      cwd: workspaceDir,
      tool_input: { command: `git -C "${externalRepo}" status && cd "${mainRepo}"` },
    });
    expect(bashEv.kind).toBe('write');
    expect(bashEv.paths).toEqual(expect.arrayContaining([apiPath(externalRepo), apiPath(mainRepo)]));
  });

  it('tracks per-pane touched repos, upgrades read to write, and evicts clean reads first', async () => {
    let clock = 1000;
    const changes = [];
    const tracker = new PaneRepoTracker({
      roots: [apiPath(rootDir)],
      now: () => clock,
      maxPerPane: 3,
      onChange: (paneId, root, kind) => changes.push({ paneId, root, kind }),
    });

    await tracker.ingestAgentEvent({
      paneId: '%1',
      tool_name: 'read_file',
      tool_input: { path: join(externalRepo, 'srv.js') },
    });
    clock += 100;
    await tracker.ingestAgentEvent({
      paneId: '%1',
      tool_name: 'write_file',
      tool_input: { path: join(externalRepo, 'srv.js') },
    });
    expect(tracker.getPaneRepos('%1')[0].kind).toBe('write');
    expect(changes.map((c) => c.kind)).toEqual(['read', 'write']);

    // Exceed maxPerPane with reads/writes and confirm write is kept over older read
    clock += 100;
    tracker.recordRepo('%1', siblingRepo, { kind: 'read' });
    clock += 100;
    tracker.recordRepo('%1', mainRepo, { kind: 'read' });
    clock += 100;
    tracker.recordRepo('%1', wtRepo, { kind: 'write' });

    const remaining = tracker.getPaneRepos('%1').map((r) => r.root);
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain(apiPath(externalRepo));
    expect(remaining).toContain(apiPath(wtRepo));
    expect(remaining).not.toContain(apiPath(siblingRepo));
  });

  it('serves /api/git/status worktree identity and /api/git/pane-repos multi-repo batching', async () => {
    const roots = [apiPath(rootDir)];
    const pathGuard = createPathGuard(roots);
    const tracker = new PaneRepoTracker({ pathGuard, roots });
    await tracker.ingestAgentEvent({
      paneId: '%10',
      tool_name: 'Edit',
      cwd: workspaceDir,
      tool_input: { file_path: join(externalRepo, 'srv.js') },
    });

    const tmux = {
      run: async () => [
        `%10\x1f${apiPath(workspaceDir)}`,
        `%11\x1f${apiPath(wtRepo)}`,
      ].join('\n'),
    };

    const app = express();
    app.use(express.json());
    app.use('/api/git', createGitRouter({ pathGuard, tmux, paneRepoTracker: tracker, roots }));

    const wtStatus = await request(app).get('/api/git/status').query({ path: apiPath(wtRepo) });
    expect(wtStatus.status).toBe(200);
    expect(wtStatus.body.data).toMatchObject({
      root: apiPath(wtRepo),
      mainRoot: apiPath(mainRepo),
      repoName: 'app-main',
      isWorktree: true,
      hasWorktrees: true,
      worktreeName: 'feat-ui',
    });

    const batch = await request(app).get('/api/git/pane-repos').query({ paneIds: '%10,%11' });
    expect(batch.status).toBe(200);
    const p10 = batch.body.data.panes['%10'].repos;
    const p11 = batch.body.data.panes['%11'].repos;

    // %10 is in workspaceDir (non-git): sees externalRepo (agent-write dirty), sdk-lib, app-main, and feat-ui worktree
    const p10Roots = p10.map((r) => r.root);
    expect(p10Roots).toEqual(expect.arrayContaining([
      apiPath(externalRepo),
      apiPath(siblingRepo),
      apiPath(mainRepo),
      apiPath(wtRepo),
    ]));
    expect(p10[0].root).toBe(apiPath(externalRepo));
    expect(p10[0].source).toBe('agent-write');

    // %11 is inside wtRepo: cwd worktree comes first, followed by mainRepo sibling worktree
    expect(p11[0]).toMatchObject({
      root: apiPath(wtRepo),
      source: 'cwd',
      isWorktree: true,
      dirtyCount: 1,
    });
    expect(p11.some((r) => r.root === apiPath(mainRepo) && r.source === 'worktree')).toBe(true);
  });

  it('discovers workspace repos directly via discoverPaneRepos without duplicating roots', async () => {
    const res = await discoverPaneRepos({
      paneId: '%99',
      cwd: apiPath(workspaceDir),
      roots: [apiPath(rootDir)],
      runGit,
    });
    expect(res.cwdRepoRoot).toBeNull();
    const found = res.candidates.map((c) => c.root);
    expect(found).toContain(apiPath(mainRepo));
    expect(found).toContain(apiPath(siblingRepo));
    expect(found).toContain(apiPath(wtRepo));
    expect(new Set(found).size).toBe(found.length);
  });
});
