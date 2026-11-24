import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalGateway } from '../../lib/terminal/gateway.js';

function fakeWs() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.sent = [];
  ws.closed = null;
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.close = (code, reason) => { ws.readyState = 3; ws.closed = { code, reason }; };
  return ws;
}

describe('TerminalGateway legacy ConPTY freeze / disableLegacyTerminal', () => {
  it('immediately rejects /ws/terminal upgrades with UNSUPPORTED (1008) when disableLegacyTerminal is true', async () => {
    const resolvePane = vi.fn();
    const create = vi.fn();
    const gateway = new TerminalGateway({
      workspace: { resolvePane },
      terminalManager: { create },
      disableLegacyTerminal: true,
    });
    const ws = fakeWs();
    const out = await gateway.handle(ws, '/ws/terminal/%251', new URLSearchParams('cols=80&rows=24'));
    expect(out).toBeNull();
    expect(resolvePane).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(ws.closed).toEqual({ code: 1008, reason: 'UNSUPPORTED' });
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'UNSUPPORTED' });
  });

  it('continues serving compatibility fallback when disableLegacyTerminal is false', async () => {
    const gateway = new TerminalGateway({
      workspace: { resolvePane: vi.fn(async (id) => ({ paneId: id, sessionId: '$1' })) },
      terminalManager: {
        whenClientCanStart: vi.fn(async (_sid, attach) => attach()),
        create: vi.fn(() => 'conn-1'),
      },
      disableLegacyTerminal: false,
    });
    const ws = fakeWs();
    const out = await gateway.handle(ws, '/ws/terminal/%251', new URLSearchParams('cols=80&rows=24'));
    expect(out).toBe('conn-1');
    expect(ws.sent[0]).toMatchObject({ type: 'ready', paneId: '%1' });
  });
});
