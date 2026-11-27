import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen, request } from './api-helpers.js';
import {
  inspectLiveTmuxAttribution,
  openPrivacySettings,
  parseCodesignOutput,
  probeFullDiskAccess,
  probeTmuxFullDiskAccess,
} from '../../lib/macos-permissions/probe.js';
import {
  isAnymuxAttributedPrompt,
  parseTccPromptEvent,
  TccPromptStore,
} from '../../lib/macos-permissions/tcc-prompt-watch.js';
import { createMacosPermissionsRouter } from '../../plugins/macos-permissions/index.js';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('macOS permissions probe and attribution', () => {
  it('probes Full Disk Access silently via TCC.db open/read', async () => {
    expect(await probeFullDiskAccess({ platform: 'linux' })).toBe('unsupported');
    expect(await probeFullDiskAccess({ platform: 'darwin', homeDir: '/Users/test', openFile: async () => {} })).toBe('granted');
    expect(await probeFullDiskAccess({
      platform: 'darwin',
      homeDir: '/Users/test',
      openFile: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    })).toBe('denied');
    expect(await probeFullDiskAccess({
      platform: 'darwin',
      homeDir: '/Users/test',
      openFile: async () => { throw Object.assign(new Error('eacces'), { code: 'EACCES' }); },
    })).toBe('denied');
    expect(await probeFullDiskAccess({
      platform: 'darwin',
      homeDir: '/Users/test',
      openFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    })).toBe('unknown');
  });

  it('probes tmux Full Disk Access inside the running tmux server', async () => {
    expect(await probeTmuxFullDiskAccess({ platform: 'linux' })).toBe('unsupported');
    expect(await probeTmuxFullDiskAccess({
      platform: 'darwin',
      tmuxRun: async () => { throw new Error('no server running'); },
    })).toBe('not_running');
    expect(await probeTmuxFullDiskAccess({
      platform: 'darwin',
      tmuxRun: async (args) => (args[0] === 'display-message' ? '18130\n' : 'denied\n'),
    })).toBe('denied');
    expect(await probeTmuxFullDiskAccess({
      platform: 'darwin',
      tmuxRun: async (args) => (args[0] === 'display-message' ? '18130\n' : 'granted\n'),
    })).toBe('granted');
  });

  it('parses codesign output for ad-hoc vs signed bundles', () => {
    const adhoc = parseCodesignOutput(
      'Identifier=.tmux.new.4717\nSignature=adhoc\nTeamIdentifier=not set\n',
      '',
    );
    expect(adhoc).toEqual({
      identifier: '.tmux.new.4717',
      adhoc: true,
      authority: null,
      teamIdentifier: null,
      designatedRequirement: null,
    });

    const signed = parseCodesignOutput(
      'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\nTeamIdentifier=not set\n',
      'designated => identifier "com.anymux.app" and certificate leaf = H"abcd"\n',
    );
    expect(signed).toEqual({
      identifier: 'com.anymux.app',
      adhoc: false,
      authority: 'HaoDouDou Dev',
      teamIdentifier: null,
      designatedRequirement: 'identifier "com.anymux.app" and certificate leaf = H"abcd"',
    });
  });

  it('detects unified, restart_required, legacy_adhoc, and not_running tmux attribution states', async () => {
    const appPath = '/Applications/Anymux.app';
    const helperExec = '/Users/me/.local/share/anymux/Helpers/Anymux Tmux.app/Contents/MacOS/Anymux Tmux';
    const legacyBin = '/Users/me/.local/share/anymux/bin/tmux';
    const req = 'designated => identifier "com.anymux.app" and certificate leaf = H"ae0dae"\n';

    const makeExec = (livePath, liveCodesign, installedCodesign = {
      dvv: 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n',
      req,
    }) => async (cmd, args) => {
      if (cmd === '/bin/ps') return { stdout: `${livePath}\n`, stderr: '' };
      if (cmd === '/usr/bin/codesign') {
        const target = args.at(-1);
        const isDvv = args[0] === '-dvv';
        if (target === appPath) {
          return { stdout: '', stderr: isDvv ? 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n' : req };
        }
        if (target === helperExec || target === legacyBin) {
          if (target === livePath) return { stdout: '', stderr: isDvv ? liveCodesign.dvv : liveCodesign.req };
          return { stdout: '', stderr: isDvv ? installedCodesign.dvv : installedCodesign.req };
        }
      }
      throw new Error(`Unexpected exec: ${cmd} ${args.join(' ')}`);
    };

    const exists = (p) => [appPath, helperExec, legacyBin].includes(p);
    const resolveRealpath = async (p) => (p === legacyBin ? helperExec : p);

    const unified = await inspectLiveTmuxAttribution({
      platform: 'darwin',
      tmuxBin: helperExec,
      appCandidates: [appPath],
      tmuxRun: async () => '100:1700000100\n',
      statFile: async () => ({ mtimeMs: 1700000000 * 1000 }),
      execFile: makeExec(helperExec, { dvv: 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n', req }),
      resolveRealpath,
      exists,
    });
    expect(unified.state).toBe('unified');

    // Legacy process launched at legacyBin before legacyBin became a symlink to helperExec.
    const symlinkReplaced = await inspectLiveTmuxAttribution({
      platform: 'darwin',
      tmuxBin: helperExec,
      appCandidates: [appPath],
      tmuxRun: async () => '18130:1700000000\n',
      statFile: async () => ({ mtimeMs: 1700000500 * 1000 }),
      execFile: makeExec(legacyBin, { dvv: 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n', req }),
      resolveRealpath,
      exists,
    });
    expect(symlinkReplaced.state).toBe('restart_required');

    // Bundle binary replaced on disk after the running process started.
    const binaryRebuiltWhileRunning = await inspectLiveTmuxAttribution({
      platform: 'darwin',
      tmuxBin: helperExec,
      appCandidates: [appPath],
      tmuxRun: async () => '18130:1700000000\n',
      statFile: async () => ({ mtimeMs: 1700000500 * 1000 }),
      execFile: makeExec(helperExec, { dvv: 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n', req }),
      resolveRealpath,
      exists,
    });
    expect(binaryRebuiltWhileRunning.state).toBe('restart_required');

    const restartRequired = await inspectLiveTmuxAttribution({
      platform: 'darwin',
      tmuxBin: helperExec,
      appCandidates: [appPath],
      tmuxRun: async () => '18130:1700000000\n',
      statFile: async () => ({ mtimeMs: 1700000500 * 1000 }),
      execFile: makeExec(legacyBin, { dvv: 'Identifier=.tmux.new.4717\nSignature=adhoc\n', req: '' }),
      resolveRealpath: async (p) => p,
      exists,
    });
    expect(restartRequired.state).toBe('restart_required');
    expect(restartRequired.livePid).toBe(18130);

    const legacyAdhoc = await inspectLiveTmuxAttribution({
      platform: 'darwin',
      tmuxBin: legacyBin,
      appCandidates: [appPath],
      tmuxRun: async () => '18130\n',
      execFile: makeExec(
        legacyBin,
        { dvv: 'Identifier=.tmux.new.4717\nSignature=adhoc\n', req: '' },
        { dvv: 'Identifier=.tmux.new.4717\nSignature=adhoc\n', req: '' },
      ),
      resolveRealpath: async (p) => p,
      exists: (p) => p === appPath || p === legacyBin,
    });
    expect(legacyAdhoc.state).toBe('legacy_adhoc');

    const notRunning = await inspectLiveTmuxAttribution({
      platform: 'darwin',
      tmuxBin: helperExec,
      appCandidates: [appPath],
      tmuxRun: async () => { throw new Error('no server'); },
      execFile: makeExec(helperExec, { dvv: 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n', req }),
      resolveRealpath,
      exists,
    });
    expect(notRunning.state).toBe('not_running');
    expect(notRunning.installedReady).toBe(true);
  });

  it('rejects non-whitelisted privacy settings panes', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(openPrivacySettings('arbitrary-pane', { platform: 'darwin', execFile })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await openPrivacySettings('full-disk-access', { platform: 'darwin', execFile });
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'],
      { timeout: 5000 },
    );
  });
});

describe('TCC prompt watcher & store', () => {
  it('parses real tccd AUTHREQ_PROMPTING lines and attributes Anymux/tmux prompts', () => {
    const tmuxLine = '2026-11-27 18:43:31.801 Df tccd[81835:13d3ec5f] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=13511.448, service=kTCCServiceSystemPolicyDesktopFolder, subject=Sub:{/Users/massachusetts/.local/share/anymux/bin/tmux}Resp:{TCCDProcess: identifier=.tmux.new.4717, pid=18130, auid=501, euid=501, responsible_path=/Users/massachusetts/.local/share/anymux/bin/tmux, binary_path=/Users/massachusetts/.local/share/anymux/bin/tmux},';
    const appLine = '2026-11-27 17:24:51.542 Df tccd[81835:13c55b54] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=88520.23, service=kTCCServiceSystemPolicyDownloadsFolder, subject=Sub:{com.anymux.app}Resp:{TCCDProcess: identifier=com.anymux.app, pid=44377, auid=501, euid=501, binary_path=/Users/massachusetts/projects/tmux-web-panel/dist/macos/Anymux.app/Contents/MacOS/Anymux},';
    const unrelatedLine = '2026-11-27 18:43:31.801 Df tccd[81835:1] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=1.1, service=kTCCServiceSystemPolicyDesktopFolder, subject=Sub:{com.apple.Terminal}Resp:{TCCDProcess: identifier=com.apple.Terminal, pid=999},';

    const tmuxEvt = parseTccPromptEvent(tmuxLine);
    expect(tmuxEvt?.service).toBe('kTCCServiceSystemPolicyDesktopFolder');
    expect(isAnymuxAttributedPrompt(tmuxEvt)).toBe(true);

    const appEvt = parseTccPromptEvent(appLine);
    expect(isAnymuxAttributedPrompt(appEvt)).toBe(true);

    const otherEvt = parseTccPromptEvent(unrelatedLine);
    expect(isAnymuxAttributedPrompt(otherEvt)).toBe(false);
  });

  it('persists prompt count and dismiss state atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anymux-tcc-store-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = TccPromptStore.forConfigDir(dir);
    await store.load();
    expect(store.snapshot().promptCount).toBe(0);

    await store.recordPrompt({ service: 'kTCCServiceSystemPolicyDesktopFolder', responsibleIdentifier: 'com.anymux.app' }, 1000);
    await store.dismiss(2000);

    const reloaded = TccPromptStore.forConfigDir(dir);
    const snap = await reloaded.load();
    expect(snap).toEqual({
      promptCount: 1,
      lastService: 'kTCCServiceSystemPolicyDesktopFolder',
      lastResponsible: 'com.anymux.app',
      lastAt: 1000,
      dismissed: true,
      acknowledgedAt: 2000,
    });
  });

  it('serves status, open-settings, and dismiss-nudge endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anymux-perm-router-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = TccPromptStore.forConfigDir(dir);
    await store.recordPrompt({ service: 'kTCCServiceSystemPolicyDownloadsFolder', responsibleIdentifier: '.tmux.new.4717' }, 5000);

    const openSettings = vi.fn(async (id) => ({ opened: true, id }));
    const onDismiss = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/api/macos-permissions', createMacosPermissionsRouter({
      platform: 'darwin',
      store,
      onDismiss,
      probeFda: async () => 'denied',
      probeTmuxFda: async () => 'denied',
      inspectAttribution: async () => ({ supported: true, state: 'restart_required', livePid: 18130 }),
      openSettings,
    }));

    const { server, port } = await listen(app);
    cleanups.push(() => new Promise((done) => server.close(done)));

    const status = await request(port, 'GET', '/api/macos-permissions/status');
    expect(status.status).toBe(200);
    expect(status.body.data.supported).toBe(true);
    expect(status.body.data.attribution.state).toBe('restart_required');
    expect(status.body.data.tccPrompt.nudgePending).toBe(true);

    const opened = await request(port, 'POST', '/api/macos-permissions/open-settings', { id: 'full-disk-access' });
    expect(opened.status).toBe(200);
    expect(openSettings).toHaveBeenCalledWith('full-disk-access', { platform: 'darwin' });

    const dismissed = await request(port, 'POST', '/api/macos-permissions/dismiss-nudge', {});
    expect(dismissed.status).toBe(200);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const after = await request(port, 'GET', '/api/macos-permissions/status');
    expect(after.body.data.tccPrompt.nudgePending).toBe(false);
  });
});
