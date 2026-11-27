import {
  INITIAL_SYNC_LATCH,
  advanceDroppedSynchronizedOutputLatch,
  scanSynchronizedOutput,
} from './synchronized-output.js';

/**
 * Per-subscriber multiplexed ACK flow control and alt-screen link pacing
 * modeled after Orca's terminal stream multiplex flow controller.
 */

export const ACK_STREAM_INITIAL_WINDOW = 512 * 1024;
export const ACK_STREAM_MAX_WINDOW = 2 * 1024 * 1024;
export const ACK_TOTAL_INITIAL_WINDOW = 2 * 1024 * 1024;
export const ACK_TOTAL_MAX_WINDOW = 8 * 1024 * 1024;
export const ACK_PENDING_MAX_BYTES = 256 * 1024;
export const ALT_SCREEN_MIN_PACED_WINDOW = 48 * 1024;
export const WS_PAUSE_BUFFERED_BYTES = 512 * 1024;
export const OVERFLOW_RECOVERY_FALLBACK_MS = 1500;

const RTT_WINDOW_MS = 10_000;
const ALT_PACING_MIN_SAMPLES = 3;
const ALT_PACING_MIN_RTT_MS = 5;

export class WindowFlowController {
  constructor({
    sendFrame,
    onOverflow,
    onDroppedSyncClose = null,
    getBufferedAmount = () => 0,
    isAltScreen = () => false,
    now = Date.now,
  }) {
    this.sendFrame = sendFrame;
    this.onOverflow = onOverflow;
    this.onDroppedSyncClose = onDroppedSyncClose;
    this.getBufferedAmount = getBufferedAmount;
    this.isAltScreen = isAltScreen;
    this.now = now;
    this.panes = new Map();
    this.cursorIndex = 0;
    this.totalInFlightBytes = 0;
    this.totalWindowBytes = ACK_TOTAL_INITIAL_WINDOW;
    this.minRttMs = null;
    this.minRttAt = 0;
    this.deliveryRate = null;
    this.ackBurst = 0;
    this.backloggedSamples = 0;
  }

  _pane(paneId) {
    let pane = this.panes.get(paneId);
    if (!pane) {
      pane = {
        inFlightBytes: 0,
        windowBytes: ACK_STREAM_INITIAL_WINDOW,
        pending: [],
        pendingBytes: 0,
        overflowed: false,
        recovering: false,
        overflowTimer: null,
        sentSamples: [],
        syncLatch: INITIAL_SYNC_LATCH,
      };
      this.panes.set(paneId, pane);
    }
    return pane;
  }

  _clearOverflowTimer(pane) {
    if (pane?.overflowTimer) {
      clearTimeout(pane.overflowTimer);
      pane.overflowTimer = null;
    }
  }

  _triggerOverflow(paneId, pane) {
    if (pane.recovering) return;
    pane.recovering = true;
    this._clearOverflowTimer(pane);
    this.onOverflow?.(paneId);
  }

  pacedWindowBytes(paneId) {
    if (!this.isAltScreen(paneId)) return null;
    if (this.backloggedSamples < ALT_PACING_MIN_SAMPLES) return null;
    if (this.minRttMs === null || this.minRttMs < ALT_PACING_MIN_RTT_MS) return null;
    if (this.deliveryRate === null || this.deliveryRate <= 0) return null;
    return Math.max(
      ALT_SCREEN_MIN_PACED_WINDOW,
      Math.ceil(2 * this.deliveryRate * this.minRttMs + this.ackBurst),
    );
  }

  _canAdmit(pane, paneId, payloadBytes) {
    if (pane.overflowed || pane.recovering) return false;
    if ((this.getBufferedAmount?.() || 0) >= WS_PAUSE_BUFFERED_BYTES && this.totalInFlightBytes > 0) {
      return false;
    }
    if (pane.inFlightBytes + payloadBytes > pane.windowBytes) return false;
    if (this.totalInFlightBytes + payloadBytes > this.totalWindowBytes) return false;
    const paced = this.pacedWindowBytes(paneId);
    if (paced !== null && pane.inFlightBytes > 0 && pane.inFlightBytes + payloadBytes > paced) {
      return false;
    }
    return true;
  }

  _emit(pane, paneId, frame, payloadBytes, backlogged, rawPayload = null) {
    pane.inFlightBytes += payloadBytes;
    this.totalInFlightBytes += payloadBytes;
    if (rawPayload) {
      const scan = scanSynchronizedOutput(rawPayload, pane.syncLatch.markerTail, pane.syncLatch.active);
      pane.syncLatch = { markerTail: scan.markerTail, active: scan.active };
    }
    pane.sentSamples.push({
      sentAt: this.now(),
      bytes: payloadBytes,
      backlogged,
    });
    if (pane.sentSamples.length > 64) pane.sentSamples.shift();
    this.sendFrame(frame);
  }

