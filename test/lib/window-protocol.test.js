import { describe, it, expect, vi } from 'vitest';
import {
  BINARY_FRAME_OUTPUT,
  BINARY_FRAME_SNAPSHOT,
  BINARY_FRAME_SNAPSHOT_CHUNK,
  OUTPUT_HEADER_BYTES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_CHUNK_HEADER_BYTES,
  compactNativeSnapshot,
  createBinaryOutputBatcher,
  decodeBinaryFrame,
  encodeOutputFrame,
  encodeSnapshotFrame,
  encodeSnapshotChunkFrames,
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

  it('splices extraHistoryBytes into compactNativeSnapshot, enforces Orca byte-budget ladder, chunks large snapshots (0x03), and supports dual-cadence getBurstMs', () => {
    const HDR = '\x1bc\x1b[?25l\x1b[?7h\x1b[?6l\x1b[4l';
    const PFX = '\x1b[0m\x0f\x1b(B\x1b)0';
    const SFX = '\x1b]8;;\x1b\\';
    const POST = '\x1b[3g';
    const base = Buffer.from(
      HDR + Array.from({ length: 30 }, (_, i) => `${PFX}BASE_${i}_${'x'.repeat(20)}${SFX}`).join('\r\n') + POST,
    );
    const extra = Buffer.from(Array.from({ length: 400 }, (_, i) => `EXTRA_${i}_${'y'.repeat(20)}`).join('\n'));

    // Splices 400 extra lines before 25 base history lines (rows=5) -> historyLines=425
    const spliced = compactNativeSnapshot(base, { rows: 5, maxHistoryLines: 2000, extraHistoryBytes: extra });
    expect(spliced.historyTotal).toBe(425);
    expect(spliced.historyLines).toBe(425);
    const splicedText = spliced.data.toString('utf8');
    expect(splicedText).toContain('EXTRA_0_');
    expect(splicedText).toContain('BASE_0_');

    // Byte budget triggers Orca ladder degradation cleanly while always preserving visible rows
    const budgeted = compactNativeSnapshot(base, { rows: 5, maxHistoryLines: 2000, extraHistoryBytes: extra, maxBytes: 4096 });
    expect(budgeted.data.length).toBeLessThanOrEqual(4096);
    expect(budgeted.historyLines).toBeLessThan(spliced.historyLines);
    expect(budgeted.data.toString('utf8')).toContain('BASE_29_');

    // Snapshot chunk encode/decode (0x03)
    const bigPayload = Buffer.from('A'.repeat(250));
    const smallFrames = encodeSnapshotChunkFrames({ paneNum: 3, seq: 9, cols: 80, rows: 24, data: Buffer.from('small'), chunkBytes: 100 });
    expect(smallFrames).toHaveLength(1);
    expect(decodeBinaryFrame(smallFrames[0]).kind).toBe('snapshot');

    const chunks = encodeSnapshotChunkFrames({
      paneNum: 3, seq: 9, cols: 80, rows: 24, historyLines: 1200, historyTotal: 5000, data: bigPayload, chunkBytes: 100,
    });
    expect(chunks).toHaveLength(3);
    expect(chunks[0][0]).toBe(BINARY_FRAME_SNAPSHOT_CHUNK);
    expect(chunks[0].length).toBe(SNAPSHOT_CHUNK_HEADER_BYTES + 100);
    const decodedChunks = chunks.map(c => decodeBinaryFrame(c));
    expect(decodedChunks.map(c => [c.chunkIndex, c.chunkCount, c.historyLines, c.historyTotal])).toEqual([
      [0, 3, 1200, 5000],
      [1, 3, 1200, 5000],
      [2, 3, 1200, 5000],
    ]);
    expect(Buffer.concat(decodedChunks.map(c => c.data)).equals(bigPayload)).toBe(true);

    // parseWindowStreamTarget ack=1
    expect(parseWindowStreamTarget('/ws/window-stream/%402', new URLSearchParams('protocol=1&instanceId=1:2&sessionId=$3&ack=1')))
      .toEqual({ windowId: '@2', instanceId: '1:2', sessionId: '$3', ack: true });

    // Dual-cadence getBurstMs
    vi.useFakeTimers();
    let clock = 1000;
    const emitted = [];
    const dualBatcher = createBinaryOutputBatcher((paneId, bytes) => emitted.push([paneId, bytes.toString()]), {
      now: () => clock,
      idleAfterMs: 10,
      getBurstMs: paneId => (paneId === '%1' ? 2 : 30),
    });
    try {
      dualBatcher.push('%1', Buffer.from('a'));
      dualBatcher.push('%2', Buffer.from('b'));
      clock += 1;
      dualBatcher.push('%1', Buffer.from('a2'));
      dualBatcher.push('%2', Buffer.from('b2'));
      expect(emitted).toHaveLength(2);
      vi.advanceTimersByTime(5);
      expect(emitted.filter(([p]) => p === '%1')).toHaveLength(2);
      expect(emitted.filter(([p]) => p === '%2')).toHaveLength(1);
      vi.advanceTimersByTime(30);
      expect(emitted.filter(([p]) => p === '%2')).toHaveLength(2);
    } finally {
      dualBatcher.dispose();
      vi.useRealTimers();
    }
  });
});
