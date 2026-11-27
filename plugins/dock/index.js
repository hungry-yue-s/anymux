// `ctx.dock`: server-side persistence for right-docked files, tool blocks,
// and preview notices (`lib/dock/store.js`), exposed at `/api/dock`.

import { join } from 'node:path';
import { DockStore } from '../../lib/dock/store.js';
import { createDockRouter } from '../../lib/api/dock.js';

export const name = 'dock';

export const inject = ['launch', 'http', 'tmux'];

export async function apply(ctx) {
  const store = new DockStore(join(ctx.launch.configDir, 'dock-state.json'));
  await store.load();

  let workspaceService = null;
  ctx.inject(['workspace'], (innerCtx) => {
    workspaceService = innerCtx.workspace;
    innerCtx.effect(() => () => {
      if (workspaceService === innerCtx.workspace) workspaceService = null;
    }, 'dock.workspace');
  });

  ctx.tmux.getServerInstance()
    .then((instanceId) => (instanceId ? store.setServerInstance(instanceId) : null))
    .catch(() => {});

  const emitChanged = (payload) => ctx.emit('status/event', payload);

  ctx.on('status/tmux-instance', (instanceId) => {
    if (instanceId) store.setServerInstance(instanceId).catch(() => {});
  });

  ctx.on('status/tmux-restarted', (info) => {
    if (info?.nextInstance) store.setServerInstance(info.nextInstance).catch(() => {});
  });

  ctx.on('workspace/window-closed', ({ windowId } = {}) => {
    if (!windowId) return;
    store.forgetWindow(windowId).then((res) => {
      if (res?.changed) emitChanged({ type: 'dock-changed', scope: 'window', windowId, instanceId: store.getSnapshot().instanceId, revision: res.revision, window: null });
    }).catch(() => {});
  });

  ctx.on('workspace/session-closed', ({ windowIds } = {}) => {
    if (!Array.isArray(windowIds) || !windowIds.length) return;
    store.forgetSessionWindows(windowIds).then((res) => {
      if (res?.changed) emitChanged({ type: 'dock-changed', scope: 'all', instanceId: store.getSnapshot().instanceId, revision: res.revision });
    }).catch(() => {});
  });

  ctx.on('session-protection/restored', ({ instanceId, mappings } = {}) => {
    if (!instanceId || !Array.isArray(mappings) || !mappings.length) return;
    store.migrateRestoredWindows(instanceId, mappings).then((res) => {
      if (res && (res.migratedWindows > 0 || res.migratedNotices > 0)) {
        emitChanged({ type: 'dock-changed', scope: 'all', instanceId, revision: res.revision });
      }
    }).catch(() => {});
  });

  ctx.http.mount('/api/dock', createDockRouter({
    store,
    getWorkspace: () => workspaceService,
    tmux: ctx.tmux,
    onChange: emitChanged,
  }));

  ctx.provide('dock', store);
  ctx.inject(['ui'], (innerCtx) => innerCtx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
