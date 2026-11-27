import express from 'express';
import { join } from 'node:path';
import { handle } from '../../lib/servers/errors.js';
import { requireSameOrigin } from '../../lib/api/same-origin.js';
import { OrchestrationService } from '../../lib/orchestration/service.js';

export const name = 'orchestration';

export const inject = ['http', 'launch'];

export function createOrchestrationRouter(getService) {
  const router = express.Router();

  router.get('/runs', handle(() => ({ runs: getService().listRuns() })));

  router.post('/runs', requireSameOrigin, handle((req, res) => {
    res.status(201);
    return getService().createRun(req.body || {});
  }));

  router.get('/runs/:id', handle((req) => getService().getRun(req.params.id)));

  router.get('/runs/:id/ready', handle((req) => ({
    tasks: getService().readyTasks(req.params.id),
  })));

  router.post('/tasks/:id/lease', requireSameOrigin, handle((req) => ({
    lease: getService().acquireLease(req.params.id, req.body || {}),
  })));

  router.post('/tasks/:id/heartbeat', requireSameOrigin, handle((req) => ({
    lease: getService().heartbeatLease(req.params.id, req.body?.holderId, req.body?.ttlMs),
  })));

  router.post('/tasks/:id/complete', requireSameOrigin, handle((req) => getService().completeTask(req.params.id, req.body || {})));

  return router;
}

export function apply(ctx) {
  let service = null;
  ctx.effect(() => {
    service = new OrchestrationService({ dbPath: join(ctx.launch.configDir, 'orchestration.sqlite') });
    return () => {
      service?.close();
      service = null;
    };
  }, 'orchestration.db');

  ctx.http.mount('/api/orchestration', createOrchestrationRouter(() => service));
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
