import { describe, it, expect, vi } from 'vitest';
import {
  ACK_PENDING_MAX_BYTES,
  ACK_STREAM_INITIAL_WINDOW,
  ACK_STREAM_MAX_WINDOW,
  WindowFlowController,
} from '../../lib/terminal/window-flow.js';

describe('WindowFlowController (Orca multiplexed ACK + pacing)', () => {
  it('admits output up to initial window, buffers overflow, grows window on ack, and drains round-robin across panes', () => {
    const sent = [];
    const overflows = [];
    let clock = 1000;
    const flow = new WindowFlowController({
      sendFrame: frame => sent.push(frame),
      onOverflow: paneId => overflows.push(paneId),
      now: () => clock,
    });

    // Send 512 KiB on %1 (fills initial 512 KiB window)
    const f1 = { id: 'p1-a' };
    expect(flow.enqueueOutput('%1', f1, ACK_STREAM_INITIAL_WINDOW)).toBe(true);
    expect(sent).toEqual([f1]);

    // Additional frame on %1 is queued while %2 still gets immediate admission on its own window!
    const f1Queued = { id: 'p1-b' };
    const f2Immediate = { id: 'p2-a' };
    expect(flow.enqueueOutput('%1', f1Queued, 1024)).toBe(true);
    expect(flow.enqueueOutput('%2', f2Immediate, 2048)).toBe(true);
    expect(sent).toEqual([f1, f2Immediate]);

    // Queue %2 as well, then ack both so drain serves them fairly
    flow.enqueueOutput('%2', { id: 'p2-wait' }, ACK_STREAM_INITIAL_WINDOW);
    expect(overflows).toEqual([]);

    clock += 10;
    flow.ack('%1', ACK_STREAM_INITIAL_WINDOW);
    expect(sent).toContainEqual(f1Queued);
    expect(flow.panes.get('%1').windowBytes).toBe(Math.min(ACK_STREAM_MAX_WINDOW, ACK_STREAM_INITIAL_WINDOW * 2));

    flow.dispose();
  });

  it('triggers overflow snapshot recovery when pending exceeds 256 KiB and drops subsequent frames until resetPane', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const overflows = [];
      const flow = new WindowFlowController({
        sendFrame: frame => sent.push(frame),
        onOverflow: paneId => overflows.push(paneId),
      });

      // Fill in-flight window
      flow.enqueueOutput('%1', { id: 'inflight' }, ACK_STREAM_INITIAL_WINDOW);
      // Enqueue pending chunks crossing ACK_PENDING_MAX_BYTES (256 KiB)
      flow.enqueueOutput('%1', { id: 'q1' }, 200 * 1024);
      expect(overflows).toHaveLength(0);
      expect(flow.enqueueOutput('%1', { id: 'q2' }, ACK_PENDING_MAX_BYTES)).toBe(false);

      // Still has inflight bytes -> waits for fallback timer or ack to 0
      expect(overflows).toHaveLength(0);
      vi.advanceTimersByTime(1500);
      expect(overflows).toEqual(['%1']);

      // Subsequent frames while recovering are dropped cleanly without throwing
      expect(flow.enqueueOutput('%1', { id: 'dropped' }, 64)).toBe(false);

      // Recovery snapshot calls resetPane and restores normal flow
      flow.resetPane('%1');
      expect(flow.enqueueOutput('%1', { id: 'fresh' }, 128)).toBe(true);
      expect(sent.at(-1)).toEqual({ id: 'fresh' });
      flow.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies BBR-style paced window specifically to alt-screen panes after backlogged samples', () => {
    const sent = [];
    let clock = 1000;
    const flow = new WindowFlowController({
      sendFrame: frame => sent.push(frame),
      onOverflow: () => {},
      isAltScreen: paneId => paneId === '%9',
      now: () => clock,
    });

    // Establish minRttMs=20ms and slow deliveryRate (~1.6 KB/ms) via backlogged drain cycles on %9
    for (let i = 0; i < 4; i++) {
      flow.enqueueOutput('%9', { id: `full-${i}` }, flow.panes.get('%9')?.windowBytes ?? ACK_STREAM_INITIAL_WINDOW);
      flow.enqueueOutput('%9', { id: `q-${i}` }, 64 * 1024);
      clock += 20;
      flow.ack('%9', flow.panes.get('%9').inFlightBytes);
      clock += 20;
      flow.ack('%9', 64 * 1024);
    }

    const paced = flow.pacedWindowBytes('%9');
    expect(paced).not.toBeNull();
    expect(flow.pacedWindowBytes('%1')).toBeNull(); // normal buffer unaffected

    flow.dispose();
  });
});
