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
  }));

  if (config?.watch !== false) {
    const watcher = new DocWatcher({
      listPanes: () => ctx.tmux.listPanePaths(),
      roots,
      emit: (event) => ctx.emit('status/event', event),
    });
    ctx.effect(() => () => watcher.dispose(), 'agent-docs.watcher');
    ctx.interval(() => {
      watcher.tick().catch((error) => ctx.logger.debug('document scan failed: %s', error.message));
    }, config?.scanMs ?? SCAN_MS);
  }

  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
