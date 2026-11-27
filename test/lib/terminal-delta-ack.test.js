import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OutputDeltaRing } from '../../lib/terminal/output-ring.js';
import { InputAckLedger } from '../../lib/terminal/input-ledger.js';
import { parseWindowStreamTarget } from '../../lib/terminal/window-protocol.js';
import { WindowStreamGateway } from '../../lib/terminal/window-gateway.js';

describe('Terminal Output Delta Ring & Input ACK Ledger (Orca MIT port)', () => {
  it('retains bounded chunks and answers in-range vs expired delta requests', () => {
    const ring = new OutputDeltaRing({ maxBytes: 1024 });
    const s1 = ring.push('chunk-1-');
    const s2 = ring.push('chunk-2-');
    const s3 = ring.push('chunk-3');
    expect([s1, s2, s3]).toEqual([1, 2, 3]);

    const delta = ring.since(1);
    expect(delta.ok).toBe(true);
    expect(delta.chunks.map((c) => c.bytes.toString('utf8'))).toEqual(['chunk-2-', 'chunk-3']);

    // Force eviction past 1024 bytes
    ring.push('x'.repeat(900));
    ring.push('y'.repeat(900));
    expect(ring.since(1).ok).toBe(false);
    expect(ring.since(ring.headSeq).ok).toBe(true);
    expect(ring.since(ring.headSeq).chunks).toEqual([]);
  });

  it('deduplicates repeated sequence numbers per (clientId, paneId)', () => {
    const ledger = new InputAckLedger({ maxPerClient: 64 });
    expect(ledger.checkAndRecord('cli-1', '%0', 1)).toEqual({ duplicate: false, ackSeq: 1 });
    expect(ledger.checkAndRecord('cli-1', '%0', 1)).toEqual({ duplicate: true, ackSeq: 1 });
    expect(ledger.checkAndRecord('cli-1', '%0', 2)).toEqual({ duplicate: false, ackSeq: 2 });
    expect(ledger.checkAndRecord('cli-2', '%0', 1)).toEqual({ duplicate: false, ackSeq: 1 });
    expect(ledger.lastSeq('cli-1', '%0')).toBe(2);
  });

  it('parses optional clientId/sinceSeq cleanly and emits input-ack on seq-tagged WS input', async () => {
    const base = parseWindowStreamTarget('/ws/window-stream/@1', new URLSearchParams('protocol=1&instanceId=1:1&sessionId=$1'));
    expect(base).toEqual({ instanceId: '1:1', sessionId: '$1', windowId: '@1' });

    const withDelta = parseWindowStreamTarget(
      '/ws/window-stream/@1',
      new URLSearchParams('protocol=1&instanceId=1:1&sessionId=$1&clientId=c-abc&sinceSeq=%0:10,%1:4&ack=1'),
    );
    expect(withDelta.clientId).toBe('c-abc');
    expect(withDelta.sinceSeq).toEqual({ '%0': 10, '%1': 4 });

    const sent = [];
    const ws = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (data) => sent.push(data),
      close: vi.fn(),
    });
    const inputs = [];
    const gw = new WindowStreamGateway({
      pool: {
        subscribeWindow: async () => ({
          input: async (paneId, data, meta) => {
            inputs.push({ paneId, data: Buffer.from(data).toString(), meta });
            meta?.onAck?.({ duplicate: inputs.length > 1, ackSeq: meta.seq });
            return true;
          },
          close: vi.fn(),
        }),
      },
    });

    await gw.handle(ws, '/ws/window-stream/@1', new URLSearchParams('protocol=1&instanceId=1:1&sessionId=$1&clientId=cli-9'));
    ws.emit('message', JSON.stringify({ type: 'input', paneId: '%0', data: 'ls', seq: 7 }));
    ws.emit('message', JSON.stringify({ type: 'input', paneId: '%0', data: 'ls', seq: 7 }));
    await new Promise((r) => setTimeout(r, 15));

    const acks = sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'input-ack');
    expect(acks).toEqual([
      { type: 'input-ack', paneId: '%0', seq: 7, duplicate: false },
      { type: 'input-ack', paneId: '%0', seq: 7, duplicate: true },
    ]);
    ws.emit('close');
  });
});
