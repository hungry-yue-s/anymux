import { describe, expect, it } from 'vitest';
import {
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS,
  PROGRAM_STATUS_QUERY_REPLY,
  createProgramStatusScanner,
  parseProgramStatusBody,
  projectProgramStatusToAgentEvent,
  shouldProgramStatusYieldToHook,
} from '../../lib/terminal/program-status.js';
import { AgentEventService } from '../../lib/agent-events.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('wave 3 OSC 7501, OSC 133, standalone BEL scanner & hook precedence', () => {
  it('parses OSC 7501 query and report frames with UTF-8 base64 msg/title validation', () => {
    expect(parseProgramStatusBody('?')).toEqual({ type: 'query' });
    const rep = parseProgramStatusBody(`state=blocked:kind=permission:app=claude-code:progress=45:msg=${b64('Approve Bash tool')}`);
    expect(rep).toEqual({
      type: 'report',
      report: {
        id: null,
        state: 'blocked',
        kind: 'permission',
        progress: 45,
        app: 'claude-code',
        msg: 'Approve Bash tool',
      },
    });
    expect(PROGRAM_STATUS_QUERY_REPLY).toContain('\x1b]7501;?:states=');
    // Reject C0 control characters inside base64 msg
    expect(parseProgramStatusBody(`state=working:msg=${b64('bad\nline')}`)).toBeNull();
    // Project onto Anymux agent event
    expect(projectProgramStatusToAgentEvent(rep.report, { paneId: '%8' })).toMatchObject({
      source: 'osc7501',
      origin: 'terminal',
      agent: 'claude',
      event: 'permission_wait',
      state: 'waiting_attention',
      paneId: '%8',
      reason: 'Approve Bash tool',
    });
  });

  it('distinguishes standalone BEL from 0x07 terminating OSC sequences and handles split chunks', () => {
    const scanner = createProgramStatusScanner();
    // Title OSC ending in 0x07 MUST NOT emit a standalone 'bel' event!
    const titleWithBelTerminator = '\x1b]0;build ok\x07normal text';
    expect(scanner.scan(titleWithBelTerminator)).toEqual([]);

    // Split OSC 7501 across chunks + OSC 133 C/D + standalone BEL
    expect(scanner.scan('\x1b]7501;state=work')).toEqual([]);
    const events1 = scanner.scan(`ing:app=codex:msg=${b64('Indexing')}\x1b\\done\x07`);
    expect(events1.map((e) => e.type)).toEqual(['report', 'bel']);
    expect(events1[0].report).toMatchObject({ state: 'working', app: 'codex', msg: 'Indexing' });

    // OMP adjacent B;C;D;0 ignores the spurious D;0 command-finished, whereas real 133;C + output + 133;D;2 emits command-finished
    const ompEvents = scanner.scan('\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07');
    expect(ompEvents.some((e) => e.type === 'command-finished')).toBe(false);
    const events2 = scanner.scan('\x1b]133;C\x07hello\n\x1b]133;D;2\x07');
    expect(events2).toMatchObject([
      { type: 'command-start' },
      { type: 'command-finished', exitCode: 2 },
    ]);
  });

  it('yields passive OSC 7501/133 events to active explicit hooks until 2m silence fallback', () => {
    let now = 10_000;
    const svc = new AgentEventService({ now: () => now });
    svc.ingest({ agent: 'claude', event: 'UserPromptSubmit', paneId: '%19' });
    expect(svc.getPaneState('%19').status).toBe('working');

    // Passive OSC 7501 idle arriving 5s later MUST yield to live explicit hook
    now += 5000;
    const passiveEarly = svc.ingest({
      source: 'osc7501',
      origin: 'terminal',
      agent: 'claude',
      event: 'agent_stop',
      paneId: '%19',
    });
    expect(passiveEarly.yielded).toBe(true);
    expect(svc.getPaneState('%19').status).toBe('working');

    // After >= 2 minutes of hook silence, OSC 7501 fallback succeeds
    now += HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS;
    expect(shouldProgramStatusYieldToHook(svc.getPaneState('%19'), { origin: 'terminal', source: 'osc7501' }, now)).toBe(false);
    const passiveLate = svc.ingest({
      source: 'osc7501',
      origin: 'terminal',
      agent: 'claude',
      event: 'agent_stop',
      paneId: '%19',
    });
    expect(passiveLate.yielded).toBeUndefined();
    expect(svc.getPaneState('%19').status).toBe('done');
  });
});
