import { Router } from 'express';
import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { readSessionTranscript, scanSessions, summarizeVault } from '../session-vault/scanner.js';
import { indexSessionVault } from '../session-vault/indexer.js';
import { searchSessionVault } from '../session-vault/search.js';
import { buildHandoffPrompt } from '../session-vault/handoff.js';

export function createSessionVaultRouter(options = {}) {
  const router = Router();
  const { getVaultDb, vaultDb: fixedVaultDb, ...scanDefaults } = options;
  const resolveVaultDb = () => (typeof getVaultDb === 'function' ? getVaultDb() : fixedVaultDb) || null;
  let indexedOnce = false;

  async function ensureIndexed(force = false) {
    const db = resolveVaultDb();
    if (!db) return null;
    if (!force && indexedOnce) return db;
    await indexSessionVault(db, scanDefaults);
    indexedOnce = true;
    return db;
  }

  router.get('/sessions', handle(async (req) => {
    const sessions = await scanSessions({
      provider: typeof req.query.provider === 'string' ? req.query.provider : '',
      q: typeof req.query.q === 'string' ? req.query.q : '',
      cwd: typeof req.query.cwd === 'string' ? req.query.cwd : '',
      limit: req.query.limit ? Number(req.query.limit) : 50,
      ...scanDefaults,
    });
    return { sessions };
  }));

  router.get('/search', handle(async (req) => {
    const db = await ensureIndexed(false);
    if (!db) {
      const sessions = await scanSessions({
        provider: typeof req.query.provider === 'string' ? req.query.provider : '',
        q: typeof req.query.q === 'string' ? req.query.q : '',
        cwd: typeof req.query.cwd === 'string' ? req.query.cwd : '',
        limit: req.query.limit ? Number(req.query.limit) : 50,
        ...scanDefaults,
      });
      return {
        results: sessions.map((s) => ({ ...s, session_id: s.id, forkCount: 0 })),
        correctedQuery: null,
      };
    }
    return searchSessionVault(db, {
      q: typeof req.query.q === 'string' ? req.query.q : '',
      provider: typeof req.query.provider === 'string' ? req.query.provider : '',
      cwd: typeof req.query.cwd === 'string' ? req.query.cwd : '',
      limit: req.query.limit ? Number(req.query.limit) : 50,
      includeForks: req.query.includeForks === 'true',
    });
  }));

  router.post('/index', handle(async () => {
    const db = resolveVaultDb();
    if (!db) throw new AppError(ErrorCode.BAD_REQUEST, 'Session Vault 索引库未就绪');
    const stats = await indexSessionVault(db, scanDefaults);
    indexedOnce = true;
    return stats;
  }));

  router.get('/summary', handle(async () => summarizeVault(scanDefaults)));

  router.get('/sessions/:provider/:id/handoff', handle(async (req) => {
    const result = await readSessionTranscript(req.params.provider, req.params.id, {
      ...scanDefaults,
      maxTurns: req.query.maxTurns ? Number(req.query.maxTurns) : 120,
    });
    if (!result) throw new AppError(ErrorCode.NOT_FOUND, '未找到对应会话记录');
    const targetAgent = typeof req.query.target === 'string' ? req.query.target.trim() : '';
    return {
      session: result.session,
      targetAgent,
      prompt: buildHandoffPrompt({
        session: result.session,
        turns: result.turns,
        targetAgent,
      }),
    };
  }));

  router.get('/sessions/:provider/:id', handle(async (req) => {
    const result = await readSessionTranscript(req.params.provider, req.params.id, scanDefaults);
    if (!result) throw new AppError(ErrorCode.NOT_FOUND, '未找到对应会话记录');
    return result;
  }));

  return router;
}
