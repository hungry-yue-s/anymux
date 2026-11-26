#!/usr/bin/env node

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentHookManager,
  EVENT_SPECS,
  HOOK_AGENTS,
} from '../lib/agent-hooks.js';
import { appDir } from '../lib/legacy-names.js';

const __filename = fileURLToPath(import.meta.url);

export { AgentHookManager, EVENT_SPECS, HOOK_AGENTS };

function usage() {
  const names = [...Object.keys(HOOK_AGENTS), 'all'].join('|');
  console.log(`Usage: node scripts/install-agent-hooks.js [${names}] [--uninstall]`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const uninstall = args.includes('--uninstall') || args.includes('--remove');
  const target = args.find((arg) => !arg.startsWith('--')) || 'all';
  if (target !== 'all' && !Object.hasOwn(HOOK_AGENTS, target)) {
    usage();
    process.exit(1);
  }

  const userHome = homedir();
  const manager = new AgentHookManager({
    userHome,
    dataDir: appDir('data', { home: userHome }),
    configDir: process.env.ANYMUX_CONFIG_DIR || appDir('config', { home: userHome }),
  });

  const results = uninstall ? await manager.uninstall(target) : await manager.install(target);
  console.log(JSON.stringify({ ok: true, uninstall, results }, null, 2));
  console.log('No bearer token was written to agent configuration. The router reads local tokens dynamically.');
}
