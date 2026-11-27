import { join } from 'node:path';
import { createSessionVaultRouter } from '../../lib/api/session-vault.js';
import { openSessionVaultDb } from '../../lib/session-vault/db.js';

export const name = 'session-vault';

export const inject = ['http', 'launch'];

export function apply(ctx) {
  let vaultDb = null;
  ctx.effect(() => {
    vaultDb = openSessionVaultDb(join(ctx.launch.configDir, 'session-vault.sqlite'));
    return () => {
      vaultDb?.close();
      vaultDb = null;
    };
  }, 'session-vault.db');

  ctx.http.mount('/api/session-vault', createSessionVaultRouter({
    getVaultDb: () => vaultDb,
  }));
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
