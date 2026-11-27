// `anymux open <path>` from a pane (/api/open, lib/api/open.js): the open pages
// show that file, announced over the status socket (status/event).

import { createOpenRouter } from '../../lib/api/open.js';
import { resolvePreviewSource } from '../../lib/preview-source.js';

export const name = 'open';

export const inject = ['http', 'fileAccess', 'workspace', 'tmux'];

export function apply(ctx) {
  let dockStore = null;
  ctx.inject(['dock'], (innerCtx) => {
    dockStore = innerCtx.dock;
    innerCtx.effect(() => () => {
      if (dockStore === innerCtx.dock) dockStore = null;
    }, 'open.dock');
  });

  const recordDockArrival = async (arrival) => {
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
    return dockStore.recordFileArrival({ ...windowMeta, ...arrival });
  };

  ctx.http.mount('/api/open', createOpenRouter({
    pathGuard: ctx.fileAccess.pathGuard,
    broadcast: (event) => ctx.emit('status/event', event),
    resolveSource: (source) => resolvePreviewSource(ctx, source),
    recordDockArrival,
  }));
}
