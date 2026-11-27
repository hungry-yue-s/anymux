// Documents agents write for the side panel (docs/agent-docs.md).
//
// /api/agent-docs (lib/api/agent-docs.js): where `anymux doc path` puts a
// draft, what kind a document is, and typing a reply into the agent's pane.
// The watcher (lib/agent-docs/watcher.js) finds new documents in the projects
// the panes are in, from any agent, and announces them over the status socket
// like `anymux open --dock` (status/event). The page side is the bar above
// such a document (client/), and docking itself (files-commands.js).

import { createAgentDocsRouter } from '../../lib/api/agent-docs.js';
import { DocWatcher } from '../../lib/agent-docs/watcher.js';

export const name = 'agent-docs';

export const inject = ['http', 'fileAccess', 'tmux', 'timer'];

const SCAN_MS = 2000;

/** @param {{ watch?: boolean, scanMs?: number }} [config] */
export function apply(ctx, config) {
  const { pathGuard, roots } = ctx.fileAccess;
  ctx.http.mount('/api/agent-docs', createAgentDocsRouter({
    pathGuard,
    roots,
    typeText: (paneId, text) => ctx.tmux.typeText(paneId, text),
    prefillText: (paneId, text) => ctx.tmux.prefillText(paneId, text),
    getServerInstance: () => ctx.tmux.getServerInstance(),
  }));

  let dockStore = null;
  let workspaceService = null;
  ctx.inject(['dock'], (innerCtx) => {
    dockStore = innerCtx.dock;
    innerCtx.effect(() => () => {
      if (dockStore === innerCtx.dock) dockStore = null;
    }, 'agent-docs.dock');
  });
  ctx.inject(['workspace'], (innerCtx) => {
    workspaceService = innerCtx.workspace;
    innerCtx.effect(() => () => {
      if (workspaceService === innerCtx.workspace) workspaceService = null;
    }, 'agent-docs.workspace');
  });

  const emitDocEvent = async (event) => {
    try {
      if (dockStore && workspaceService && event?.type === 'open-file' && event.placement === 'dock') {
        const paneIds = Array.isArray(event.paneIds) && event.paneIds.length ? event.paneIds : (event.paneId ? [event.paneId] : []);
        const ws = await workspaceService.getWorkspace().catch(() => null);
        if (ws && ws.complete !== false && ws.instanceId && paneIds.length) {
          const matches = [];
          for (const session of ws.sessions || []) {
            for (const win of session.windows || []) {
              if ((win.panes || []).some((pane) => paneIds.includes(pane.id))) {
                matches.push({ session, win });
              }
            }
          }
          if (matches.length === 1) {
            const { session, win } = matches[0];
            const recorded = await dockStore.recordFileArrival({
              path: event.path,
              paneId: paneIds.length === 1 ? paneIds[0] : null,
              windowId: win.id,
              instanceId: ws.instanceId,
              sessionId: session.id || '',
              sessionName: session.name || '',
              windowIndex: win.index ?? null,
              windowName: win.name || '',
              activate: event.activate !== false,
              automatic: true,
              kind: event.kind || null,
            }).catch(() => null);
            if (recorded) {
              ctx.emit('status/event', {
                ...event,
                instanceId: ws.instanceId,
                windowId: win.id,
                dockRevision: recorded.revision,
                noticeId: recorded.notice?.id || null,
                serverPersisted: true,
              });
              return;
            }
          }
        }
      }
    } catch { /* fall back to broadcast only */ }
    ctx.emit('status/event', event);
  };

  if (config?.watch !== false) {
    const watcher = new DocWatcher({
      listPanes: () => ctx.tmux.listPanePaths(),
      roots,
      emit: (event) => { emitDocEvent(event); },
    });
    ctx.effect(() => () => watcher.dispose(), 'agent-docs.watcher');
    ctx.interval(() => {
      watcher.tick().catch((error) => ctx.logger.debug('document scan failed: %s', error.message));
    }, config?.scanMs ?? SCAN_MS);
  }

  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
