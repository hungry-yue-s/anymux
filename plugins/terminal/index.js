// `ctx.terminals`: browser terminals attached to tmux panes (lib/terminal.js,
// lib/terminal/gateway.js). Every Windows contract in the root CLAUDE.md —
// one client change at a time, held input, the console reaper, taking over
// without waiting for onExit — lives in TerminalManager unchanged.
//
// /ws/terminal/:paneId: the gateway resolves the pane through the workspace
// before anything attaches, and never throws; a bad address closes only that
// socket.

import { diagnostics } from '../../lib/diagnostics.js';
import { TerminalManager } from '../../lib/terminal.js';
import { TerminalGateway } from '../../lib/terminal/gateway.js';
import { hyperlinkClientArgs } from '../../lib/terminal/hyperlinks.js';

export const name = 'terminal';

export const inject = ['launch', 'http', 'workspace', 'tmux'];

export function apply(ctx) {
  const manager = new TerminalManager({ maxConnectionsPerPane: ctx.launch.maxConnections });
  const gateway = new TerminalGateway({ workspace: ctx.workspace, terminalManager: manager });
  // Hyperlinks reach the page only through clients that declare them, and only
  // a tmux known to take the option gets it: until the version is read, and
  // with a tmux too old, clients start as they always did.
  Promise.resolve().then(() => ctx.tmux.version())
    .then((version) => manager.setClientFeatures(hyperlinkClientArgs(version)))
    .catch(() => {});

  ctx.http.websocket('/ws/terminal/*', ({ ws, url }) => {
    diagnostics.record('terminal', { serverId: 'local', phase: 'upgraded', compressed: ws.extensions.includes('permessage-deflate') });
    gateway.handle(ws, url.pathname, url.searchParams).catch(() => {
      try {
        ws.close(1011, 'terminal setup failed');
      } catch {
        // Socket already gone.
      }
    });
  });

  ctx.effect(() => {
    manager.startReaper();
    return () => {
      manager.stopReaper();
      manager.destroyAll();
    };
  }, 'terminal.manager');

  ctx.provide('terminals', manager);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