  enqueueOutput(paneId, frame, payloadBytes, rawPayload = null) {
    const pane = this._pane(paneId);
    if (pane.overflowed || pane.recovering) return false;
    if (pane.pending.length === 0 && this._canAdmit(pane, paneId, payloadBytes)) {
      this._emit(pane, paneId, frame, payloadBytes, false, rawPayload);
      return true;
    }
    pane.pending.push({ frame, bytes: payloadBytes, rawPayload });
    pane.pendingBytes += payloadBytes;
    if (pane.pendingBytes > ACK_PENDING_MAX_BYTES) {
      let openSyncAfterDrop = pane.syncLatch.active;
      let latch = pane.syncLatch;
      for (const item of pane.pending) {
        if (item.rawPayload) {
          const advanced = advanceDroppedSynchronizedOutputLatch(item.rawPayload, latch);
          latch = advanced.state;
          openSyncAfterDrop = Boolean(advanced.closeSequence);
        }
      }
      if (rawPayload && openSyncAfterDrop) {
        pane.syncLatch = latch;
      }
      if (pane.syncLatch.active) {
        pane.syncLatch = INITIAL_SYNC_LATCH;
        this.onDroppedSyncClose?.(paneId);
      }
      pane.pending.length = 0;
      pane.pendingBytes = 0;
      pane.overflowed = true;
      if (pane.inFlightBytes === 0) {
        this._triggerOverflow(paneId, pane);
      } else if (!pane.overflowTimer) {
        pane.overflowTimer = setTimeout(() => {
          pane.overflowTimer = null;
          if (pane.overflowed && !pane.recovering) {
            this._triggerOverflow(paneId, pane);
          }
        }, OVERFLOW_RECOVERY_FALLBACK_MS);
        pane.overflowTimer.unref?.();
      }
      return false;
    }
    return true;
  }

  _recordAckTiming(pane, ackedBytes) {
    const now = this.now();
    let remaining = ackedBytes;
    let sample = null;
    while (remaining > 0 && pane.sentSamples.length > 0) {
      const head = pane.sentSamples[0];
      sample = head;
      if (head.bytes <= remaining) {
        remaining -= head.bytes;
        pane.sentSamples.shift();
      } else {
        head.bytes -= remaining;
        remaining = 0;
      }
    }
    this.ackBurst = this.ackBurst ? Math.round(this.ackBurst * 0.75 + ackedBytes * 0.25) : ackedBytes;
    if (!sample) return;
    const rtt = Math.max(0, now - sample.sentAt);
    if (this.minRttMs === null || rtt < this.minRttMs || now - this.minRttAt > RTT_WINDOW_MS) {
      this.minRttMs = rtt;
      this.minRttAt = now;
    }
    const elapsed = Math.max(1, now - sample.sentAt);
    const rate = ackedBytes / elapsed;
    if (sample.backlogged) {
      this.backloggedSamples += 1;
      this.deliveryRate = this.deliveryRate === null ? rate : this.deliveryRate * 0.6 + rate * 0.4;
    } else if (this.deliveryRate === null || rate > this.deliveryRate) {
      this.deliveryRate = rate;
    }
  }

  ack(paneId, bytes) {
    const pane = this.panes.get(paneId);
    if (!pane || !(bytes > 0)) return 0;
    const acked = Math.min(pane.inFlightBytes, bytes);
    if (acked > 0) {
      this._recordAckTiming(pane, acked);
      pane.windowBytes = Math.min(ACK_STREAM_MAX_WINDOW, pane.windowBytes + acked);
      this.totalWindowBytes = Math.min(ACK_TOTAL_MAX_WINDOW, this.totalWindowBytes + acked);
      pane.inFlightBytes -= acked;
      this.totalInFlightBytes = Math.max(0, this.totalInFlightBytes - acked);
    }
    if (pane.overflowed && !pane.recovering && pane.inFlightBytes === 0) {
      this._triggerOverflow(paneId, pane);
    }
    this.drain();
    return acked;
  }

  drain() {
    const keys = [...this.panes.keys()];
    if (!keys.length) return 0;
    let drained = 0;
    let start = this.cursorIndex % keys.length;
    while (true) {
      let progress = false;
      for (let step = 0; step < keys.length; step++) {
        const idx = (start + step) % keys.length;
        const paneId = keys[idx];
        const pane = this.panes.get(paneId);
        if (!pane || !pane.pending.length) continue;
        const head = pane.pending[0];
        if (!this._canAdmit(pane, paneId, head.bytes)) continue;
        pane.pending.shift();
        pane.pendingBytes = Math.max(0, pane.pendingBytes - head.bytes);
        this._emit(pane, paneId, head.frame, head.bytes, true, head.rawPayload);
        drained += 1;
        progress = true;
        this.cursorIndex = (idx + 1) % keys.length;
      }
      if (!progress) break;
      start = this.cursorIndex % keys.length;
    }
    return drained;
  }

  resetPane(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    this._clearOverflowTimer(pane);
    this.totalInFlightBytes = Math.max(0, this.totalInFlightBytes - pane.inFlightBytes);
    pane.inFlightBytes = 0;
    pane.pending.length = 0;
    pane.pendingBytes = 0;
    pane.overflowed = false;
    pane.recovering = false;
    pane.sentSamples.length = 0;
    pane.syncLatch = INITIAL_SYNC_LATCH;
  }

  removePane(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    this._clearOverflowTimer(pane);
    this.totalInFlightBytes = Math.max(0, this.totalInFlightBytes - pane.inFlightBytes);
    this.panes.delete(paneId);
  }

  dispose() {
    for (const pane of this.panes.values()) {
      this._clearOverflowTimer(pane);
    }
    this.panes.clear();
    this.totalInFlightBytes = 0;
  }
}
