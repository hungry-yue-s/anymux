import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationStore } from '../../lib/notifications.js';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('NotificationStore serverInstance isolation', () => {
  it('stores serverInstance and invalidates prior-instance and pre-boot pane/agent notices on restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anymux-notif-'));
    tempDirs.push(dir);
    const store = new NotificationStore(join(dir, 'notifications.json'));

    const oldStamped = store.add({
      type: 'agent-event',
      state: 'waiting_attention',
      source: 'codex',
      session: 'work',
      windowIndex: 0,
      paneId: '%11',
      serverInstance: '1000:1795755000',
      reason: 'old instance',
    });

    const legacyPreBoot = store.add({
      type: 'agent-event',
      state: 'agent_stopped',
      source: 'antigravity',
      session: 'work',
      windowIndex: 1,
      paneId: '%12',
      reason: 'pre-boot without instanceId',
    });
    legacyPreBoot.timestamp = 1795755000 * 1000;

    const currentStamped = store.add({
      type: 'agent-event',
      state: 'waiting_attention',
      source: 'claude',
      session: 'work',
      windowIndex: 0,
      paneId: '%8',
      serverInstance: '2000:1795755662',
      reason: 'current instance',
    });

    const nonPaneNotice = store.add({
      type: 'system',
      session: 'work',
      windowIndex: 0,
      reason: 'non-pane notice',
    });
    nonPaneNotice.timestamp = 1795755000 * 1000;

    const changed = store.invalidateForServer('2000:1795755662');
    expect(changed).toBe(2);
    expect(oldStamped.stale).toBe(true);
    expect(oldStamped.read).toBe(true);
    expect(legacyPreBoot.stale).toBe(true);
    expect(legacyPreBoot.read).toBe(true);
    expect(currentStamped.stale).toBe(false);
    expect(currentStamped.read).toBe(false);
    expect(nonPaneNotice.stale).toBe(false);
    expect(nonPaneNotice.read).toBe(false);
  });
});
