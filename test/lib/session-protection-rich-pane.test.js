import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSnapshot } from '../../lib/session-protection/snapshot.js';
import { restoreSession } from '../../lib/session-protection/restore.js';
import { SessionProtection } from '../../lib/session-protection/service.js';

describe('session protection rich-pane persistence', () => {
  it('parses optional rich_pane lines while preserving legacy resurrect snapshots', () => {
    const legacy = [
      'pane\tdev\t0\t1\t:*\t0\tmain\t:/repo\t1\tzsh\t:zsh',
      'pane\tdev\t0\t1\t:*\t1\tweb\t:/repo\t0\tcat\t:',
      'window\tdev\t0\t:code\t1\t:*\tlayout0\t:',
      'rich_pane\tdev\t0\t1\tbrowser\t:{"url":"https://example.com"}',
      'state\tdev\tdev',
    ].join('\n');

    const parsed = parseSnapshot(legacy);
    expect(parsed.complete).toBe(true);
    expect(parsed.sessions[0].windows[0].panes[0]).not.toHaveProperty('kind');
    expect(parsed.sessions[0].windows[0].panes[1]).toMatchObject({
      index: 1,
      kind: 'browser',
      payload: '{"url":"https://example.com"}',
    });

    // Legacy snapshot without rich_pane remains untouched.
    const plain = parseSnapshot([
      'pane\tdev\t0\t1\t:*\t0\tmain\t:/repo\t1\tzsh\t:zsh',
      'window\tdev\t0\t:code\t1\t:*\tlayout0\t:',
      'state\tdev\tdev',
    ].join('\n'));
    expect(plain.complete).toBe(true);
    expect(plain.sessions[0].windows[0].panes[0].kind).toBeUndefined();
  });

  it('restores rich panes via split-window -E + @pane_kind without sending shell commands', async () => {
    const calls = [];
    let nextPane = 10;
    const tmux = async (args) => {
      calls.push(args);
      if (args[0] === 'new-session') return '$1\t@1\t%1\n';
      if (args[0] === 'split-window') {
        // Simulate older tmux without -E once to verify fallback works seamlessly too.
        if (args.includes('-E') && args.includes('browser')) {
          return `%${nextPane++}\n`;
        }
        if (args.includes('-E')) throw new Error('unknown option -- E');
        return `%${nextPane++}\n`;
      }
      return '';
    };

    const result = await restoreSession(tmux, {
      name: 'dev',
      windows: [{
        index: 0,
        name: 'code',
        active: true,
        layout: null,
        automaticRename: false,
        panes: [
          { index: 0, path: '/repo', active: true, command: 'zsh', fullCommand: 'zsh' },
          { index: 1, path: '/repo', active: false, command: '', fullCommand: '', kind: 'doc', payload: '{"path":"/repo/README.md"}' },
        ],
      }],
    }, { name: 'dev', programs: ['claude'], defaultShell: 'zsh' });

    expect(result.programs).toBe(0);
    expect(calls.some((a) => a[0] === 'set-option' && a.includes('@pane_kind') && a.includes('doc'))).toBe(true);
    expect(calls.some((a) => a[0] === 'set-option' && a.includes('@pane_payload') && a.includes('{"path":"/repo/README.md"}'))).toBe(true);
    expect(calls.some((a) => a[0] === 'send-keys')).toBe(false);
  });

  it('appends rich_pane lines atomically to the snapshot referenced by last', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anymux-resurrect-rich-'));
    try {
      const snapFile = join(dir, 'tmux_resurrect_20261125T020000.txt');
      writeFileSync(snapFile, [
        'pane\twork\t0\t1\t:*\t0\tzsh\t:/repo\t1\tzsh\t:zsh',
        'pane\twork\t0\t1\t:*\t1\tdiff\t:/repo\t0\tcat\t:',
        'window\twork\t0\t:main\t1\t:*\tlay\t:',
        'state\twork\twork',
      ].join('\n') + '\n');
      symlinkSync('tmux_resurrect_20261125T020000.txt', join(dir, 'last'));

      const svc = new SessionProtection({
        configDir: dir,
        projectDir: dir,
        exec: async (_bin, args) => {
          if (args[0] === 'list-panes') {
            return { stdout: 'work\t0\t1\tdiff\t{"path":"/repo"}\nwork\t0\t0\t\t\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });
      await svc._appendRichPanes({ dir });

      const saved = parseSnapshot(readFileSync(snapFile, 'utf8'));
      expect(saved.complete).toBe(true);
      expect(saved.sessions[0].windows[0].panes[1]).toMatchObject({ kind: 'diff', payload: '{"path":"/repo"}' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
