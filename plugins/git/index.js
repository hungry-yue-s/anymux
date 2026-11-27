// Git: the Git block beside the terminal, the git status chip in the top bar
// and the Git command (client/), and /api/git for them (lib/api/git.js):
// status, diffs, history, staging and commits of the repository a path
// belongs to, within the file roots (root CLAUDE.md, 文件预览分窗契约).

import { createGitRouter } from '../../lib/api/git.js';
import { PaneRepoTracker } from '../../lib/git/repo-discovery.js';
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
    onChange: (paneId, repoRoot) => schedulePaneNotify(paneId, repoRoot),
  });

  ctx.on('agent-events/raw', ({ event, raw }) => {
    paneRepoTracker.ingestAgentEvent(raw, event).catch(() => {});
  });
  ctx.on('status/tmux-restarted', () => {
    for (const timer of pendingNotify.values()) clearTimeout(timer);
    pendingNotify.clear();
    lastNotifiedAt.clear();
    paneRepoTracker.clear();
  });

  const router = createGitRouter({
    pathGuard: ctx.fileAccess.pathGuard,
    tmux: ctx.tmux,
    paneRepoTracker,
    roots: ctx.fileAccess.roots,
    resolveSource: (source) => resolvePreviewSource(ctx, source),
    broadcast: (event) => ctx.emit('status/event', event),
  });
  invalidateGitSummary = router.invalidateSummary;

  ctx.http.mount('/api/git', router);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
