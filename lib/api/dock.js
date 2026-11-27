import { Router } from 'express';
import { requireSameOrigin } from './same-origin.js';

function sendError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({ success: false, data: null, error: err?.message || 'Internal error' });
}

function clientIdOf(req) {
  const value = req.body && typeof req.body.clientId === 'string' ? req.body.clientId.trim() : '';
  return value && value.length <= 128 ? value : null;
}

/**
 * REST routes for server-persisted dock state (`/api/dock`).
 */
export function createDockRouter({ store, getWorkspace = null, tmux = null, onChange = null }) {
  const router = Router();
  router.use(requireSameOrigin);

  router.get('/', async (req, res) => {
    try {
      const instanceId = await tmux?.getServerInstance?.().catch(() => null);
      if (instanceId) await store.setServerInstance(instanceId);

      const workspaceSvc = typeof getWorkspace === 'function' ? getWorkspace() : getWorkspace;
      if (workspaceSvc && typeof workspaceSvc.getWorkspace === 'function') {
        const ws = await workspaceSvc.getWorkspace().catch(() => null);
        if (ws && ws.complete === true && typeof ws.instanceId === 'string' && ws.instanceId) {
          const live = new Set();
          const metaById = new Map();
          for (const session of ws.sessions || []) {
            for (const win of session.windows || []) {
              if (!win || typeof win.id !== 'string') continue;
              live.add(win.id);
              metaById.set(win.id, {
                sessionName: session.name || '',
                windowIndex: win.index ?? null,
                windowName: win.name || '',
              });
            }
          }
          await store.sweepLiveWindows(ws.instanceId, live, metaById);
        }
      }

      const windowId = typeof req.query.windowId === 'string' ? req.query.windowId : null;
      res.json({ success: true, data: store.getSnapshot({ windowId }), error: null });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/windows/:windowId/ops', async (req, res) => {
    try {
      const { windowId } = req.params;
      const body = req.body || {};
      const originClientId = clientIdOf(req);
      const result = await store.applyWindowOp(windowId, body.op, {
        instanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
        sessionName: typeof body.sessionName === 'string' ? body.sessionName : undefined,
        windowIndex: body.windowIndex,
        windowName: typeof body.windowName === 'string' ? body.windowName : undefined,
        clientId: originClientId,
      });
      if (result.changed && typeof onChange === 'function') {
        onChange({
          type: 'dock-changed',
          scope: 'window',
          windowId,
          instanceId: result.instanceId,
          revision: result.revision,
          originClientId,
          window: result.window,
        });
      }
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/server-blocks/ops', async (req, res) => {
    try {
      const body = req.body || {};
      const originClientId = clientIdOf(req);
      const result = await store.applyServerBlockOp(body.op, { clientId: originClientId });
      if (result.changed && typeof onChange === 'function') {
        onChange({
          type: 'dock-changed',
          scope: 'server-blocks',
          instanceId: result.instanceId,
          revision: result.revision,
          originClientId,
          serverBlocks: result.serverBlocks,
        });
      }
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/notices/ops', async (req, res) => {
    try {
      const body = req.body || {};
      const originClientId = clientIdOf(req);
      const result = await store.applyNoticeOp(body.op, { clientId: originClientId });
      if (result.changed && typeof onChange === 'function') {
        onChange({
          type: 'dock-changed',
          scope: 'notices',
          instanceId: result.instanceId,
          revision: result.revision,
          originClientId,
          notices: result.notices,
        });
      }
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/import', async (req, res) => {
    try {
      const body = req.body || {};
      const originClientId = clientIdOf(req);
      const result = await store.importLegacy(body);
      if (result.changed && typeof onChange === 'function') {
        onChange({
          type: 'dock-changed',
          scope: 'all',
          instanceId: result.instanceId,
          revision: result.revision,
          originClientId,
        });
      }
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
