import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { classifyDoc } from '../../lib/agent-docs/profiles.js';
import { docSlug, splitDocName, draftLocation, findProjectRoot, pathSpace } from '../../lib/agent-docs/project.js';
import { parseProposal } from '../../lib/agent-docs/doc-info.js';
import { DocWatcher } from '../../lib/agent-docs/watcher.js';
import { createAgentDocsRouter } from '../../lib/api/agent-docs.js';
import { createOpenRouter } from '../../lib/api/open.js';
import { createPathGuard } from '../../lib/api/files.js';
import { splitFragment } from '../../bin/anymux.mjs';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A temporary directory, in the panel's path form (MSYS on Windows). */
async function temp() {
  const native = await realpath(await mkdtemp(join(tmpdir(), 'agent-docs-')));
  cleanup.push(() => rm(native, { recursive: true, force: true }));
  return { native, api: pathSpace.toApi(native) };
}

async function repo(root, name = 'project') {
  const native = join(root.native, name);
  await mkdir(join(native, '.git', 'info'), { recursive: true });
  await mkdir(join(native, 'src'), { recursive: true });
  return { native, api: pathSpace.toApi(native) };
}

describe('agent document profiles', () => {
  it('knows Anymux drafts and the superpowers directories, and nothing else', () => {
    expect(classifyDoc('/w/p/.anymux/docs/plan.md')).toMatchObject({ kind: 'draft', owner: 'anymux', open: 'activate' });
    expect(classifyDoc('/w/p/.anymux/docs/report.html')).toMatchObject({ kind: 'draft' });
    expect(classifyDoc('/w/p/docs/superpowers/specs/2026-11-16-x-design.md')).toMatchObject({ kind: 'spec', owner: 'superpowers' });
    expect(classifyDoc('/w/p/docs/superpowers/plans/2026-11-16-x.md')).toMatchObject({ kind: 'plan' });
    expect(classifyDoc('/w/p/.superpowers/sdd/x/progress.md')).toMatchObject({ kind: 'progress', open: 'background' });
    expect(classifyDoc('C:\\w\\p\\.anymux\\docs\\plan.md')).toMatchObject({ kind: 'draft' });
    expect(classifyDoc('/w/p/docs/plan.md')).toBeNull();
    expect(classifyDoc('/w/p/.anymux/docs/sub/plan.md')).toBeNull();
    expect(classifyDoc('/w/p/.anymux/docs/data.json')).toBeNull();
  });
});

