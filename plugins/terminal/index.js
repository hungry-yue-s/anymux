// `ctx.terminals`: frozen legacy fallback terminals attached to tmux panes
// (lib/terminal.js, lib/terminal/gateway.js). Primary multi-pane rendering runs
// on /ws/window-stream/:windowId (`plugins/control-terminal/` + Seam workbench).
// Every Windows contract in root CLAUDE.md lives in TerminalManager unchanged.
//
// /ws/terminal/:paneId: retained for basic-mode SSH and linked-window fallback;
// set ANYMUX_DISABLE_LEGACY_TERMINAL=1 to retire ConPTY attach on a node.

import { diagnostics } from '../../lib/diagnostics.js';
import { TerminalManager } from '../../lib/terminal.js';
import { TerminalGateway } from '../../lib/terminal/gateway.js';
import { hyperlinkClientArgs } from '../../lib/terminal/hyperlinks.js';

export const name = 'terminal';

export const inject = ['launch', 'http', 'workspace', 'tmux'];

export function apply(ctx, config = {}) {
  const disableLegacy = config?.disableLegacyTerminal === true || process.env.ANYMUX_DISABLE_LEGACY_TERMINAL === '1';
  const manager = new TerminalManager({ maxConnectionsPerPane: ctx.launch.maxConnections });
  const gateway = new TerminalGateway({ workspace: ctx.workspace, terminalManager: manager, disableLegacyTerminal: disableLegacy });
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
  ctx.inject(['node'], (nodeCtx) => {
    nodeCtx.effect(() => nodeCtx.node.setCapability('legacyTerminal', () => ({
      available: !disableLegacy,
      deprecated: true,
      primary: 'window-stream',
    })), 'terminal.legacy-capability');
  });
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
