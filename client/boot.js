// The browser runs the same kernel as the server. Boot only creates the root
// context; every service is a plugin named by the server's manifest. It runs
// beside the page's own scripts and never touches their DOM: a failure here
// is logged, not shown.

import { Context, Logger } from 'cordis';
import Timer from '@cordisjs/plugin-timer';

const ctx = new Context();

ctx.logger.exporter({
  colors: 0,
  export(message) {
    const text = `[${message.name}] ${Logger.format(this, message)}`;
    if (message.type === 'error') console.error(text);
    else if (message.type === 'warn') console.warn(text);
    else console.log(text);
  },
});

ctx.plugin(Timer);

// For the browser console: anymux.registry, anymux.get('api'), …
globalThis.anymux = ctx;

async function start() {
  const inline = globalThis.__ANYMUX_CLIENT_MANIFEST__;
  let manifest = inline && Array.isArray(inline.entries) ? inline : null;
  if (!manifest) {
    const response = await fetch('/client/manifest.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  }
  const loaded = await Promise.all(manifest.entries.map(async (entry) => {
    try {
      return { entry, mod: await import(entry.url), error: null };
    } catch (error) {
      return { entry, mod: null, error };
    }
  }));
  for (const { entry, mod, error } of loaded) {
    if (error) ctx.logger('boot').error('cannot load %s: %s', entry.url, error?.message ?? error);
    else ctx.plugin(mod.default ?? mod, entry.config ?? undefined);
  }
}

start().catch((error) => {
  ctx.logger('boot').error('client plugins did not start: %s', error?.message ?? error);
});
