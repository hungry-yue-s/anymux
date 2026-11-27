import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DockStore,
  MAX_BLOCKS_PER_WINDOW,
  MAX_FILES_PER_WINDOW,
  MAX_NOTICES,
} from '../../lib/dock/store.js';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeStore(nowFn = () => 1_700_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'anymux-dock-store-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'dock-state.json');
  return { dir, filePath, store: new DockStore(filePath, { now: nowFn }) };
}

describe('DockStore', () => {
  it('persists atomically across restarts and handles concurrent ops sequentially', async () => {
    const { filePath, store } = makeStore();
    await store.load();
    await store.setServerInstance('100:1700000000');

    await Promise.all([
      store.applyWindowOp('@1', { type: 'upsert-file', path: '/a/one.md', paneId: '%1', activate: true }),
      store.applyWindowOp('@1', { type: 'upsert-file', path: '/a/two.md', paneId: '%2', activate: false }),
      store.applyWindowOp('@1', { type: 'upsert-block', kind: 'git', persistKey: 'git:/a', params: { path: '/a' }, activate: false }),
      store.applyServerBlockOp({ type: 'upsert-block', kind: 'browser', persistKey: 'browser', params: { url: 'http://localhost:3000' } }),
    ]);

    const reloaded = new DockStore(filePath);
    const snap = await reloaded.load();
    expect(snap.instanceId).toBe('100:1700000000');
    expect(snap.windows['@1'].items.map((i) => i.key)).toEqual(['file:/a/one.md', 'file:/a/two.md', 'block:git:/a']);
    expect(snap.windows['@1'].activeKey).toBe('file:/a/one.md');
    expect(snap.serverBlocks.items).toHaveLength(1);
    expect(snap.serverBlocks.items[0].params.url).toBe('http://localhost:3000');
  });

  it('recovers cleanly from corrupt JSON on disk', async () => {
    const { filePath, store } = makeStore();
    writeFileSync(filePath, '{corrupt json');
    const snap = await store.load();
    expect(snap.windows).toEqual({});
    expect(snap.notices).toEqual([]);
  });

  it('rejects malformed paths, window ids, and oversized payloads, and enforces per-window bounds', async () => {
    const { store } = makeStore();
    await store.load();
    await store.setServerInstance('100:1700000000');

    await expect(store.applyWindowOp('bad', { type: 'upsert-file', path: '/a.md' })).rejects.toThrow(/invalid_window_id/);
    await expect(store.applyWindowOp('@1', { type: 'upsert-file', path: 'relative.md' })).rejects.toThrow(/invalid_path/);
    await expect(store.applyWindowOp('@1', {
      type: 'upsert-block', kind: 'git', persistKey: 'git:/a', params: { big: 'x'.repeat(9000) },
    })).rejects.toThrow(/params_too_large/);

    for (let i = 0; i < MAX_FILES_PER_WINDOW + 4; i++) {
      await store.applyWindowOp('@1', { type: 'upsert-file', path: `/tmp/f-${i}.md`, activate: true });
    }
    for (let i = 0; i < MAX_BLOCKS_PER_WINDOW + 3; i++) {
      await store.applyWindowOp('@1', { type: 'upsert-block', kind: 'git', persistKey: `git:/r-${i}`, params: { path: `/r-${i}` } });
    }
    const snap = store.getSnapshot({ windowId: '@1' });
    expect(snap.windows['@1'].items.filter((i) => i.type === 'file')).toHaveLength(MAX_FILES_PER_WINDOW);
    expect(snap.windows['@1'].items.filter((i) => i.type === 'block')).toHaveLength(MAX_BLOCKS_PER_WINDOW);
  });

  it('enforces recordFileArrival and recordGitArrival contracts', async () => {
    let now = 1_700_000_000_000;
    const { store } = makeStore(() => now++);
    await store.load();
    await store.setServerInstance('100:1700000000');

    // Background arrival on empty window skips creating dock tab
    const skipped = await store.recordFileArrival({
      path: '/w/progress.md', paneId: '%1', windowId: '@2', instanceId: '100:1700000000', activate: false,
    });
    expect(skipped.window).toBeNull();

    // Explicit arrival creates tab + unread notice; later scan without paneId preserves explicit paneId
    await store.recordFileArrival({
      path: '/w/plan.md', paneId: '%4', windowId: '@2', instanceId: '100:1700000000', sessionName: 'dev', windowIndex: 2, windowName: 'docs', activate: true,
    });
    await store.recordFileArrival({
      path: '/w/plan.md', paneId: null, windowId: '@2', instanceId: '100:1700000000', activate: true,
    });
    expect(store.getSnapshot().windows['@2'].items[0].paneId).toBe('%4');

    // activate: false Git arrival must NOT create a Git block, only a notice
    const bgGit = await store.recordGitArrival({
      path: '/repo', commit: 'WORKTREE', dirtyCount: 3, paneId: '%4', windowId: '@2', instanceId: '100:1700000000', activate: false,
    });
    expect(bgGit.window.items.some((i) => i.type === 'block')).toBe(false);
    expect(store.getSnapshot().notices.some((n) => n.type === 'git' && n.commit === 'WORKTREE')).toBe(true);

    // activate: true Git arrival creates/updates Git block
    const fgGit = await store.recordGitArrival({
      path: '/repo', commit: 'abcd1234', paneId: '%4', windowId: '@2', instanceId: '100:1700000000', activate: true,
    });
    expect(fgGit.window.items.some((i) => i.type === 'block' && i.kind === 'git' && i.params.commit === 'abcd1234')).toBe(true);

    // Cap notices at MAX_NOTICES
    for (let i = 0; i < MAX_NOTICES + 10; i++) {
      await store.applyNoticeOp({
        type: 'upsert',
        notice: { type: 'document', path: `/doc/${i}.md`, target: { instanceId: '100:1700000000', windowId: '@2' } },
      });
    }
    expect(store.getSnapshot().notices).toHaveLength(MAX_NOTICES);
  });

  it('archives on instance change while keeping serverBlocks, and migrates restored windows with cleared paneId', async () => {
    const { store } = makeStore();
    await store.load();
    await store.setServerInstance('100:1700000000');

    await store.applyServerBlockOp({ type: 'upsert-block', kind: 'browser', persistKey: 'browser', params: { url: 'http://localhost:4000' } });
    await store.recordFileArrival({
      path: '/repo/README.md', paneId: '%9', windowId: '@5', instanceId: '100:1700000000',
      sessionName: 'work', windowIndex: 1, windowName: 'main', activate: true,
    });
    await store.recordGitArrival({
      path: '/repo', commit: 'deadbeef', paneId: '%9', windowId: '@5', instanceId: '100:1700000000',
      sessionName: 'work', windowIndex: 1, windowName: 'main', activate: true,
    });

    // tmux restarts with new instanceId
    await store.setServerInstance('200:1700000500');
    expect(store.getSnapshot().windows).toEqual({});
    expect(store.getSnapshot().serverBlocks.items).toHaveLength(1);

    // SessionProtection restores window @5 as @12 under new instance
    const migrated = await store.migrateRestoredWindows('200:1700000500', [
      { sessionName: 'work', restoredSessionName: 'work', windowIndex: 1, windowName: 'main', origWindowId: '@5', newWindowId: '@12' },
    ]);
    expect(migrated.migratedWindows).toBe(1);
    expect(migrated.migratedNotices).toBe(2);

    const after = store.getSnapshot();
    expect(after.windows['@12'].items).toHaveLength(2);
    expect(after.windows['@12'].items.find((i) => i.type === 'file').paneId).toBeNull();
    expect(after.windows['@12'].items.find((i) => i.type === 'block').params.paneId ?? null).toBeNull();
    expect(after.notices.every((n) => n.target.instanceId === '200:1700000500' && n.target.windowId === '@12' && n.paneId === null)).toBe(true);
  });

  it('sweeps dead windows and imports legacy data without overwriting existing server windows', async () => {
    const { store } = makeStore();
    await store.load();
    await store.setServerInstance('100:1700000000');

    await store.applyWindowOp('@1', { type: 'upsert-file', path: '/server-kept.md', activate: true });
    await store.applyWindowOp('@2', { type: 'upsert-file', path: '/dead.md', activate: true });

    await store.importLegacy({
      instanceId: '100:1700000000',
      windows: {
        '@1': { items: [{ type: 'file', path: '/legacy-ignored.md' }] },
        '@3': { items: [{ type: 'file', path: '/legacy-imported.md' }], activeKey: 'file:/legacy-imported.md' },
      },
      serverBlocks: { items: [{ kind: 'browser', persistKey: 'browser', params: { url: 'http://localhost:5173' } }] },
    });

    expect(store.getSnapshot().windows['@1'].items.map((i) => i.path)).toEqual(['/server-kept.md']);
    expect(store.getSnapshot().windows['@3'].items.map((i) => i.path)).toEqual(['/legacy-imported.md']);
    expect(store.getSnapshot().serverBlocks.items[0].params.url).toBe('http://localhost:5173');

    await store.sweepLiveWindows('100:1700000000', new Set(['@1', '@3']));
    expect(Object.keys(store.getSnapshot().windows).sort()).toEqual(['@1', '@3']);
  });
});
