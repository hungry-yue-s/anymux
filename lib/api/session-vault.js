import { Router } from 'express';
import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { readSessionTranscript, scanSessions, summarizeVault } from '../session-vault/scanner.js';

export function createSessionVaultRouter(options = {}) {
  const router = Router();

  router.get('/sessions', handle(async (req) => {
    const sessions = await scanSessions({
      provider: typeof req.query.provider === 'string' ? req.query.provider : '',
      q: typeof req.query.q === 'string' ? req.query.q : '',
      cwd: typeof req.query.cwd === 'string' ? req.query.cwd : '',
      limit: req.query.limit ? Number(req.query.limit) : 50,
      ...options,
    });
    return { sessions };
  }));

  router.get('/summary', handle(async () => summarizeVault(options)));

  router.get('/sessions/:provider/:id', handle(async (req) => {
    const result = await readSessionTranscript(req.params.provider, req.params.id, options);
    if (!result) throw new AppError(ErrorCode.NOT_FOUND, '未找到对应会话记录');
    return result;
  }));

  return router;
}
