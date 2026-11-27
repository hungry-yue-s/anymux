import { Router } from 'express';

export function createAgentEventsRouter(agentEvents, { onNotifications = null, onEvent = null, validateEvent = null } = {}) {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ success: false, data: null, error: 'JSON object body required' });
      return;
    }

    let payload = body;
    if (typeof validateEvent === 'function') {
      try {
        const check = await validateEvent(body);
        if (check?.ignore) {
          res.json({
            success: true,
            data: {
              ignored: true,
              reason: check.reason || 'ignored',
              duplicate: false,
              event: null,
              notification: null,
            },
            error: null,
          });
          return;
        }
        if (check?.patch && typeof check.patch === 'object') {
          payload = { ...body, ...check.patch };
        }
      } catch {
        // Validation errors must not fail hook delivery silently inside client CLIs.
      }
    }

    const result = agentEvents.ingest(payload);
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
