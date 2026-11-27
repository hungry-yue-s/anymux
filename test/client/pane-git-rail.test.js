import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { BLOCKS, WORKSPACE_BLOCKS } from '../helpers/blocks.js';

const PREVIEW = fs.readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
const HOST = fs.readFileSync('plugins/ui/client/js/block-host.js', 'utf8');
const INSTANCE = '1873:1700000000';

let dom;
afterEach(() => {
  vi.useRealTimers();
  dom?.window.close();
});

function setupEnv({ paneReposAnswer = null, statusAnswers = {}, worktreeAnswers = {} } = {}) {
  dom = new JSDOM(
    '<!doctype html><body><div class="ms-app mode-terminal">'
    + '<header class="ms-topbar" id="ms-topbar"><div class="crumbs"><div class="window-context" id="ms-window-context"><div class="crumb">本机</div><h1 class="page-title">工作台</h1></div></div></header>'
    + '<main class="ms-main"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/', runScripts: 'outside-only' },
  );
  const win = dom.window;
  const doc = win.document;
  Object.defineProperty(win, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('ms-main')) {
      return { left: 0, right: 1200, top: 0, bottom: 900, width: 1200, height: 900 };
    }
    return { left: 400, right: 620, top: 40, bottom: 68, width: 220, height: 28 };
  };
  win.Api = { activeServerId: () => 'local', nodeUrl: (_id, path) => path };
  win.Auth = { headers: () => ({}), wsTokenParam: () => 'token=t' };
  win.fetch = vi.fn(() => Promise.reject(new Error('stubbed')));
  win._copyToClipboard = vi.fn();

  win.eval(PREVIEW);
  win.eval(HOST);
  win.eval(BLOCKS);

  win.TerminalTarget = { serverId: 'local', sessionId: '$0', windowId: '@0' };
  win.state = { currentPane: '%1' };
  win.FilePreview.switchDockContext('local', '@0', INSTANCE);

  const rail1 = doc.createElement('header');
  rail1.className = 'seam-rail';
  const ctx1 = doc.createElement('span');
  ctx1.className = 'pane-ctx';
  ctx1.textContent = 'app-main';
  const slot1 = doc.createElement('div');
  slot1.className = 'pane-git-slot';
  slot1.hidden = true;
  rail1.append(ctx1, slot1);

  const rail2 = doc.createElement('header');
  rail2.className = 'seam-rail';
  const ctx2 = doc.createElement('span');
  ctx2.className = 'pane-ctx';
  ctx2.textContent = 'workspace';
  const slot2 = doc.createElement('div');
  slot2.className = 'pane-git-slot';
  slot2.hidden = true;
  rail2.append(ctx2, slot2);

  doc.querySelector('.terminal-view').append(rail1, rail2);

  win.Workbench = {
    focusedSession: () => ({
      target: { serverId: 'local', windowId: '@0' },
      getPaneRailSlots: () => ({
        serverId: 'local',
        windowId: '@0',
        panes: [
          { paneId: '%1', cwd: '/Users/me/proj/app-main', slotEl: slot1, railEl: rail1 },
          { paneId: '%2', cwd: '/Users/me/proj', slotEl: slot2, railEl: rail2 },
        ],
      }),
    }),
  };

  const get = vi.fn(async (path, query) => {
    if (path === '/api/git/pane-repos') {
      return typeof paneReposAnswer === 'function' ? paneReposAnswer(query) : paneReposAnswer;
    }
    if (path === '/api/git/status') {
      const target = query.path || '.';
      if (statusAnswers[target]) return statusAnswers[target];
      return {
        root: target === '.' ? '/Users/me/proj/app-main' : target,
        mainRoot: '/Users/me/proj/app-main',
        repoName: 'app-main',
        isWorktree: false,
        hasWorktrees: true,
        worktreeName: null,
        displayPath: '~/proj/app-main',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        detached: false,
        files: [],
        head: { hash: 'abc', subject: 'init' },
      };
    }
    if (path === '/api/worktrees') {
      return worktreeAnswers[query.path] || {
        repoRoot: '/Users/me/proj/app-main',
        worktrees: [
          { path: '/Users/me/proj/app-main', branch: 'main', isMain: true, dirtyCount: 0 },
          { path: '/Users/me/proj/.anymux-worktrees/app-main/feat-ui', branch: 'feat/ui', isMain: false, dirtyCount: 2 },
        ],
      };
    }
    if (path === '/api/git/diff') return { diff: '' };
    if (path === '/api/git/log') return { rows: [] };
    throw new Error('Unexpected GET ' + path);
  });
  const send = vi.fn(async () => ({}));
  win.Blocks.ui.client = () => ({ get, send, url: (p) => p });
  win.eval(WORKSPACE_BLOCKS);

  return { win, doc, get, send, rail1, rail2, slot1, slot2 };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('per-pane Git rail & worktree-aware Git preview', () => {
  it('never renders global .pane-git-chip in .ms-topbar .crumbs', async () => {
    const { win, doc } = setupEnv({
      paneReposAnswer: {
        panes: {
          '%1': {
            cwd: '/Users/me/proj/app-main',
            repos: [{ root: '/Users/me/proj/app-main', repoName: 'app-main', branch: 'main', dirtyCount: 1, ahead: 1, behind: 0, source: 'cwd' }],
          },
          '%2': { cwd: '/Users/me/proj', repos: [] },
        },
      },
    });
    await win.Blocks._paneGit.refresh(true);
    await flush();

    expect(doc.querySelector('.ms-topbar .crumbs .pane-git-chip')).toBeNull();
    expect(doc.querySelectorAll('.pane-rail-git-chip')).toHaveLength(1);
  });

  it('renders single repo chip and multi-repo fold/expand popover per pane', async () => {
    const { win, doc, rail1, slot1, slot2 } = setupEnv({
      paneReposAnswer: {
        panes: {
          '%1': {
            cwd: '/Users/me/proj/app-main',
            repos: [
              { root: '/Users/me/proj/app-main', repoName: 'app-main', branch: 'main', dirtyCount: 2, ahead: 1, behind: 0, source: 'cwd' },
            ],
          },
          '%2': {
            cwd: '/Users/me/proj',
            repos: [
              { root: '/Users/me/proj/app-main', repoName: 'app-main', branch: 'main', dirtyCount: 2, source: 'agent-write', displayPath: './app-main' },
              { root: '/Users/me/proj/.anymux-worktrees/app-main/feat-ui', repoName: 'app-main', worktreeName: 'feat-ui', isWorktree: true, branch: 'feat/ui', dirtyCount: 3, source: 'worktree', displayPath: './.anymux-worktrees/app-main/feat-ui' },
              { root: '/Users/me/proj/sdk', repoName: 'sdk', branch: 'dev', dirtyCount: 0, source: 'workspace', displayPath: './sdk' },
            ],
          },
        },
      },
    });

    await win.Blocks._paneGit.refresh(true);
    await flush();

    // Pane 1: single chip, hides redundant .pane-ctx because cwd basename matches repoName
    expect(slot1.hidden).toBe(false);
    expect(rail1.classList.contains('hide-pane-ctx')).toBe(true);
    expect(slot1.querySelector('.pane-rail-git-chip').textContent).toContain('app-main');
    expect(slot1.querySelector('.pane-rail-git-more')).toBeNull();

    // Pane 2: primary chip + '+2 · ●3' fold trigger
    expect(slot2.hidden).toBe(false);
    const more = slot2.querySelector('.pane-rail-git-more');
    expect(more).not.toBeNull();
    expect(more.querySelector('.prg-expand-label').textContent).toContain('+2');
    expect(more.querySelector('.prg-expand-label').textContent).toContain('●3');

    more.click();
    const pop = doc.querySelector('.pane-git-popover');
    expect(pop).not.toBeNull();
    const items = pop.querySelectorAll('.pane-git-item');
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toContain('WT');
    expect(items[1].textContent).toContain('feat/ui');
    expect(items[1].textContent).toContain('./.anymux-worktrees/app-main/feat-ui');

    // Clicking the worktree item opens Git preview at that exact worktree root
    const openSpy = vi.spyOn(win.BlockHost, 'open');
    items[1].click();
    expect(doc.querySelector('.pane-git-popover')).toBeNull();
    expect(openSpy).toHaveBeenCalledWith('git', { path: '/Users/me/proj/.anymux-worktrees/app-main/feat-ui' });
  });

  it('shows worktree context bar, worktree switcher, and disambiguated dock tab titles + tooltips', async () => {
    const wtRoot = '/Users/me/proj/.anymux-worktrees/app-main/feat-ui';
    const mainRoot = '/Users/me/proj/app-main';
    const dupA = '/Users/me/a/service';
    const dupB = '/Users/me/b/service';

    const { win, doc } = setupEnv({
      statusAnswers: {
        [mainRoot]: {
          root: mainRoot, mainRoot, repoName: 'app-main', isWorktree: false, hasWorktrees: true, worktreeName: null,
          displayPath: '~/proj/app-main', branch: 'main', files: [], detached: false, head: null,
        },
        [wtRoot]: {
          root: wtRoot, mainRoot, repoName: 'app-main', isWorktree: true, hasWorktrees: true, worktreeName: 'feat-ui',
          displayPath: '~/proj/.anymux-worktrees/app-main/feat-ui', branch: 'feat/ui', files: [], detached: false, head: null,
        },
        [dupA]: {
          root: dupA, mainRoot: dupA, repoName: 'service', isWorktree: false, hasWorktrees: false, worktreeName: null,
          displayPath: '~/a/service', branch: 'main', files: [], detached: false, head: null,
        },
        [dupB]: {
          root: dupB, mainRoot: dupB, repoName: 'service', isWorktree: false, hasWorktrees: false, worktreeName: null,
          displayPath: '~/b/service', branch: 'dev', files: [], detached: false, head: null,
        },
      },
    });

    win.BlockHost.open('git', { path: mainRoot });
    win.BlockHost.open('git', { path: wtRoot });
    win.BlockHost.open('git', { path: dupA });
    win.BlockHost.open('git', { path: dupB });
    await flush();

    const tabs = [...doc.querySelectorAll('.fp-dock-tab')];
    const labels = tabs.map((t) => t.querySelector('.fp-dock-tab-label').textContent);
    expect(labels).toContain('app-main');
    expect(labels).toContain('app-main · feat-ui');
    expect(labels).toContain('service · a');
    expect(labels).toContain('service · b');

    const wtTab = tabs.find((t) => t.querySelector('.fp-dock-tab-label').textContent === 'app-main · feat-ui');
    expect(wtTab.title).toContain('[Worktree] app-main');
    expect(wtTab.title).toContain(wtRoot);
    expect(wtTab.title).toContain(mainRoot);

    // Check merged single-row header inside the worktree Git block
    wtTab.click();
    await flush();
    const activeFrame = [...doc.querySelectorAll('.blk-frame')].find((f) => !f.hidden);
    expect(activeFrame.querySelector('.git-context-bar')).toBeNull();
    const ctxTrigger = activeFrame.querySelector('.git-bar .git-ctx-trigger');
    expect(ctxTrigger).not.toBeNull();
    expect(ctxTrigger.hidden).toBe(false);
    expect(ctxTrigger.querySelector('.git-ctx-badge').textContent).toBe('Worktree');
    expect(ctxTrigger.querySelector('.git-ctx-name').textContent).toBe('app-main · feat-ui');
    expect(ctxTrigger.querySelector('.git-ctx-path').title).toBe(wtRoot);

    // Click repo context trigger to open unified popover with full path, copy/open actions, and worktree switcher
    ctxTrigger.click();
    await flush();
    let menu = activeFrame.querySelector('.git-wt-menu');
    expect(menu).not.toBeNull();
    expect(menu.querySelector('.git-wt-menu-fullpath').textContent).toBe(wtRoot);
    menu.querySelector('[aria-label="复制仓库路径"]').click();
    expect(win._copyToClipboard).toHaveBeenCalledWith(wtRoot);
    expect(activeFrame.querySelector('.git-wt-menu')).toBeNull();

    // Re-open menu and switch to main worktree
    ctxTrigger.click();
    await flush();
    menu = activeFrame.querySelector('.git-wt-menu');
    const wtRows = menu.querySelectorAll('.git-wt-menu-item');
    expect(wtRows).toHaveLength(2);
    const openSpy = vi.spyOn(win.BlockHost, 'open');
    wtRows[0].click();
    expect(openSpy).toHaveBeenCalledWith('git', { path: mainRoot });

    // Plain repo without worktrees still opens the popover with full path & actions, and no worktree list
    const plainTab = tabs.find((t) => t.querySelector('.fp-dock-tab-label').textContent === 'service · a');
    plainTab.click();
    await flush();
    const plainFrame = [...doc.querySelectorAll('.blk-frame')].find((f) => !f.hidden);
    plainFrame.querySelector('.git-bar .git-ctx-trigger').click();
    await flush();
    const plainMenu = plainFrame.querySelector('.git-wt-menu');
    expect(plainMenu).not.toBeNull();
    expect(plainMenu.querySelector('.git-wt-menu-fullpath').textContent).toBe(dupA);
    expect(plainMenu.querySelector('[aria-label="复制仓库路径"]')).not.toBeNull();
    expect(plainMenu.querySelector('[aria-label="浏览仓库目录"]')).not.toBeNull();
    expect(plainMenu.querySelectorAll('.git-wt-menu-item')).toHaveLength(0);
  });

  it('filters long multi-repo popovers by keyword, closes on Escape, and falls back to /api/git/status on 404', async () => {
    const manyRepos = Array.from({ length: 7 }, (_, i) => ({
      root: `/Users/me/proj/repo-${i}`,
      repoName: `repo-${i}`,
      branch: i === 4 ? 'hotfix/auth' : 'main',
      dirtyCount: i === 4 ? 2 : 0,
      source: i === 0 ? 'cwd' : 'workspace',
      displayPath: `./repo-${i}`,
    }));
    const { win, doc, get, slot2 } = setupEnv({
      paneReposAnswer: () => manyRepos && {
        panes: {
          '%1': { cwd: '/Users/me/proj/repo-0', repos: [manyRepos[0]] },
          '%2': { cwd: '/Users/me/proj', repos: manyRepos },
        },
      },
    });
    await win.Blocks._paneGit.refresh(true);
    await flush();

    const more = slot2.querySelector('.pane-rail-git-more');
    more.click();
    const pop = doc.querySelector('.pane-git-popover');
    const filter = pop.querySelector('.blk-input');
    expect(filter).not.toBeNull();
    expect(pop.querySelectorAll('.pane-git-item')).toHaveLength(7);

    filter.value = 'hotfix';
    filter.dispatchEvent(new win.Event('input', { bubbles: true }));
    const filtered = pop.querySelectorAll('.pane-git-item');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].textContent).toContain('repo-4');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc.querySelector('.pane-git-popover')).toBeNull();

    // Simulate 404 from older Node on /api/git/pane-repos
    get.mockImplementation(async (path, query) => {
      if (path === '/api/git/pane-repos') throw Object.assign(new Error('Not found'), { status: 404 });
      if (path === '/api/git/status') {
        return { root: '/Users/me/legacy-' + query.paneId.slice(1), repoName: 'legacy-' + query.paneId.slice(1), branch: 'main', files: [], detached: false };
      }
      throw new Error('Unexpected ' + path);
    });
    await win.Blocks._paneGit.refresh(true);
    await flush();
    expect(slot2.querySelector('.pane-rail-git-chip').textContent).toContain('legacy-2');
  });
});
