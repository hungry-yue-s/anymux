// Git: the Git block beside the terminal, the git status chip in the top bar
// and the Git command (client/), and /api/git for them (lib/api/git.js):
// status, diffs, history, staging and commits of the repository a path
// belongs to, within the file roots (root CLAUDE.md, 文件预览分窗契约).

import { join } from 'node:path';
import { createGitRouter } from '../../lib/api/git.js';
import { PaneRepoTracker } from '../../lib/git/repo-discovery.js';
import { appDir } from '../../lib/legacy-names.js';
import { resolvePreviewSource } from '../../lib/preview-source.js';

export const name = 'git';

export const inject = ['http', 'fileAccess', 'workspace', 'tmux'];

export function apply(ctx) {
  const pendingNotify = new Map();
  const lastNotifiedAt = new Map();
  let invalidateGitSummary = null;

  const emitPaneGitChanged = (paneId) => {
    if (!paneId) return;
    lastNotifiedAt.set(paneId, Date.now());
    ctx.emit('status/event', { type: 'pane-git-changed', paneId });
  };

  const schedulePaneNotify = (paneId, repoRoot) => {
    if (!paneId) return;
    if (invalidateGitSummary && repoRoot) invalidateGitSummary(repoRoot);
    const now = Date.now();
    const last = lastNotifiedAt.get(paneId) || 0;
    const elapsed = now - last;
    if (elapsed >= 1500 && !pendingNotify.has(paneId)) {
      emitPaneGitChanged(paneId);
      return;
    }
    if (pendingNotify.has(paneId)) return;
    const timer = setTimeout(() => {
      pendingNotify.delete(paneId);
      emitPaneGitChanged(paneId);
    }, Math.max(50, 1500 - elapsed));
    timer.unref?.();
    pendingNotify.set(paneId, timer);
  };

  const paneRepoTracker = new PaneRepoTracker({
    pathGuard: ctx.fileAccess.pathGuard,
    roots: ctx.fileAccess.roots,
    storagePath: join(appDir('config'), 'pane-repos.json'),
    onChange: (paneId, repoRoot) => schedulePaneNotify(paneId, repoRoot),
  });

  const initReady = Promise.resolve(ctx.tmux?.getServerInstance?.())
    .then((instance) => paneRepoTracker.loadPersisted(instance || ''))
    .catch(() => false);
  paneRepoTracker.setReadyPromise(initReady);

  ctx.on('agent-events/raw', ({ event, raw }) => {
    paneRepoTracker.ingestAgentEvent(raw, event).catch(() => {});
  });
  ctx.on('status/tmux-restarted', () => {
    for (const timer of pendingNotify.values()) clearTimeout(timer);
    pendingNotify.clear();
    lastNotifiedAt.clear();
    paneRepoTracker.clear();
    const nextReady = Promise.resolve(ctx.tmux?.getServerInstance?.())
      .then((instance) => paneRepoTracker.setServerInstance(instance || ''))
      .catch(() => {});
    paneRepoTracker.setReadyPromise(nextReady);
  });

  ctx.effect(() => () => {
    for (const timer of pendingNotify.values()) clearTimeout(timer);
    pendingNotify.clear();
    paneRepoTracker.dispose();
  }, 'git.paneRepoTracker');

  let dockStore = null;
  ctx.inject(['dock'], (innerCtx) => {
    dockStore = innerCtx.dock;
    innerCtx.effect(() => () => {
      if (dockStore === innerCtx.dock) dockStore = null;
    }, 'git.dock');
  });

  const recordGitArrival = async (arrival) => {
    if (!dockStore || !arrival?.windowId || !arrival?.instanceId) return null;
    let windowMeta = {};
    const ws = await ctx.workspace.getWorkspace().catch(() => null);
    for (const session of ws?.sessions || []) {
      const win = (session.windows || []).find((w) => w.id === arrival.windowId);
      if (win) {
        windowMeta = {
          sessionId: session.id || '',
          sessionName: session.name || '',
          windowIndex: win.index ?? null,
          windowName: win.name || '',
        };
        break;
      }
    }
    return dockStore.recordGitArrival({ ...windowMeta, ...arrival });
  };

  const router = createGitRouter({
    pathGuard: ctx.fileAccess.pathGuard,
    tmux: ctx.tmux,
    paneRepoTracker,
    roots: ctx.fileAccess.roots,
    resolveSource: (source) => resolvePreviewSource(ctx, source),
    recordGitArrival,
    broadcast: (event) => ctx.emit('status/event', event),
  });
  invalidateGitSummary = router.invalidateSummary;

  ctx.http.mount('/api/git', router);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
