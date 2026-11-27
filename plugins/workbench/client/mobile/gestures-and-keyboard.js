// Frame-rate-independent 120Hz EMA momentum scrolling, pinch-to-reflow sizing,
// and cursor/footer keyboard avoidance lift for mobile terminals.
// Ported from stablyai/orca (MIT).

export const RELEASE_VELOCITY_MAX_AGE_MS = 100;
export const MOMENTUM_FRICTION_PER_16MS = 0.945;
export const MOMENTUM_MIN_VEL = 0.025;

/** Smooth EMA velocity estimator avoiding single-frame mobile touch cadence spikes. */
export function smoothTouchVelocity(prevVel, deltaY, dtMs) {
  if (!(dtMs > 0)) return prevVel || 0;
  const inst = deltaY / dtMs;
  if (!Number.isFinite(inst)) return prevVel || 0;
  return !prevVel ? inst : prevVel * 0.55 + inst * 0.45;
}

/**
 * Frame-rate-independent momentum runner (handles 60Hz, 90Hz, and 120Hz ProMotion displays evenly).
 */
export function startMomentumScroll({
  globalObj = globalThis,
  initialVelocity,
  lastMoveTime,
  cellHeight,
  onScrollLines,
  isDisposed = () => false,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  nowEpoch = Date.now,
}) {
  if (nowEpoch() - lastMoveTime > RELEASE_VELOCITY_MAX_AGE_MS) {
    return () => {};
  }
  let vel = initialVelocity;
  if (!Number.isFinite(vel) || Math.abs(vel) <= MOMENTUM_MIN_VEL) {
    return () => {};
  }
  if (typeof globalObj.requestAnimationFrame !== 'function') {
    return () => {};
  }
  let rafId = null;
  let carry = 0;
  let lastFrameTime = now();
  let stopped = false;

  const step = (frameTime) => {
    if (stopped || isDisposed()) {
      rafId = null;
      return;
    }
    const ts = Number.isFinite(frameTime) ? frameTime : now();
    const elapsed = Math.max(1, Math.min(50, ts - lastFrameTime));
    lastFrameTime = ts;
    vel *= MOMENTUM_FRICTION_PER_16MS ** (elapsed / 16);
    if (Math.abs(vel) < MOMENTUM_MIN_VEL) {
      rafId = null;
      return;
    }
    carry += vel * elapsed;
    const h = Math.max(8, cellHeight || 18);
    const lines = Math.trunc(carry / h);
    if (lines !== 0) {
      carry -= lines * h;
      onScrollLines(lines);
    }
    rafId = globalObj.requestAnimationFrame(step);
  };

  rafId = globalObj.requestAnimationFrame(step);
  return () => {
    stopped = true;
    if (rafId != null) {
      globalObj.cancelAnimationFrame?.(rafId);
      rafId = null;
    }
  };
}

/**
 * Compute snapped integer font size after a mobile pinch-to-zoom gesture.
 */
export function resolvePinchTargetFontSize(baseFontSize, userScale, { min = 11, max = 22 } = {}) {
  const scaled = Math.round((Number(baseFontSize) || 13) * (Number(userScale) || 1));
  return Math.max(min, Math.min(max, scaled));
}

/**
 * Compute vertical lift (px) needed so the soft keyboard does not cover the active
 * terminal cursor or bottom TUI footer row.
 */
export function computeActiveTerminalKeyboardLift({
  keyboardLift,
  rows,
  cursorY,
  contentBottomRow,
  rowPitch,
  terminalFrameHeight,
  altScreen = false,
}) {
  if (!(keyboardLift > 0)) return 0;
  if (!(rows > 0) || !(terminalFrameHeight > 0)) return keyboardLift;
  const dockTop = terminalFrameHeight - keyboardLift;
  const anchorRow = Math.max(cursorY || 0, contentBottomRow ?? cursorY ?? 0);
  const anchorOverflow = (h) => Math.max(0, (anchorRow + 1) * h + h - dockTop);

  if (rowPitch && rows * rowPitch < terminalFrameHeight - rowPitch) {
    const drawnHidden = rows * rowPitch - dockTop;
    if (drawnHidden <= 0) return 0;
    const hidden = Math.min(keyboardLift, drawnHidden);
    return altScreen ? hidden : Math.min(hidden, anchorOverflow(rowPitch));
  }
  if (altScreen) return keyboardLift;
  const rowHeight = terminalFrameHeight / rows;
  return Math.min(keyboardLift, anchorOverflow(rowHeight));
}