describe('draft names and places', () => {
  it('keeps names in any script and drops what a path cannot hold', () => {
    expect(docSlug('文档 分窗 设计')).toBe('文档-分窗-设计');
    expect(docSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(docSlug('  ')).toBeNull();
    expect(splitDocName('plan.md')).toEqual({ slug: 'plan', ext: 'md' });
    expect(splitDocName('report', 'html')).toEqual({ slug: 'report', ext: 'html' });
    expect(() => splitDocName('x', 'exe')).toThrow();
    expect(() => splitDocName('///')).toThrow();
  });

  it('puts a draft in the project and keeps it out of git through info/exclude, once', async () => {
    const root = await temp();
    const project = await repo(root);
    const first = await draftLocation({ cwd: join(project.native, 'src'), name: '分窗设计', roots: [root.api] });
    expect(first).toMatchObject({ path: project.api + '/.anymux/docs/分窗设计.md', inProject: true, excluded: true, exists: false });
    expect(first.nativePath).toBe(pathSpace.toFs(first.path));
    await mkdir(join(project.native, '.anymux', 'docs'), { recursive: true });
    const second = await draftLocation({ cwd: project.api, name: 'other.html', roots: [root.api] });
    expect(second.path).toBe(project.api + '/.anymux/docs/other.html');
    const exclude = await readFile(join(project.native, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.anymux\/$/gm)).toHaveLength(1);
  });

  it('finds the shared exclude file of a linked worktree', async () => {
    const root = await temp();
    const main = await repo(root, 'main');
    const gitDir = join(main.native, '.git', 'worktrees', 'wt');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'commondir'), '../..\n');
    const worktree = join(root.native, 'wt');
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), 'gitdir: ' + gitDir.replace(/\\/g, '/') + '\n');
    const found = await findProjectRoot(worktree);
    expect(found).toMatchObject({ root: pathSpace.toApi(worktree), isFile: true });
    const result = await draftLocation({ cwd: worktree, name: 'x', roots: [root.api] });
    expect(result.excluded).toBe(true);
    expect(await readFile(join(main.native, '.git', 'info', 'exclude'), 'utf8')).toContain('/.anymux/');
  });

  it('falls back to the app data directory outside a project, and refuses places the preview cannot read', async () => {
    const root = await temp();
    const loose = join(root.native, 'notes');
    await mkdir(loose);
    const dataDir = join(root.native, 'data');
    const result = await draftLocation({ cwd: loose, name: 'x', roots: [root.api], dataDir });
    expect(result).toMatchObject({ path: pathSpace.toApi(dataDir) + '/docs/notes/x.md', inProject: false, project: null });
    const elsewhere = await temp();
    await expect(draftLocation({ cwd: loose, name: 'x', roots: [elsewhere.api], dataDir }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(draftLocation({ cwd: '', name: 'x', roots: [root.api] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('anymux open path#heading', () => {
  it('splits off a heading only when the file exists and the whole name does not', () => {
    const files = new Set(['plan.md', 'odd#name.md']);
    const exists = (path) => files.has(path);
    expect(splitFragment('plan.md#下一步', exists)).toEqual({ target: 'plan.md', fragment: '下一步' });
    expect(splitFragment('odd#name.md', exists)).toEqual({ target: 'odd#name.md', fragment: null });
    expect(splitFragment('missing.md#x', exists)).toEqual({ target: 'missing.md#x', fragment: null });
    expect(splitFragment('plan.md#', exists)).toEqual({ target: 'plan.md#', fragment: null });
  });
});

describe('placement proposals', () => {
  it('reads the anymux block of the front matter and nothing else', () => {
    const doc = '---\ntitle: 设计\nanymux:\n  status: proposed\n  target: docs/x-design.md\n  reason: 同类都在 docs/\n'
      + '  alternatives: [docs/design/x.md, "docs/y.md"]\n  also: CLAUDE.md 加链接\n---\n# 设计\n';
    expect(parseProposal(doc)).toEqual({ status: 'proposed', target: 'docs/x-design.md', reason: '同类都在 docs/',
      alternatives: ['docs/design/x.md', 'docs/y.md'], also: 'CLAUDE.md 加链接' });
    expect(parseProposal('# no front matter')).toBeNull();
    expect(parseProposal('---\ntitle: x\n---\n')).toBeNull();
    expect(parseProposal('---\nanymux:\n  status: whatever\n---\n').status).toBe('draft');
    expect(parseProposal('---\nanymux: [\n---\n')).toBeNull();
  });
});

describe('document watcher', () => {
  it('announces documents that appear after the first look, once, to the panes in that project', async () => {
    const root = await temp();
    const project = await repo(root);
    await mkdir(join(project.native, '.anymux', 'docs'), { recursive: true });
    await writeFile(join(project.native, '.anymux', 'docs', 'old.md'), '# old');
    const events = [];
    const panes = [
      { paneId: '%1', windowId: '@1', path: project.api + '/src' },
      { paneId: '%2', windowId: '@1', path: project.api },
      { paneId: '%3', windowId: '@2', path: root.api },
    ];
    const watcher = new DocWatcher({ listPanes: async () => panes, roots: [root.api], emit: (event) => events.push(event) });
    await watcher.tick();
    expect(events).toEqual([]);

    await writeFile(join(project.native, '.anymux', 'docs', 'new.md'), '# new');
    await mkdir(join(project.native, 'docs', 'superpowers', 'plans'), { recursive: true });
    await writeFile(join(project.native, 'docs', 'superpowers', 'plans', '2026-11-16-x.md'), '# plan');
    await mkdir(join(project.native, '.superpowers', 'sdd', 'x'), { recursive: true });
    await writeFile(join(project.native, '.superpowers', 'sdd', 'x', 'progress.md'), '- [ ] 1');
    await writeFile(join(project.native, 'docs', 'superpowers', 'plans', 'notes.txt'), 'not a document');
    await watcher.tick();
    expect(events).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'open-file', path: project.api + '/.anymux/docs/new.md', paneId: '%1', paneIds: ['%1', '%2'],
        placement: 'dock', activate: true, origin: 'agent-doc', kind: 'draft', owner: 'anymux' },
      expect.objectContaining({ path: project.api + '/docs/superpowers/plans/2026-11-16-x.md', kind: 'plan', activate: true }),
      expect.objectContaining({ path: project.api + '/.superpowers/sdd/x/progress.md', kind: 'progress', activate: false }),
    ]));

    await writeFile(join(project.native, '.anymux', 'docs', 'new.md'), '# changed');
    await watcher.tick();
    expect(events).toHaveLength(3);
    watcher.dispose();
    await watcher.tick();
    expect(events).toHaveLength(3);
  });

  it('does not watch projects outside the preview roots, and survives tmux being gone', async () => {
    const root = await temp();
    const project = await repo(root);
    const other = await temp();
    const events = [];
    let fail = true;
    const watcher = new DocWatcher({
      listPanes: async () => { if (fail) throw new Error('no server running'); return [{ paneId: '%1', windowId: '@1', path: project.api }]; },
      roots: [other.api], emit: (event) => events.push(event), paneRefreshMs: 0,
    });
    await watcher.tick();
    fail = false;
    await watcher.tick();
    await mkdir(join(project.native, '.anymux', 'docs'), { recursive: true });
    await writeFile(join(project.native, '.anymux', 'docs', 'x.md'), '# x');
    await watcher.tick();
    expect(events).toEqual([]);
    expect(watcher.projects.size).toBe(0);
  });
});

describe('agent documents API', () => {
  async function setup() {
    const root = await temp();
    const project = await repo(root);
    const typed = [];
    const typeText = vi.fn(async (paneId, text) => {
      if (paneId === '%9') throw Object.assign(new Error('failed'), { stderr: "can't find pane: %9" });
      if (paneId === '%8') throw Object.assign(new Error('The pane is in copy mode'), { code: 'PANE_IN_MODE' });
      typed.push([paneId, text]);
    });
    const events = [];
    const app = express();
    app.use(express.json());
    const pathGuard = createPathGuard([root.api]);
    app.use('/api/agent-docs', createAgentDocsRouter({ pathGuard, roots: [root.api], typeText }));
    app.use('/api/open', createOpenRouter({ pathGuard, broadcast: (event) => events.push(event) }));
    return { root, project, app, typed, events };
  }

  it('gives the CLI a draft path and the page the document kind and proposal', async () => {
    const { project, app } = await setup();
    let res = await request(app).post('/api/agent-docs/draft').send({ cwd: project.native, name: '方案' });
    expect(res.body.data).toMatchObject({ path: project.api + '/.anymux/docs/方案.md', inProject: true });
    await writeFile(res.body.data.nativePath, '---\nanymux:\n  status: proposed\n  target: docs/x.md\n---\n# 方案\n');
    res = await request(app).get('/api/agent-docs/info').query({ path: project.api + '/.anymux/docs/方案.md' });
    expect(res.body.data.doc).toMatchObject({ kind: 'draft', label: '草稿', proposal: { status: 'proposed', target: 'docs/x.md' } });
    await writeFile(join(project.native, 'README.md'), '# r');
    res = await request(app).get('/api/agent-docs/info').query({ path: project.api + '/README.md' });
    expect(res.body.data.doc).toBeNull();
    res = await request(app).get('/api/agent-docs/info').query({ path: project.api + '/missing.md' });
    expect(res.status).toBe(404);
  });

  it('types one line into the pane, never Enter, and only for the page', async () => {
    const { app, typed } = await setup();
    let res = await request(app).post('/api/agent-docs/reply').send({ paneId: '%3', text: '关于 x.md：\n第二行' });
    expect(res.body.data).toMatchObject({ paneId: '%3' });
    expect(typed).toEqual([['%3', '关于 x.md： 第二行']]);
    res = await request(app).post('/api/agent-docs/reply').set('Origin', 'https://elsewhere.test').send({ paneId: '%3', text: 'x' });
    expect(res.status).toBe(403);
    for (const body of [{ paneId: '3', text: 'x' }, { paneId: '%3', text: '' }, { paneId: '%3', text: '-t evil' }, { paneId: '%3', text: 'x'.repeat(2001) }]) {
      expect((await request(app).post('/api/agent-docs/reply').send(body)).status).toBe(400);
    }
    res = await request(app).post('/api/agent-docs/reply').send({ paneId: '%9', text: 'x' });
    expect(res.body.error.code).toBe('PANE_NOT_FOUND');
    res = await request(app).post('/api/agent-docs/reply').send({ paneId: '%8', text: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('复制模式');
    expect(typed).toHaveLength(1);
  });

  it('checks the pane is not in copy mode before typing, and types literally', async () => {
    const { createTmuxApi } = await import('../../lib/tmux.js');
    const calls = [];
    let inMode = '0';
    const tmux = createTmuxApi({ exec: async (_bin, args) => { calls.push(args); return { stdout: args[0] === 'display-message' ? inMode + '\n' : '' }; } });
    await tmux.typeText('%3', '关于 x.md：');
    expect(calls).toEqual([
      ['display-message', '-p', '-t', '%3', '#{pane_in_mode}'],
      ['send-keys', '-t', '%3', '-l', '关于 x.md：'],
    ]);
    inMode = '1';
    await expect(tmux.typeText('%3', 'x')).rejects.toMatchObject({ code: 'PANE_IN_MODE' });
    await expect(tmux.typeText('%3', 'a\nb')).rejects.toThrow();
    await expect(tmux.typeText('%3', '-t %1')).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  it('passes the dock options of anymux open through, filled in for known documents', async () => {
    const { project, app, events } = await setup();
    await mkdir(join(project.native, '.superpowers', 'sdd', 'x'), { recursive: true });
    await writeFile(join(project.native, '.superpowers', 'sdd', 'x', 'progress.md'), '-');
    await mkdir(join(project.native, 'docs'), { recursive: true });
    await writeFile(join(project.native, 'docs', 'design.md'), '# d');
    let res = await request(app).post('/api/open').send({ path: project.api + '/.superpowers/sdd/x/progress.md', placement: 'dock', paneId: '%1' });
    expect(res.body.success).toBe(true);
    res = await request(app).post('/api/open').send({ path: project.native + '/docs/design.md', placement: 'dock',
      replaces: project.native + '/.anymux/docs/design.md', fragment: '下一步', kind: 'design', owner: 'me' });
    expect(res.body.success).toBe(true);
    expect(events).toEqual([
      { type: 'open-file', path: project.api + '/.superpowers/sdd/x/progress.md', paneId: '%1', placement: 'dock', activate: false,
        kind: 'progress', owner: 'superpowers' },
      { type: 'open-file', path: project.api + '/docs/design.md', paneId: null, placement: 'dock', activate: true,
        replaces: project.api + '/.anymux/docs/design.md', fragment: '下一步', kind: 'design', owner: 'me' },
    ]);
    for (const extra of [{ placement: 'side' }, { activate: 'yes' }, { kind: 'a b' }, { fragment: 'x\ny' }, { replaces: 'relative/x.md' }]) {
      expect((await request(app).post('/api/open').send({ path: project.api + '/docs/design.md', ...extra })).status).toBe(400);
    }
    expect(events).toHaveLength(2);
  });
});
