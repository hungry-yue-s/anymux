import { describe, it, expect, vi } from 'vitest';
import {
  INITIAL_SYNC_LATCH,
  SYNC_END_BUFFER,
  advanceDroppedSynchronizedOutputLatch,
  resolveSynchronizedOutputSafeSplitBuffer,
  scanSynchronizedOutput,
} from '../../lib/terminal/synchronized-output.js';
import { createBinaryOutputBatcher } from '../../lib/terminal/window-protocol.js';
import { ACK_PENDING_MAX_BYTES, ACK_STREAM_INITIAL_WINDOW, WindowFlowController } from '../../lib/terminal/window-flow.js';

describe('DEC 2026 synchronized output protection (Wave 1 Item 5)', () => {
  it('tracks open/close markers across chunk boundaries', () => {
    const s1 = scanSynchronizedOutput('hello\x1b[?2026', '', false);
    expect(s1.active).toBe(false);
    expect(s1.markerTail).toBe('\x1b[?2026');

    const s2 = scanSynchronizedOutput('hframe-body\x1b[?2026', s1.markerTail, s1.active);
    expect(s2.started).toBe(true);
    expect(s2.active).toBe(true);

    const s3 = scanSynchronizedOutput('ldone', s2.markerTail, s2.active);
    expect(s3.ended).toBe(true);
    expect(s3.active).toBe(false);
  });

  it('splits oversized batches without bisecting DEC 2026 markers or trapping open frames', () => {
    const payload = Buffer.from('\x1b[?2026h' + 'A'.repeat(20) + '\x1b[?2026l\x1b[?2026h' + 'B'.repeat(20));
    const cut = resolveSynchronizedOutputSafeSplitBuffer(payload, 38, '', false);
    expect(payload.subarray(0, cut).toString('latin1')).toBe('\x1b[?2026h' + 'A'.repeat(20) + '\x1b[?2026l');
  });

  it('batcher emits safe chunks for large bursts inside maxBytes limit without bisecting second frame', () => {
    const flushed = [];
    const batcher = createBinaryOutputBatcher((paneId, bytes) => {
      flushed.push(bytes.toString('latin1'));
    }, { maxBytes: 48, idleAfterMs: 0, burstMs: 5 });

    const second = '\x1b[?2026h' + 'X'.repeat(25) + '\x1b[?2026l' + '\x1b[?2026h' + 'Y'.repeat(30);
    batcher.push('%1', second);
    batcher.flush('%1');
    expect(flushed[0]).toBe('\x1b[?2026h' + 'X'.repeat(25) + '\x1b[?2026l');
    expect(flushed.join('')).toBe(second);
    batcher.dispose();
  });

  it('WindowFlowController emits onDroppedSyncClose if overflow discards output mid DEC 2026 frame', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const syncClosed = [];
      const flow = new WindowFlowController({
        sendFrame: (f) => sent.push(f),
        onOverflow: () => {},
        onDroppedSyncClose: (paneId) => syncClosed.push(paneId),
      });

      const openChunk = Buffer.from('\x1b[?2026hframe-start');
      flow.enqueueOutput('%1', openChunk, ACK_STREAM_INITIAL_WINDOW, openChunk);
      const q1 = Buffer.from('A'.repeat(200 * 1024));
      flow.enqueueOutput('%1', q1, 200 * 1024, q1);
      const q2 = Buffer.from('B'.repeat(ACK_PENDING_MAX_BYTES));
      expect(flow.enqueueOutput('%1', q2, ACK_PENDING_MAX_BYTES, q2)).toBe(false);
      expect(syncClosed).toEqual(['%1']);

      const dropCheck = advanceDroppedSynchronizedOutputLatch('\x1b[?2026hpartial', INITIAL_SYNC_LATCH);
      expect(dropCheck.closeSequence).toEqual(SYNC_END_BUFFER);
      flow.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
