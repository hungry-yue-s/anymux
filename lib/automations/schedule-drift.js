// Evaluate schedule drift after sleep/restart so missed cron slots catch up safely once.
// Ported from stablyai/orca (MIT).

export function evaluateScheduleDrift({
  lastRunAt = null,
  expectedRunAt = null,
  now = Date.now(),
  intervalMs = 60_000,
  graceMs = 60_000,
  maxMissed = 1,
} = {}) {
  if (!expectedRunAt || !Number.isFinite(expectedRunAt) || now <= expectedRunAt + graceMs) {
    return { missed: 0, shouldCatchUp: false, driftMs: Math.max(0, now - (expectedRunAt || now)) };
  }
  const driftMs = now - expectedRunAt;
  if (lastRunAt && lastRunAt >= expectedRunAt) {
    return { missed: 0, shouldCatchUp: false, driftMs };
  }
  const step = Math.max(1000, Number(intervalMs) || 60_000);
  const rawMissed = Math.max(1, Math.floor(driftMs / step));
  const missed = Math.min(Math.max(1, Number(maxMissed) || 1), rawMissed);
  return {
    missed,
    shouldCatchUp: true,
    driftMs,
  };
}
