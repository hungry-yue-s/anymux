import { Router } from 'express';
import { handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';

export function createAutomationsRouter(service) {
  const router = Router();

  router.get('/', handle(() => ({ jobs: service.list() })));

  router.post('/', requireSameOrigin, handle(async (req, res) => {
    const job = await service.create(req.body);
    res.status(201);
    return { job };
  }));

  router.patch('/:id', requireSameOrigin, handle(async (req) => ({
    job: await service.update(req.params.id, req.body),
  })));

  router.delete('/:id', requireSameOrigin, handle(async (req) => service.remove(req.params.id)));

  router.post('/:id/run', requireSameOrigin, handle(async (req) => ({
    run: await service.runNow(req.params.id),
  })));

  router.get('/:id/runs', handle((req) => ({
    runs: service.runs(req.params.id),
  })));

  return router;
}
