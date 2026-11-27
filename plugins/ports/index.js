import express from 'express';
import { handle } from '../../lib/servers/errors.js';
import { listListeningPorts } from '../../lib/ports/listeners.js';
import { buildProcessTree, filterPortsForPid, getDescendantPids } from '../../lib/ports.js';
import { extractAdvertisedUrls } from '../../lib/ports/advertised-urls.js';

export const name = 'ports';

export const inject = ['http', 'workspace'];

export function apply(ctx) {
  const router = express.Router();

  router.get('/', handle(async () => {
    const listeners = await listListeningPorts();
    const tree = await ctx.workspace.getWorkspace?.().catch(() => null);
    const procTree = await buildProcessTree();
    const byPane = {};
    for (const session of tree?.sessions || []) {
      for (const win of session.windows || []) {
        for (const pane of win.panes || []) {
          const pid = Number(pane.pid);
          if (!Number.isFinite(pid) || pid <= 0) continue;
          const desc = getDescendantPids(pid, procTree);
          const ports = filterPortsForPid(listeners, pid, desc);
          if (ports.length) {
            byPane[pane.id] = {
              sessionId: session.id,
              sessionName: session.name,
              windowId: win.id,
              windowName: win.name,
              command: pane.command || '',
              ports,
            };
          }
        }
      }
    }
    return { listeners, byPane };
  }));

  router.post('/extract-urls', handle(async (req) => ({
    urls: extractAdvertisedUrls(String(req.body?.text || '')),
  })));

  ctx.http.mount('/api/ports', router);
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
