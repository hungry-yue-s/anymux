import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_PROGRAMS,
  ambiguousAgentCwdKeys,
  canonicalAgentType,
  exactAgentResumeCommand,
  isSafeAgentSessionId,
  restoreCommand,
} from '../../lib/session-protection/catalog.js';
import { parseSnapshot } from '../../lib/session-protection/snapshot.js';
import { restoreSession } from '../../lib/session-protection/restore.js';
import { SessionProtection } from '../../lib/session-protection/service.js';
import { syncPaneAgentBinding } from '../../plugins/agent-events/index.js';

const execFileAsync = promisify(execFile);
const tempDirs = [];
const isolatedSockets = [];

function tempDir(prefix = 'anymux-agent-resume-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const LIVE_TMUX_BIN = '/Users/massachusetts/.local/share/tmux-web-panel/bin/tmux';

afterEach(async () => {
  while (isolatedSockets.length) {
    const { bin, socket } = isolatedSockets.pop();
    await execFileAsync(bin, ['-L', socket, 'kill-server']).catch(() => {});
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('syncPaneAgentBinding', () => {
  it('writes @anymux_agent_type/@anymux_agent_session on live events, dedupes repeats, rejects unsafe IDs, and unsets on SessionEnd', async () => {
    const calls = [];
    const tmux = {
      run: vi.fn(async (args) => {
        calls.push(args);
        return '';
      }),
    };
    const bound = new Map();

    expect(await syncPaneAgentBinding(tmux, {
      paneId: '%1',
      agentType: 'antigravity',
      source: 'agy',
      state: 'session_started',
      sessionId: 'c1e2a3b4-1111-2222-3333-444455556666',
    }, bound)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'set-option', '-p', '-t', '%1', '@anymux_agent_type', 'antigravity', ';',
      'set-option', '-p', '-t', '%1', '@anymux_agent_session', 'c1e2a3b4-1111-2222-3333-444455556666',
    ]);

    // Exact same pane/agent/session repeated hook skips tmux invocation
    expect(await syncPaneAgentBinding(tmux, {
      paneId: '%1',
      agentType: 'agy',
      state: 'agent_running',
      sessionId: 'c1e2a3b4-1111-2222-3333-444455556666',
    }, bound)).toBe(false);
    expect(calls).toHaveLength(1);

    // Unsafe shell-metacharacter session IDs are rejected
    expect(await syncPaneAgentBinding(tmux, {
      paneId: '%1',
      agentType: 'codex',
      state: 'agent_running',
      sessionId: 'bad;rm -rf /',
    }, bound)).toBe(false);
    expect(calls).toHaveLength(1);

    // SessionEnd unsets options cleanly
    expect(await syncPaneAgentBinding(tmux, {
      paneId: '%1',
      agentType: 'antigravity',
      state: 'session_ended',
    }, bound)).toBe(true);
    expect(calls[1]).toEqual([
      'set-option', '-p', '-u', '-t', '%1', '@anymux_agent_type', ';',
      'set-option', '-p', '-u', '-t', '%1', '@anymux_agent_session',
    ]);
  });
});

describe('agent catalog, snapshot parsing, and multi-pane ambiguity guard', () => {
  it('generates exact resume commands across agy, codex, claude, dsh, and gemini', () => {
    expect(canonicalAgentType('agy')).toBe('antigravity');
    expect(canonicalAgentType('dsh-tui')).toBe('dsh');
    expect(isSafeAgentSessionId('abc-123_def')).toBe(true);
    expect(isSafeAgentSessionId('../escape')).toBe(false);
    expect(isSafeAgentSessionId('a b')).toBe(false);

    expect(exactAgentResumeCommand({ type: 'agy', sessionId: 'conv-1' })).toBe('agy --conversation conv-1');
    expect(exactAgentResumeCommand({ type: 'codex', sessionId: 'thr-2' })).toBe('codex resume thr-2');
    expect(exactAgentResumeCommand({ type: 'claude', sessionId: 'ses-3' })).toBe('claude --resume ses-3');
    expect(exactAgentResumeCommand({ type: 'dsh', sessionId: 'dsh-4' })).toBe('dsh tui --resume dsh-4');
    expect(exactAgentResumeCommand({ type: 'gemini', sessionId: 'gem-5' })).toBe('gemini --resume gem-5');
    expect(exactAgentResumeCommand({ type: 'agy', sessionId: '' }, { allowFallback: true })).toBe('agy --continue');
    expect(exactAgentResumeCommand({ type: 'agy', sessionId: '' }, { allowFallback: false })).toBeNull();
  });

  it('infers agent from command even when fullCommand is the login shell (fish -l)', () => {
    const pane = { command: 'agy', fullCommand: '/opt/homebrew/bin/fish -l' };
    expect(restoreCommand(pane, DEFAULT_PROGRAMS, 'fish')).toBe('agy --continue');
  });

  it('parses agent_pane records and refuses blind fallback only when multiple agents share cwd without IDs', async () => {
    const raw = [
      'pane\twork\t1\t1\t:*\t1\tagy-a\t:/repo/same\t1\tagy\t:/opt/homebrew/bin/fish -l',
      'pane\twork\t1\t1\t:*\t2\tagy-b\t:/repo/same\t0\tagy\t:/opt/homebrew/bin/fish -l',
      'pane\twork\t2\t0\t:-\t1\tagy-c\t:/repo/other\t0\tagy\t:/opt/homebrew/bin/fish -l',
      'pane\twork\t2\t0\t:-\t2\tagy-d\t:/repo/other\t0\tagy\t:/opt/homebrew/bin/fish -l',
      'window\twork\t1\t:dev\t1\t:*\tc9ab,80x24,0,0,0\t:',
      'window\twork\t2\t:dup\t0\t:-\tc9ab,80x24,0,0,1\t:',
      'agent_pane\twork\t1\t1\tantigravity\t:conv-pane-1',
      'agent_pane\twork\t1\t2\tantigravity\t:conv-pane-2',
      'agent_pane\twork\t2\t1\tantigravity\t:',
      'state\twork\twork',
    ].join('\n') + '\n';

    const parsed = parseSnapshot(raw);
    expect(parsed.complete).toBe(true);
    expect(parsed.sessions[0].windows[0].panes[0].agent).toEqual({ type: 'antigravity', sessionId: 'conv-pane-1' });
    expect(parsed.sessions[0].windows[0].panes[1].agent).toEqual({ type: 'antigravity', sessionId: 'conv-pane-2' });

    const calls = [];
    let nextPane = 1;
    let nextWin = 1;
    const tmux = async (args) => {
      calls.push(args);
      if (args[0] === 'new-session') return `$1\t@${nextWin++}\t%${nextPane++}\n`;
      if (args[0] === 'new-window') return `@${nextWin++}\t%${nextPane++}\n`;
      if (args[0] === 'split-window') return `%${nextPane++}\n`;
      return '';
    };

    const amb = ambiguousAgentCwdKeys(parsed.sessions, 'fish');
    expect(amb.has('antigravity\0/repo/other')).toBe(true);
    expect(amb.has('antigravity\0/repo/same')).toBe(false);

    const res = await restoreSession(tmux, parsed.sessions[0], {
      name: 'work',
      programs: DEFAULT_PROGRAMS,
      defaultShell: 'fish',
      ambiguousCwdKeys: amb,
    });
    // Window 1 panes get %1 (conv-pane-1) and %3 (conv-pane-2); Window 2 panes (%2, %4) in /repo/other without IDs stay at shell to avoid cross-wiring
    expect(res.programs).toBe(2);
    expect(calls).toContainEqual(['send-keys', '-t', '%1', '-l', 'agy --conversation conv-pane-1']);
    expect(calls).toContainEqual(['send-keys', '-t', '%3', '-l', 'agy --conversation conv-pane-2']);
    expect(calls).toContainEqual([
      'set-option', '-p', '-t', '%1', '@anymux_agent_type', 'antigravity', ';',
      'set-option', '-p', '-t', '%1', '@anymux_agent_session', 'conv-pane-1',
    ]);
    expect(calls.filter((a) => a[0] === 'send-keys' && a[2] === '%2')).toHaveLength(0);
    expect(calls.filter((a) => a[0] === 'send-keys' && a[2] === '%4')).toHaveLength(0);
  });
});

describe('SessionProtection agent persistence and external continuum mode', () => {
  it('appends agent_pane entries only for active agents, supports node wrappers with @anymux_agent_type, and drops mismatched IDs', async () => {
    const dir = tempDir();
    const snapFile = join(dir, 'tmux_resurrect_20261127T120000.txt');
    writeFileSync(snapFile, [
      'pane\tmain\t1\t1\t:*\t1\tagy\t:/repo/a\t1\tagy\t:/opt/homebrew/bin/fish -l',
      'pane\tmain\t1\t1\t:*\t2\tcodex\t:/repo/a\t0\tnode\t:/opt/homebrew/bin/fish -l',
      'pane\tmain\t1\t1\t:*\t3\tshell\t:/repo/b\t0\tfish\t:/opt/homebrew/bin/fish -l',
      'pane\tmain\t1\t1\t:*\t4\tclaude\t:/repo/c\t0\tclaude\t:/opt/homebrew/bin/fish -l',
      'window\tmain\t1\t:dev\t1\t:*\tlay\t:',
      'state\tmain\tmain',
    ].join('\n') + '\n');
    symlinkSync('tmux_resurrect_20261127T120000.txt', join(dir, 'last'));

    const svc = new SessionProtection({
      configDir: dir,
      projectDir: dir,
      exec: async (_bin, args) => {
        if (args[0] === 'list-panes') {
          return {
            stdout: [
              'main\t1\t1\tagy\tantigravity\tconv-agy-1',
              'main\t1\t2\tnode\tcodex\tthr-codex-2',
              // User exited to fish: stale @anymux_agent_session must NOT be persisted
              'main\t1\t3\tfish\tantigravity\tstale-conv',
              // Pane command changed to claude while @anymux_agent_type still says agy: keep claude but drop stale agy session ID
              'main\t1\t4\tclaude\tantigravity\tstale-agy-id',
            ].join('\n') + '\n',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    });

    await svc._appendAgentPanes({ dir });
    const saved = parseSnapshot(readFileSync(snapFile, 'utf8'));
    const panes = saved.sessions[0].windows[0].panes;
    expect(panes[0].agent).toEqual({ type: 'antigravity', sessionId: 'conv-agy-1' });
    expect(panes[1].agent).toEqual({ type: 'codex', sessionId: 'thr-codex-2' });
    expect(panes[2].agent).toBeUndefined();
    expect(panes[3].agent).toEqual({ type: 'claude', sessionId: '' });
  });

  it('auto-resumes agents once in external tmux-continuum mode on fresh server start and augments external continuum saves later', async () => {
    const home = tempDir();
    const resDir = join(home, '.local', 'share', 'tmux', 'resurrect');
    mkdirSync(resDir, { recursive: true });
    const snapFile = join(resDir, 'tmux_resurrect_20261127T115500.txt');
    writeFileSync(snapFile, [
      'pane\tWork\t1\t1\t:*\t1\tagy\t:/repo/app\t1\tagy\t:/opt/homebrew/bin/fish -l',
      'pane\tWork\t1\t1\t:*\t2\tcodex\t:/repo/app\t0\tcodex\t:/opt/homebrew/bin/fish -l',
      'pane\tWork\t1\t1\t:*\t3\tzsh\t:/repo/app\t0\tzsh\t:/bin/zsh',
      'window\tWork\t1\t:main\t1\t:*\tlay\t:',
      'agent_pane\tWork\t1\t1\tantigravity\t:conv-ext-1',
      'agent_pane\tWork\t1\t2\tcodex\t:thr-ext-2',
      'state\tWork\tWork',
    ].join('\n') + '\n');
    symlinkSync('tmux_resurrect_20261127T115500.txt', join(resDir, 'last'));
    utimesSync(snapFile, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    let currentNow = 1_700_000_030_000; // 30s after server start_time (within FRESH_SERVER_MS)
    const sentKeys = [];
    const paneOptions = { '%1': {}, '%2': {}, '%3': {} };
    let paneCommands = { '%1': 'fish', '%2': 'codex', '%3': 'zsh' };

    const exec = vi.fn(async (_file, args) => {
      const joined = args.join(' ');
      if (args[0] === 'display-message') {
        return {
          stdout: [
            '8888', '1700000000', '/opt/homebrew/bin/fish', '',
            '', '', '',
            '/Users/me/.tmux/plugins/tmux-resurrect/scripts/save.sh', resDir, 'on',
            '', '', '', '',
          ].join('=:=') + `\nHOME=${home}\n\n`,
          stderr: '',
        };
      }
      if (args[0] === 'list-sessions') return { stdout: 'Work\n', stderr: '' };
      if (args[0] === 'list-panes' && joined.includes('#{@anymux_agent_resumed}')) {
        return {
          stdout: [
            `Work\t1\t1\t%1\t${paneCommands['%1']}\t/repo/app\t${paneOptions['%1']['@anymux_agent_resumed'] || ''}`,
            `Work\t1\t2\t%2\t${paneCommands['%2']}\t/repo/app\t${paneOptions['%2']['@anymux_agent_resumed'] || ''}`,
            `Work\t1\t3\t%3\t${paneCommands['%3']}\t/repo/app\t${paneOptions['%3']['@anymux_agent_resumed'] || ''}`,
          ].join('\n') + '\n',
          stderr: '',
        };
      }
      if (args[0] === 'list-panes' && joined.includes('#{@anymux_agent_session}')) {
        return {
          stdout: [
            `Work\t1\t1\tagy\tantigravity\t${paneOptions['%1']['@anymux_agent_session'] || ''}`,
            `Work\t1\t2\tcodex\tcodex\t${paneOptions['%2']['@anymux_agent_session'] || ''}`,
          ].join('\n') + '\n',
          stderr: '',
        };
      }
      if (args[0] === 'list-panes' && joined.includes('#{@pane_kind}')) return { stdout: '', stderr: '' };
      if (args[0] === 'send-keys') {
        sentKeys.push(args);
        if (args[3] === '-l' && args[2] === '%1') paneCommands['%1'] = 'agy';
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'set-option') {
        let cur = [];
        for (const token of [...args, ';']) {
          if (token === ';') {
            if (cur[0] === 'set-option' && cur[1] === '-p' && cur[2] === '-t') {
              paneOptions[cur[3]][cur[4]] = cur[5];
            }
            cur = [];
          } else cur.push(token);
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const svc = new SessionProtection({
      configDir: tempDir(),
      projectDir: resolve('.'),
      windows: false,
      home,
      now: () => currentNow,
      exec,
    });

    // Tick 1 (within FRESH_SERVER_MS): %1 is idle fish -> resumes exact agy conversation; %2 already running codex -> untouched; %3 plain shell -> untouched
    await svc.tick();
    expect(sentKeys).toEqual([
      ['send-keys', '-t', '%1', '-l', 'agy --conversation conv-ext-1'],
      ['send-keys', '-t', '%1', 'Enter'],
    ]);
    expect(paneOptions['%1']).toMatchObject({
      '@anymux_agent_resumed': '1',
      '@anymux_agent_type': 'antigravity',
      '@anymux_agent_session': 'conv-ext-1',
    });

    // Tick 2 (still within FRESH_SERVER_MS): idempotent, no duplicate resume
    await svc.tick();
    expect(sentKeys).toHaveLength(2);

    // Later, continuum writes a plain snapshot without agent_pane lines -> Anymux augments it automatically
    currentNow += 200_000;
    const snap2 = join(resDir, 'tmux_resurrect_20261127T120500.txt');
    writeFileSync(snap2, [
      'pane\tWork\t1\t1\t:*\t1\tagy\t:/repo/app\t1\tagy\t:/opt/homebrew/bin/fish -l',
      'pane\tWork\t1\t1\t:*\t2\tcodex\t:/repo/app\t0\tcodex\t:/opt/homebrew/bin/fish -l',
      'window\tWork\t1\t:main\t1\t:*\tlay\t:',
      'state\tWork\tWork',
    ].join('\n') + '\n');
    utimesSync(snap2, new Date(currentNow), new Date(currentNow));
    rmSync(join(resDir, 'last'), { force: true });
    symlinkSync('tmux_resurrect_20261127T120500.txt', join(resDir, 'last'));
    paneOptions['%2']['@anymux_agent_session'] = 'thr-ext-2';

    await svc.tick();
    const augmented = parseSnapshot(readFileSync(snap2, 'utf8'));
    expect(augmented.sessions[0].windows[0].panes[0].agent).toEqual({ type: 'antigravity', sessionId: 'conv-ext-1' });
    expect(augmented.sessions[0].windows[0].panes[1].agent).toEqual({ type: 'codex', sessionId: 'thr-ext-2' });
  });

  it('persists @anymux_agent_type/@anymux_agent_session via agent_pane and pre-seeds restored pane options on a real isolated tmux server', async () => {
    if (!existsSync(LIVE_TMUX_BIN)) return;
    const socket = `anymux-resume-test-${process.pid}`;
    isolatedSockets.push({ bin: LIVE_TMUX_BIN, socket });

    const runTmux = (args) => execFileAsync(LIVE_TMUX_BIN, ['-L', socket, '-f', '/dev/null', ...args], { windowsHide: true });
    await runTmux(['new-session', '-d', '-s', 'demo', '-x', '80', '-y', '24', 'exec sleep 30']);
    const paneOut = (await runTmux(['list-panes', '-t', 'demo', '-F', '#{pane_id}'])).stdout.trim();

    await syncPaneAgentBinding(
      { run: async (args) => (await runTmux(args)).stdout },
      { paneId: paneOut, agentType: 'agy', state: 'session_started', sessionId: 'real-conv-99' },
      new Map(),
    );

    const home = tempDir();
    const resDir = join(home, '.local', 'share', 'tmux', 'resurrect');
    mkdirSync(resDir, { recursive: true });
    const snapFile = join(resDir, 'tmux_resurrect_20261127T121000.txt');
    writeFileSync(snapFile, [
      `pane\tdemo\t0\t1\t:*\t0\tagy\t:${home}\t1\tsleep\t:sleep 30`,
      'window\tdemo\t0\t:main\t1\t:*\tlay\t:',
      'state\tdemo\tdemo',
    ].join('\n') + '\n');
    symlinkSync('tmux_resurrect_20261127T121000.txt', join(resDir, 'last'));

    const svc = new SessionProtection({
      configDir: tempDir(),
      projectDir: resolve('.'),
      tmuxBin: LIVE_TMUX_BIN,
      exec: (_bin, args) => execFileAsync(LIVE_TMUX_BIN, ['-L', socket, ...args], { windowsHide: true }),
    });
    await svc._appendAgentPanes({ dir: resDir });

    const parsed = parseSnapshot(readFileSync(snapFile, 'utf8'));
    expect(parsed.sessions[0].windows[0].panes[0].agent).toEqual({ type: 'antigravity', sessionId: 'real-conv-99' });

    const restored = await restoreSession(
      async (args) => (await runTmux(args)).stdout,
      parsed.sessions[0],
      { name: 'demo-restored', programs: DEFAULT_PROGRAMS, defaultShell: 'fish' },
    );
    expect(restored.programs).toBe(1);

    const restoredOpts = (await runTmux([
      'list-panes', '-t', 'demo-restored', '-F', '#{@anymux_agent_type}|#{@anymux_agent_session}',
    ])).stdout.trim();
    expect(restoredOpts).toBe('antigravity|real-conv-99');
  });
});
