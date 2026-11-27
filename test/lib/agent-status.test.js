import { describe, it, expect, beforeEach } from 'vitest';
import {
  AGENT_STATES,
  STATUS_PRIORITY,
  rankAgentStatus,
  isShellCommand,
  normalizeAgentType,
  matchAgentFromCommand,
  matchAgentFromCommandLine,
  resolveAppKind,
  parseProcessTable,
  scanProcessTable,
  _resetProcessCache,
  resolvePaneAgentFromProcesses,
  stripTitleDecorations,
  parseOsc9999Payload,
  detectAgentFromTitle,
  detectAgentFromScreen,
  formatShortModel,
  fusePaneAgentStatus,
  buildAgentStatusSnapshot,
} from '../../lib/agent-status.js';

describe('agent-status core detection and fusion', () => {
  beforeEach(() => {
    _resetProcessCache();
  });

  it('orders canonical states by Orca priority', () => {
    expect(AGENT_STATES).toContain('permission');
    expect(rankAgentStatus('permission')).toBeGreaterThan(rankAgentStatus('failed'));
    expect(rankAgentStatus('failed')).toBeGreaterThan(rankAgentStatus('working'));
    expect(rankAgentStatus('working')).toBeGreaterThan(rankAgentStatus('monitoring'));
    expect(rankAgentStatus('monitoring')).toBeGreaterThan(rankAgentStatus('interrupted'));
    expect(rankAgentStatus('interrupted')).toBeGreaterThan(rankAgentStatus('done'));
    expect(rankAgentStatus('done')).toBeGreaterThan(rankAgentStatus('idle'));
    expect(STATUS_PRIORITY.permission).toBe(7);
  });

  it('distinguishes login shells and tool commands', () => {
    expect(isShellCommand('-zsh')).toBe(true);
    expect(isShellCommand('/bin/bash')).toBe(true);
    expect(isShellCommand('pwsh.exe')).toBe(true);
    expect(isShellCommand('claude')).toBe(false);
    expect(resolveAppKind('-zsh')).toBe('shell');
    expect(resolveAppKind('nvim')).toBe('editor');
    expect(resolveAppKind('python3')).toBe('python');
    expect(resolveAppKind('claude')).toBe('claude');
  });

  it('normalizes agent names and detects agents from command lines', () => {
    expect(normalizeAgentType('Claude-Code')).toBe('claude');
    expect(normalizeAgentType('qodercli')).toBe('qoder');
    expect(normalizeAgentType('agy')).toBe('antigravity');
    expect(normalizeAgentType('dsh-tui')).toBe('dsh');
    expect(normalizeAgentType('qoderclicn')).toBe('qoder-cn');
    expect(normalizeAgentType('traecli')).toBe('trae');
    expect(normalizeAgentType('qwen')).toBe('qwen-code');
    expect(normalizeAgentType('vibe')).toBe('mistral-vibe');
    expect(normalizeAgentType('auggie')).toBe('aug');
    expect(normalizeAgentType('cn')).toBe('continue');
    expect(matchAgentFromCommand('/usr/local/bin/codex')).toBe('codex');
    expect(matchAgentFromCommand('/usr/local/bin/agy')).toBe('antigravity');
    expect(matchAgentFromCommandLine('node /Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js --full-auto')).toBe('codex');
    expect(matchAgentFromCommandLine('node /opt/homebrew/bin/claude --resume abc')).toBe('claude');
    expect(matchAgentFromCommandLine('node /opt/homebrew/bin/dsh --profile dsh-tui')).toBe('dsh');
    expect(matchAgentFromCommandLine('agy')).toBe('antigravity');
    expect(matchAgentFromCommandLine('acli rovodev run')).toBe('rovo');
    expect(matchAgentFromCommandLine('python3 -m aider --model sonnet')).toBe('aider');
    // Negative false-positive checks for unrelated node processes
    expect(matchAgentFromCommandLine('/opt/homebrew/bin/node /Users/me/.claude-mem/dsh-observer/bridge.mjs')).toBe('');
    expect(matchAgentFromCommandLine('node node_modules/next/dist/bin/next dev')).toBe('');
  });

  it('parses ps process table and finds foreground descendant agent (cycle-safe BFS)', () => {
    const psOut = [
      '  100     1 Ss   -zsh',
      '  200   100 S    node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      '  201   200 S+   claude --dangerously-skip-permissions',
      '  300   100 S+   vim README.md',
      '  400   401 S    broken-cycle-a',
      '  401   400 S    broken-cycle-b',
    ].join('\n');

    const map = parseProcessTable(psOut);
    expect(map.get(201).foreground).toBe(true);
    const match = resolvePaneAgentFromProcesses(100, map);
    expect(match).toMatchObject({
      agentType: 'claude',
      pid: 201,
      foreground: true,
    });
    expect(resolvePaneAgentFromProcesses(400, map)).toBeNull();
  });

  it('caches process table scans across ttl window', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return '101 1 S+ claude';
    };
    const first = await scanProcessTable({ ttlMs: 5000, runner });
    const second = await scanProcessTable({ ttlMs: 5000, runner });
    expect(calls).toBe(1);
    expect(first.get(101).basename).toBe('claude');
    expect(second.get(101).basename).toBe('claude');
  });

  it('parses Braille spinners, attention glyphs, and OSC 9999 titles', () => {
    const working = detectAgentFromTitle('⠹ Refactoring auth middleware', 'claude');
    expect(working).toMatchObject({
      status: 'working',
      agentType: 'claude',
      label: 'Refactoring auth middleware',
      spinner: true,
    });

    const attn = detectAgentFromTitle('⏸ Claude Code needs confirmation');
    expect(attn).toMatchObject({
      status: 'permission',
      agentType: 'claude',
    });

    const done = detectAgentFromTitle('✓ Codex finished', 'codex');
    expect(done).toMatchObject({
      status: 'done',
      agentType: 'codex',
    });

    expect(stripTitleDecorations('✳ Fixing tests')).toBe('Fixing tests');
    expect(detectAgentFromTitle('✳ Claude Code', 'claude')).toMatchObject({
      status: null,
      agentType: 'claude',
      label: 'Claude Code',
    });

    const oscKv = parseOsc9999Payload('9999;state=working;agent=claude;model=claude-opus-4-5-20251101;subagents=2;prompt=Fix bug');
    expect(oscKv).toEqual({
      status: 'working',
      agentType: 'claude',
      model: 'claude-opus-4-5-20251101',
      prompt: 'Fix bug',
      label: '',
      subagentCount: 2,
    });

    const oscTitle = detectAgentFromTitle('9999;{"state":"permission","agent":"codex","prompt":"Approve git push"}');
    expect(oscTitle).toMatchObject({
      status: 'permission',
      agentType: 'codex',
      prompt: 'Approve git push',
      source: 'osc',
    });

    // Regression: ✦ is an idle brand glyph (not a spinner); Braille spinner ⠐ is working; astral emoji (🐋, 🚀) must not false-match or get half-stripped
    expect(stripTitleDecorations('✦ 🐋 解释 MAS 的 HWID')).toBe('🐋 解释 MAS 的 HWID');
    const idleDshTitle = detectAgentFromTitle('✦ 🐋 解释 MAS 的 HWID', 'dsh');
    expect(idleDshTitle).toMatchObject({
      status: null,
      agentType: 'dsh',
      label: '🐋 解释 MAS 的 HWID',
    });
    const activeDshTitle = detectAgentFromTitle('⠐ 🐋 解释 MAS 的 HWID', 'dsh');
    expect(activeDshTitle).toMatchObject({
      status: 'working',
      agentType: 'dsh',
      label: '🐋 解释 MAS 的 HWID',
    });
    expect(detectAgentFromTitle('🚀 Deploy service')).toBeNull();
    expect(detectAgentFromTitle('🔔 Approve bash', 'claude')).toMatchObject({
      status: 'permission',
      agentType: 'claude',
      label: 'Approve bash',
    });
  });

  it('infers live agent state from viewport screen tail without false positives on scrollback text', () => {
    expect(detectAgentFromScreen([
      '⣽  0/5 steps · Running command... 10s',
      '>',
      'esc to cancel    auto · Orchestrator · Gemini 4 Neon · xhigh · 1 task(s) · /tasks',
    ].join('\n'), 'antigravity')).toMatchObject({
      status: 'working',
      model: 'Gemini 4 Neon',
      source: 'screen',
    });

    expect(detectAgentFromScreen([
      '● Checked 1 task',
      '⣽ Running command... 1s',
      '>',
      'Press up to edit queued messages   auto · Orchestrator · Gemini 4 Neon · xhigh',
    ].join('\n'), 'antigravity')).toMatchObject({
      status: 'working',
      model: 'Gemini 4 Neon',
    });

    expect(detectAgentFromScreen([
      'Summary ready.',
      '>',
      '● [14:01:50] 5m timer running',
      '? for shortcuts   auto · Orchestrator · Gemini 4 Neon · xhigh · 1 task(s) · /tasks',
    ].join('\n'), 'antigravity')).toMatchObject({
      status: 'monitoring',
      model: 'Gemini 4 Neon',
    });

    expect(detectAgentFromScreen([
      'Finished check.',
      '>',
      '? for shortcuts   auto · Orchestrator · Gemini 4 Neon · xhigh',
    ].join('\n'), 'antigravity')).toMatchObject({
      status: 'idle',
      model: 'Gemini 4 Neon',
    });

    expect(detectAgentFromScreen([
      'Run shell command?',
      '❯ 1. Allow once',
      '  2. Deny',
      'esc to cancel   auto · Orchestrator · Gemini 4 Neon · xhigh',
    ].join('\n'), 'antigravity')).toMatchObject({
      status: 'permission',
    });

    expect(detectAgentFromScreen([
      'test result: FAILED. 31 passed; 1 failed',
      '⌸ ❯ 自动',
      'glm-5.3 · ● 1 · max',
    ].join('\n'), 'dsh')).toMatchObject({
      status: 'idle',
    });

    expect(detectAgentFromScreen([
      'Working...',
      '⌸ ❯ 自动',
      'esc 中断',
    ].join('\n'), 'dsh')).toMatchObject({
      status: 'working',
    });

    expect(detectAgentFromScreen([
      '› Ask Codex to do anything',
      'GPT-6.2-Sol xhigh · ⚠ 3 warnings · f2 to view',
    ].join('\n'), 'codex')).toMatchObject({
      status: 'idle',
    });

    expect(detectAgentFromScreen([
      '• Running tests (5s · esc to interrupt)',
    ].join('\n'), 'codex')).toMatchObject({
      status: 'working',
    });

    expect(detectAgentFromScreen('Running tool (esc to interrupt)', 'claude')).toMatchObject({
      status: 'working',
    });
    expect(detectAgentFromScreen('Normal compiler error: FAILED test', 'claude')).toBeNull();
  });

  it('fuses screenMatch transitions, unread done preservation, and stale hook overrides', () => {
    const now = 20_000;
    const active = fusePaneAgentStatus({
      pane: { id: '%2', command: 'agy', title: 'agy ~/w/d/windows' },
      processMatch: { agentType: 'antigravity', pid: 100, command: 'agy' },
      screenMatch: { status: 'working', model: 'Gemini 4 Neon', source: 'screen' },
      now,
    });
    expect(active).toMatchObject({ status: 'working', model: 'Gemini 4 Neon', source: 'screen' });

    const finished = fusePaneAgentStatus({
      pane: { id: '%2', command: 'agy', title: 'agy ~/w/d/windows' },
      processMatch: { agentType: 'antigravity', pid: 100, command: 'agy' },
      screenMatch: { status: 'idle', model: 'Gemini 4 Neon', source: 'screen' },
      prevStatus: active,
      now: now + 2_000,
    });
    expect(finished).toMatchObject({ status: 'done', unread: true, source: 'screen' });

    // Preserved until acknowledged
    const preserved = fusePaneAgentStatus({
      pane: { id: '%2', command: 'agy', title: 'agy ~/w/d/windows' },
      processMatch: { agentType: 'antigravity', pid: 100, command: 'agy' },
      screenMatch: { status: 'idle', model: 'Gemini 4 Neon', source: 'screen' },
      prevStatus: finished,
      now: now + 4_000,
    });
    expect(preserved).toMatchObject({ status: 'done', unread: true });

    // Once acknowledged, settles cleanly to idle
    const settled = fusePaneAgentStatus({
      pane: { id: '%2', command: 'agy', title: 'agy ~/w/d/windows' },
      processMatch: { agentType: 'antigravity', pid: 100, command: 'agy' },
      screenMatch: { status: 'idle', model: 'Gemini 4 Neon', source: 'screen' },
      prevStatus: { ...preserved, unread: false },
      now: now + 6_000,
    });
    expect(settled).toMatchObject({ status: 'idle', unread: false });

    // Stale working hook (>15s) overridden when screen returns to idle
    const staleRecovery = fusePaneAgentStatus({
      pane: { id: '%2', command: 'agy', title: 'agy ~/w/d/windows' },
      processMatch: { agentType: 'antigravity', pid: 100, command: 'agy' },
      hookState: { status: 'working', agentType: 'antigravity', updatedAt: now - 20_000 },
      screenMatch: { status: 'idle', model: 'Gemini 4 Neon', source: 'screen' },
      prevStatus: active,
      now,
    });
    expect(staleRecovery).toMatchObject({ status: 'done', unread: true, source: 'screen' });
  });

  it('shortens model names cleanly', () => {
    expect(formatShortModel('claude-opus-4-5-20251101')).toBe('opus-4.5');
    expect(formatShortModel('anthropic/claude-sonnet-4-20250514')).toBe('sonnet-4');
    expect(formatShortModel('gpt-5.3-codex')).toBe('gpt-5.3');
    expect(formatShortModel('gemini-2.5-pro-preview')).toBe('gemini-2.5');
    expect(formatShortModel('Gemini 4 Neon')).toBe('gemini-4');
  });

  it('fuses hook, title, process, and edge transitions cleanly', () => {
    const now = 10_000;
    // Hook working wins with model + prompt
    const working = fusePaneAgentStatus({
      pane: { id: '%1', command: 'zsh', title: 'Claude Code' },
      processMatch: { agentType: 'claude', pid: 500, command: 'claude' },
      hookState: { status: 'working', agentType: 'claude', model: 'claude-opus-4-5', prompt: 'Refactor router', subagentCount: 2, updatedAt: now - 500 },
      now,
    });
    expect(working).toMatchObject({
      status: 'working',
      agentType: 'claude',
      shortModel: 'opus-4.5',
      prompt: 'Refactor router',
      subagentCount: 2,
      unread: false,
    });

    // Edge transition when zero-config process loses spinner -> done (unread)
    const zeroWorking = fusePaneAgentStatus({
      pane: { id: '%2', command: 'claude', title: '⠋ Working on tests' },
      processMatch: { agentType: 'claude', pid: 501, command: 'claude' },
      now,
    });
    expect(zeroWorking.status).toBe('working');

    const zeroDone = fusePaneAgentStatus({
      pane: { id: '%2', command: 'claude', title: 'Claude Code' },
      processMatch: { agentType: 'claude', pid: 501, command: 'claude' },
      prevStatus: zeroWorking,
      now: now + 2000,
    });
    expect(zeroDone).toMatchObject({
      status: 'done',
      unread: true,
      agentType: 'claude',
    });

    // SessionEnd without live process clears out cleanly
    const ended = fusePaneAgentStatus({
      pane: { id: '%2', command: 'zsh', title: 'zsh' },
      hookState: { status: 'session_ended', agentType: 'claude', updatedAt: now + 3000 },
      prevStatus: zeroWorking,
      now: now + 3000,
    });
    expect(ended).toBeNull();

    // Custom tmux pane label takes priority over runtime title & hook prompt so sidebar matches pane header
    const customNamed = fusePaneAgentStatus({
      pane: { id: '%3', command: 'agy', title: 'agy ~/w/d/windows', label: '自更新' },
      processMatch: { agentType: 'antigravity', pid: 502, command: 'agy' },
      hookState: { status: 'working', agentType: 'antigravity', prompt: 'Should be secondary', updatedAt: now },
      now,
    });
    expect(customNamed.label).toBe('自更新');

    // Stale idle hook without a live agent process must NOT create a ghost agent entry on a plain shell pane
    expect(fusePaneAgentStatus({
      pane: { id: '%6', command: 'fish', path: '/Users/me', windowId: '@4' },
      hookState: { status: 'idle', state: 'session_started', agentType: 'antigravity', updatedAt: now - 5000 },
      now,
    })).toBeNull();

    // Stale done hook with mismatched windowId or cwd and no live process must be rejected
    expect(fusePaneAgentStatus({
      pane: { id: '%11', command: 'fish', path: '/Users/me', windowId: '@6' },
      hookState: { status: 'done', agentType: 'antigravity', windowId: '@7', prompt: '要', updatedAt: now - 5000 },
      now,
    })).toBeNull();
    expect(fusePaneAgentStatus({
      pane: { id: '%12', command: 'fish', path: '/Users/me/', windowId: '@6' },
      hookState: { status: 'done', agentType: 'antigravity', cwd: '/Users/me/projects/tmux-web-panel', prompt: '再看一下', updatedAt: now - 5000 },
      now,
    })).toBeNull();
  });

  it('builds multi-session rolled-up snapshots respecting priority', () => {
    const fusedPanes = new Map([
      ['%1', { paneId: '%1', agentType: 'claude', appKind: 'claude', status: 'done', unread: true, shortModel: 'opus-4.5', updatedAt: 100 }],
      ['%2', { paneId: '%2', agentType: 'codex', appKind: 'codex', status: 'permission', unread: true, shortModel: 'gpt-5.3', updatedAt: 200 }],
      ['%3', { paneId: '%3', agentType: 'qoder', appKind: 'qoder', status: 'working', unread: false, updatedAt: 300 }],
    ]);

    const snapshot = buildAgentStatusSnapshot({
      sessions: [
        {
          id: '$1',
          name: 'main',
          windows: [
            { id: '@1', index: 0, panes: [{ id: '%1' }, { id: '%2' }] },
          ],
        },
        {
          id: '$2',
          name: 'bg',
          windows: [
            { id: '@2', index: 0, panes: [{ id: '%3' }] },
          ],
        },
      ],
      fusedPanes,
      serverInstance: '18130:1795755662',
      updatedAt: 500,
    });

    expect(snapshot.hasAgents).toBe(true);
    expect(snapshot.serverInstance).toBe('18130:1795755662');
    expect(snapshot.windows['@1']).toMatchObject({
      status: 'permission',
      appKind: 'codex',
      agentCount: 2,
      unread: true,
    });
    expect(snapshot.sessions['$1']).toMatchObject({
      sessionName: 'main',
      status: 'permission',
      agentCount: 2,
      unread: true,
    });
    expect(snapshot.sessions['$2']).toMatchObject({
      sessionName: 'bg',
      status: 'working',
      agentCount: 1,
      unread: false,
    });
  });
});
