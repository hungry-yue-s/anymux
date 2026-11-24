import { AutomationsService } from '../../lib/automations/service.js';
import { createAutomationsRouter } from '../../lib/api/automations.js';

export const name = 'automations';

export const inject = ['launch', 'http', 'tmux', 'workspace'];

export function apply(ctx) {
  let notificationStore = null;
  ctx.inject(['notifications'], (ctx) => {
    notificationStore = ctx.notifications;
    ctx.effect(() => () => { notificationStore = null; }, 'automations.notices');
  });

  const service = new AutomationsService({
    configDir: ctx.launch.configDir,
    tmux: ctx.tmux,
    workspace: ctx.workspace,
    onNotify: (notice) => {
      if (notificationStore?.add) {
        const added = notificationStore.add(notice);
        if (added) ctx.emit('status/notifications', [added]);
      } else {
        ctx.emit('status/notifications', [notice]);
      }
    },
  });

  ctx.http.mount('/api/automations', createAutomationsRouter(service));
  ctx.effect(() => {
    service.start().catch(() => {});
    return () => service.dispose();
  }, 'automations.scheduler');
  ctx.provide('automations', service);
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
