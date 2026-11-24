import { Router } from 'express';

export function createAgentEventsRouter(agentEvents, { onNotifications = null, onEvent = null } = {}) {
  const router = Router();

  router.post('/', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ success: false, data: null, error: 'JSON object body required' });
      return;
    }

    const result = agentEvents.ingest(body);
    if (result.notification && typeof onNotifications === 'function') {
      onNotifications([result.notification]);
    }
    if (typeof onEvent === 'function') {
      try { Promise.resolve(onEvent(result)).catch(() => {}); } catch { /* background hook */ }
    }
    res.json({
      success: true,
      data: {
        duplicate: result.duplicate,
        event: result.event,
        notification: result.notification,
      },
      error: null,
    });
  });

  return router;
}
