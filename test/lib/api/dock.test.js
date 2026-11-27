import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockStore } from '../../../lib/dock/store.js';
import { createDockRouter } from '../../../lib/api/dock.js';
import { isRelayable } from '../../../lib/hub/proxy.js';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function setupApp({ workspace = null, instanceId = '100:1700000000' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anymux-dock-api-'));
  tempDirs.push(dir);
  const store = new DockStore(join(dir, 'dock-state.json'));
  const events = [];
  const app = express();
  app.use(express.json());
  app.use('/api/dock', createDockRouter({
    store,
    getWorkspace: () => workspace,
    tmux: { getServerInstance: async () => instanceId },
    onChange: (ev) => events.push(ev),
  }));
  return { app, store, events };
}

describe('/api/dock routes & Hub relay', () => {
  it('allows Hub relay for /api/dock routes', () => {
    expect(isRelayable('/api/dock')).toBe(true);
    expect(isRelayable('/api/dock/windows/@1/ops')).toBe(true);
    expect(isRelayable('/api/dock/server-blocks/ops')).toBe(true);
    expect(isRelayable('/api/dock/notices/ops')).toBe(true);
    expect(isRelayable('/api/dock/import')).toBe(true);
  });

  it('rejects cross-origin writes and invalid payloads', async () => {
    const { app, store } = setupApp();
    await store.load();

    const crossOrigin = await request(app)
      .post('/api/dock/windows/@1/ops')
      .set('Host', 'panel.test')
      .set('Origin', 'https://evil.test')
      .send({ op: { type: 'upsert-file', path: '/a.md' } });
    expect(crossOrigin.status).toBe(403);

    const badWindow = await request(app)
      .post('/api/dock/windows/invalid/ops')
      .send({ op: { type: 'upsert-file', path: '/a.md' } });
    expect(badWindow.status).toBe(400);
  });

  it('persists window ops, server-block ops, notice ops, sweeps live windows on GET, and emits dock-changed', async () => {
    let liveWindows = [{ id: '@1', index: 0, name: 'code' }, { id: '@2', index: 1, name: 'dead' }];
    const workspace = {
      getWorkspace: async () => ({
        provider: 'tmux',
        complete: true,
        instanceId: '100:1700000000',
        sessions: [{ id: '$1', name: 'work', windows: liveWindows }],
      }),
    };
    const { app, store, events } = setupApp({ workspace });
    await store.load();

    const winOp = await request(app)
      .post('/api/dock/windows/@1/ops')
      .send({
        instanceId: '100:1700000000',
        clientId: 'tab-a',
        op: { type: 'upsert-file', path: '/repo/README.md', paneId: '%1', activate: true },
      });
    expect(winOp.status).toBe(200);
    expect(winOp.body.data.changed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'dock-changed',
      scope: 'window',
      windowId: '@1',
      originClientId: 'tab-a',
    });

    await request(app)
      .post('/api/dock/windows/@2/ops')
      .send({ instanceId: '100:1700000000', op: { type: 'upsert-file', path: '/repo/dead.md' } });

    const sbOp = await request(app)
      .post('/api/dock/server-blocks/ops')
      .send({ clientId: 'tab-a', op: { type: 'upsert-block', kind: 'browser', persistKey: 'browser', params: { url: 'http://localhost:3000' } } });
    expect(sbOp.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: 'dock-changed', scope: 'server-blocks' });

    const noticeOp = await request(app)
      .post('/api/dock/notices/ops')
      .send({
        clientId: 'tab-a',
        op: { type: 'upsert', notice: { type: 'document', path: '/repo/README.md', target: { instanceId: '100:1700000000', windowId: '@1' } } },
      });
    expect(noticeOp.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: 'dock-changed', scope: 'notices' });

    // Remove @2 from live workspace; GET /api/dock sweeps @2 while keeping @1
    liveWindows = [{ id: '@1', index: 0, name: 'code' }];
    const snapshotRes = await request(app).get('/api/dock');
    expect(snapshotRes.status).toBe(200);
    expect(Object.keys(snapshotRes.body.data.windows)).toEqual(['@1']);
    expect(snapshotRes.body.data.serverBlocks.items).toHaveLength(1);
    expect(snapshotRes.body.data.notices).toHaveLength(1);
  });
});
