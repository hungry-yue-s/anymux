import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnapshot } from '../../lib/session-protection/snapshot.js';
import { restoreSession } from '../../lib/session-protection/restore.js';
import { SessionProtection } from '../../lib/session-protection/service.js';

const tempDirs = [];

function makeTemp(prefix = 'anymux-pane-label-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('session protection pane_label persistence and restore', () => {
  it('parses optional pane_label lines while keeping legacy snapshots intact', () => {
    const text = [
      'pane\twork\t1\t1\t:*\t1\tagy\t:/repo/a\t1\tagy\t:/bin/fish',
      'pane\twork\t1\t1\t:*\t2\tagy\t:/repo/a\t0\tagy\t:/bin/fish',
      'pane\twork\t1\t1\t:*\t3\tdoc\t:/repo/a\t0\tcat\t:',
      'window\twork\t1\t:panel\t1\t:*\tlay\t:',
      'rich_pane\twork\t1\t3\tdoc\t:{"path":"/repo/a/README.md"}',
      'pane_label\twork\t1\t1\t:main',
      'pane_label\twork\t1\t2\t:窗口布局',
      'pane_label\twork\t1\t3\t:文档侧栏',
      'state\twork\twork',
    ].join('\n');

    const parsed = parseSnapshot(text);
    expect(parsed.complete).toBe(true);
    const panes = parsed.sessions[0].windows[0].panes;
    expect(panes[0].label).toBe('main');
    expect(panes[1].label).toBe('窗口布局');
    expect(panes[2]).toMatchObject({ kind: 'doc', label: '文档侧栏' });

    const plain = parseSnapshot([
      'pane\twork\t1\t1\t:*\t1\tzsh\t:/repo\t1\tzsh\t:zsh',
      'window\twork\t1\t:dev\t1\t:*\tlay\t:',
      'state\twork\twork',
    ].join('\n'));
    expect(plain.sessions[0].windows[0].panes[0].label).toBeUndefined();
  });

  it('restores @pane_label on both terminal/agent panes and rich panes during restoreSession', async () => {
    const calls = [];
    let nextPane = 1;
    const tmux = async (args) => {
      calls.push(args);
      if (args[0] === 'new-session') return `$1\t@1\t%${nextPane++}\n`;
      if (args[0] === 'split-window') return `%${nextPane++}\n`;
      return '';
    };

    await restoreSession(tmux, {
      name: 'work',
      windows: [{
        index: 1,
        name: 'panel',
        active: true,
        layout: null,
        automaticRename: false,
        panes: [
          { index: 1, path: '/repo', active: true, command: 'fish', fullCommand: 'fish', label: '主终端' },
          { index: 2, path: '/repo', active: false, command: '', fullCommand: '', kind: 'doc', payload: '{"path":"/repo/README.md"}', label: '设计文档' },
        ],
      }],
    }, { name: 'work', programs: ['ai'], defaultShell: 'fish' });

    expect(calls).toContainEqual(['set-option', '-p', '-t', '%1', '@pane_label', '主终端']);
    expect(calls).toContainEqual(['set-option', '-p', '-t', '%2', '@pane_label', '设计文档']);
  });

  it('augments latest snapshot via _appendPaneLabels and syncPaneLabels while preserving snapshot mtime', async () => {
    const dir = makeTemp();
    const snapFile = join(dir, 'tmux_resurrect_20261127T120000.txt');
    writeFileSync(snapFile, [
      'pane\twork\t1\t1\t:*\t1\tagy\t:/repo\t1\tagy\t:fish',
      'pane\twork\t1\t1\t:*\t2\tagy\t:/repo\t0\tagy\t:fish',
      'window\twork\t1\t:panel\t1\t:*\tlay\t:',
      'state\twork\twork',
    ].join('\n') + '\n');
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(snapFile, fixedTime, fixedTime);
    symlinkSync('tmux_resurrect_20261127T120000.txt', join(dir, 'last'));

    let currentLabels = ['work\t1\t1\tmain', 'work\t1\t2\t'];
    const svc = new SessionProtection({
      configDir: dir,
      projectDir: dir,
      exec: async (_bin, args) => {
        const joined = args.join(' ');
        if (args[0] === 'display-message') {
          return {
            stdout: [
              '8888', '1699999000', '/bin/fish', '',
              '', '', '',
              '/Users/me/.tmux/plugins/tmux-resurrect/scripts/save.sh', dir, 'on',
              '', '', '', '',
            ].join('=:=') + `\nHOME=${dir}\n\n`,
            stderr: '',
          };
        }
        if (args[0] === 'list-sessions') return { stdout: 'work\n', stderr: '' };
        if (args[0] === 'list-panes' && joined.includes('#{@pane_label}')) {
          return { stdout: currentLabels.join('\n') + '\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    expect(await svc.syncPaneLabels()).toBe(true);
    expect(statSync(snapFile).mtimeMs).toBe(fixedTime.getTime());
    let parsed = parseSnapshot(readFileSync(snapFile, 'utf8'));
    expect(parsed.sessions[0].windows[0].panes[0].label).toBe('main');
    expect(parsed.sessions[0].windows[0].panes[1].label).toBeUndefined();

    // Updating a label later replaces old pane_label lines cleanly
    currentLabels = ['work\t1\t1\t主控台', 'work\t1\t2\t主题优化'];
    expect(await svc.syncPaneLabels()).toBe(true);
    parsed = parseSnapshot(readFileSync(snapFile, 'utf8'));
    expect(parsed.sessions[0].windows[0].panes[0].label).toBe('主控台');
    expect(parsed.sessions[0].windows[0].panes[1].label).toBe('主题优化');
  });

  it('restores saved @pane_label once in external tmux-continuum mode without overwriting user labels', async () => {
    const home = makeTemp();
    const resDir = join(home, '.local', 'share', 'tmux', 'resurrect');
    const dir = resDir;
    const snapFile = join(dir, 'tmux_resurrect_20261127T120000.txt');
    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    writeFileSync(snapFile, [
      'pane\tWork\t1\t1\t:*\t1\tfish\t:/repo/app\t1\tfish\t:/bin/fish',
      'pane\tWork\t1\t1\t:*\t2\tfish\t:/repo/app\t0\tfish\t:/bin/fish',
      'window\tWork\t1\t:main\t1\t:*\tlay\t:',
      'pane_label\tWork\t1\t1\t:左窗格',
      'pane_label\tWork\t1\t2\t:右窗格',
      'state\tWork\tWork',
    ].join('\n') + '\n');
    symlinkSync('tmux_resurrect_20261127T120000.txt', join(dir, 'last'));

    const setOptions = [];
    const exec = vi.fn(async (_bin, args) => {
      const joined = args.join(' ');
      if (args[0] === 'display-message') {
        return {
          stdout: [
            '9000', '1700000000', '/bin/fish', '',
            '', '', '',
            '/Users/me/.tmux/plugins/tmux-resurrect/scripts/save.sh', dir, 'on',
            '', '', '', '',
          ].join('=:=') + `\nHOME=${home}\n\n`,
          stderr: '',
        };
      }
      if (args[0] === 'list-sessions') return { stdout: 'Work\n', stderr: '' };
      if (args[0] === 'list-panes' && joined.includes('#{@pane_label}')) {
        return {
          stdout: [
            'Work\t1\t1\t%10\t/repo/app\t',
            'Work\t1\t2\t%11\t/repo/app\t已手动命名',
          ].join('\n') + '\n',
          stderr: '',
        };
      }
      if (args[0] === 'set-option') setOptions.push(args);
      return { stdout: '', stderr: '' };
    });

    const svc = new SessionProtection({
      configDir: makeTemp(),
      projectDir: '.',
      windows: false,
      home,
      now: () => 1_700_000_030_000, // 30s after start_time -> fresh server
      exec,
    });

    await svc.tick();
    expect(setOptions).toEqual([
      ['set-option', '-p', '-t', '%10', '@pane_label', '左窗格'],
    ]);

    // Second tick on same server does not repeat set-option
    await svc.tick();
    expect(setOptions).toHaveLength(1);
  });
});
