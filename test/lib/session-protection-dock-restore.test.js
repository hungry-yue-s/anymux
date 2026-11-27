import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnapshot } from '../../lib/session-protection/snapshot.js';
import { restoreSession } from '../../lib/session-protection/restore.js';
import { SessionProtection } from '../../lib/session-protection/service.js';
import { DockStore } from '../../lib/dock/store.js';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeTemp(prefix = 'anymux-dock-restore-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('SessionProtection + DockStore restart migration', () => {
  it('records window_meta in snapshots, parses origWindowId, and returns window mappings from restoreSession', async () => {
    const text = [
      'pane\twork\t1\t1\t:*\t0\tzsh\t:/repo\t1\tzsh\t:zsh',
      'window\twork\t1\t:dev\t1\t:*\tlay\t:',
      'window_meta\twork\t1\t@7',
      'state\twork\twork',
    ].join('\n');

    const parsed = parseSnapshot(text);
    expect(parsed.sessions[0].windows[0].origWindowId).toBe('@7');

    let nextWin = 20;
    let nextPane = 30;
    const tmux = async (args) => {
      if (args[0] === 'new-session') return `$5\t@${nextWin++}\t%${nextPane++}\n`;
      if (args[0] === 'new-window') return `@${nextWin++}\t%${nextPane++}\n`;
      return '';
    };

    const restored = await restoreSession(tmux, parsed.sessions[0], {
      name: 'work',
      programs: [],
      defaultShell: 'zsh',
      includeWindows: true,
    });
    expect(restored.windows).toEqual([
      {
        sessionName: 'work',
        restoredSessionName: 'work',
        windowIndex: 1,
        windowName: 'dev',
        origWindowId: '@7',
        newWindowId: '@20',
      },
    ]);
  });

  it('migrates archived dock tabs, Git blocks, and notices to restored windows after tmux restart', async () => {
    const dir = makeTemp();
    const snapDir = join(dir, 'resurrect');
    const store = new DockStore(join(dir, 'dock-state.json'));
    await store.load();
    await store.setServerInstance('100:1700000000');

    await store.recordFileArrival({
      path: '/repo/docs/spec.md',
      paneId: '%5',
      windowId: '@7',
      instanceId: '100:1700000000',
      sessionName: 'work',
      windowIndex: 1,
      windowName: 'dev',
      activate: true,
    });
    await store.recordGitArrival({
      path: '/repo',
      commit: '1234abcd',
      paneId: '%5',
      windowId: '@7',
      instanceId: '100:1700000000',
      sessionName: 'work',
      windowIndex: 1,
      windowName: 'dev',
      activate: true,
    });

    // Save snapshot with window_meta via _appendWindowMeta
    const snapFile = join(dir, 'tmux_resurrect_20261127T170000.txt');
    writeFileSync(snapFile, [
      'pane\twork\t1\t1\t:*\t0\tzsh\t:/repo\t1\tzsh\t:zsh',
      'window\twork\t1\t:dev\t1\t:*\tlay\t:',
      'state\twork\twork',
    ].join('\n') + '\n');
    symlinkSync('tmux_resurrect_20261127T170000.txt', join(dir, 'last'));

    let nextWin = 20;
    let nextPane = 30;
    let mode = 'before-restart';
    const svc = new SessionProtection({
      configDir: dir,
      projectDir: dir,
      getServerInstance: async () => (mode === 'before-restart' ? '100:1700000000' : '200:1700000500'),
      onRestored: ({ instanceId, mappings }) => store.migrateRestoredWindows(instanceId, mappings),
      exec: async (_bin, args) => {
        const joined = args.join(' ');
        if (args[0] === 'list-windows' && joined.includes('#{window_id}')) {
          return { stdout: 'work\t1\t@7\n', stderr: '' };
        }
        if (args[0] === 'display-message') {
          return {
            stdout: [
              mode === 'before-restart' ? '100' : '200',
              mode === 'before-restart' ? '1700000000' : '1700000500',
              '/bin/zsh',
              '',
              '', '', '',
              '/Users/me/.tmux/plugins/tmux-resurrect/scripts/save.sh', dir, 'off',
              '', '', '', '',
            ].join('=:=') + `\nHOME=${snapDir}\n\n`,
            stderr: '',
          };
        }
        if (args[0] === 'list-sessions') return { stdout: mode === 'before-restart' ? 'work\n' : '', stderr: '' };
        if (args[0] === 'new-session') return { stdout: `$5\t@${nextWin++}\t%${nextPane++}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });

    await svc._appendWindowMeta({ dir });
    expect(readFileSync(snapFile, 'utf8')).toContain('window_meta\twork\t1\t@7');

    // Simulate tmux restart + DockStore noticing new instance before SessionProtection finishes restore
    mode = 'after-restart';
    await store.setServerInstance('200:1700000500');
    expect(store.getSnapshot().windows).toEqual({});

    await svc._firstSight({
      dir,
      pid: '200',
      startedAt: new Date(1_700_000_500_000).toISOString(),
      defaultShell: 'zsh',
      scriptPath: null,
    });

    const migrated = store.getSnapshot();
    expect(migrated.instanceId).toBe('200:1700000500');
    expect(migrated.windows['@20'].items).toHaveLength(2);
    expect(migrated.windows['@20'].items.find((i) => i.type === 'file')).toMatchObject({
      path: '/repo/docs/spec.md',
      paneId: null,
    });
    expect(migrated.windows['@20'].items.find((i) => i.type === 'block')).toMatchObject({
      kind: 'git',
      params: { path: '/repo', commit: '1234abcd' },
    });
    expect(migrated.notices).toHaveLength(2);
    expect(migrated.notices.every((n) => n.target.instanceId === '200:1700000500' && n.target.windowId === '@20' && n.paneId === null)).toBe(true);
  });
});
