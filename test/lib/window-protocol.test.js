import { describe, it, expect, vi } from 'vitest';
import {
  BINARY_FRAME_OUTPUT,
  BINARY_FRAME_SNAPSHOT,
  OUTPUT_HEADER_BYTES,
  SNAPSHOT_HEADER_BYTES,
  createBinaryOutputBatcher,
  decodeBinaryFrame,
  encodeOutputFrame,
  encodeSnapshotFrame,
  parsePaneNum,
  parseWindowStreamTarget,
} from '../../lib/terminal/window-protocol.js';

describe('window stream binary protocol & batcher', () => {
  it('encodes and decodes output (9B) and snapshot (21B) binary frames losslessly', () => {
    const out = encodeOutputFrame(42, 7, Buffer.from('\x1b[31mhi中'));
    expect(out.length).toBe(OUTPUT_HEADER_BYTES + 10);
    expect(out[0]).toBe(BINARY_FRAME_OUTPUT);
    expect(decodeBinaryFrame(out)).toMatchObject({
      kind: 'output',
      paneNum: 42,
      paneId: '%42',
      seq: 7,
    });
    expect(decodeBinaryFrame(out).data.toString()).toBe('\x1b[31mhi中');

    const snap = encodeSnapshotFrame({
      paneNum: 12,
      seq: 0,
      cols: 120,
      rows: 40,
      historyLines: 200,
      historyTotal: 5400,
      data: Buffer.from('\x1bcHELLO'),
    });
    expect(snap.length).toBe(SNAPSHOT_HEADER_BYTES + 7);
    expect(snap[0]).toBe(BINARY_FRAME_SNAPSHOT);
    const decodedSnap = decodeBinaryFrame(snap);
    expect(decodedSnap).toMatchObject({
      kind: 'snapshot',
      paneNum: 12,
      paneId: '%12',
      seq: 0,
      cols: 120,
      rows: 40,
      historyLines: 200,
      historyTotal: 5400,
    });
    expect(decodedSnap.data.toString()).toBe('\x1bcHELLO');
  });

  it('rejects malformed frames, invalid pane ids, and invalid targets', () => {
    expect(() => parsePaneNum('bad')).toThrow();
    expect(() => encodeOutputFrame(-1, 1, Buffer.from('a'))).toThrow();
    expect(() => encodeSnapshotFrame({ paneNum: 1, cols: 0, rows: 24, data: Buffer.alloc(0) })).toThrow();
    expect(() => decodeBinaryFrame(Buffer.alloc(0))).toThrow();
    expect(() => decodeBinaryFrame(Buffer.from([0x01, 0, 0]))).toThrow();
    expect(() => decodeBinaryFrame(Buffer.from([0x02, 0, 0, 0, 1]))).toThrow();
    expect(() => decodeBinaryFrame(Buffer.from([0x99, 0, 0, 0, 1]))).toThrow();

    expect(parseWindowStreamTarget('/ws/window-stream/%402', new URLSearchParams('protocol=1&instanceId=1:2&sessionId=$3')))
      .toEqual({ windowId: '@2', instanceId: '1:2', sessionId: '$3' });
    expect(() => parseWindowStreamTarget('/ws/window-stream/@2', new URLSearchParams('protocol=2&instanceId=1:2&sessionId=$3'))).toThrow();
    expect(() => parseWindowStreamTarget('/ws/window-stream/%253', new URLSearchParams('protocol=1&instanceId=1:2&sessionId=$3'))).toThrow();
  });

  it('flushes idle keystrokes at 0ms, coalesces bursts, enforces maxBytes, and discards stale chunks', () => {
    vi.useFakeTimers();
    let clock = 1000;
    const flushed = [];
    const batcher = createBinaryOutputBatcher((paneId, bytes) => flushed.push([paneId, bytes.toString()]), {
      now: () => clock,
      burstMs: 4,
      idleAfterMs: 30,
      maxBytes: 10,
    });
    try {
      // Idle > 30ms: immediate synchronous flush (0ms echo delay)
      batcher.push('%1', Buffer.from('a'));
      expect(flushed).toEqual([['%1', 'a']]);

      // Burst within 30ms: queued and merged
      clock += 1;
      batcher.push('%1', Buffer.from('bc'));
      batcher.push('%1', Buffer.from('def'));
      expect(flushed).toHaveLength(1);
      vi.advanceTimersByTime(4);
      expect(flushed).toEqual([['%1', 'a'], ['%1', 'bcdef']]);

      // Exceeds maxBytes: flushes synchronously
      clock += 1;
      batcher.push('%1', Buffer.from('123456'));
      batcher.push('%1', Buffer.from('7890'));
      expect(flushed).toHaveLength(3);
      expect(flushed[2]).toEqual(['%1', '1234567890']);

      // Discard drops buffered pre-snapshot chunks without emitting
      clock += 1;
      batcher.push('%1', Buffer.from('stale'));
      batcher.discard('%1');
      vi.advanceTimersByTime(10);
      expect(flushed).toHaveLength(3);
    } finally {
      batcher.dispose();
      vi.useRealTimers();
    }
  });
});
