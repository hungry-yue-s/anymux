import { createSessionVaultRouter } from '../../lib/api/session-vault.js';

export const name = 'session-vault';

export const inject = ['http'];

export function apply(ctx) {
  ctx.http.mount('/api/session-vault', createSessionVaultRouter());
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
