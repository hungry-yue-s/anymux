import { Router } from 'express';
import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';
import { generateWorktreeSlug } from '../worktrees/naming.js';
import {
  checkRemoveWorktree,
  createWorktree,
  listWorktrees,
  removeWorktree,
} from '../worktrees/service.js';

async function resolveAllowedPath(pathGuard, inputPath, paneId) {
  const result = await pathGuard.resolve(inputPath || '.', paneId || undefined);
  if (result.error) throw new AppError(ErrorCode.VALIDATION_ERROR, result.error, { status: result.status || 400 });
  return result.nativePath;
}

export function createWorktreesRouter({ pathGuard, tmux, workspace, configDir = null }) {
  const router = Router();

  router.get('/', handle(async (req) => {
    const repoPath = await resolveAllowedPath(pathGuard, req.query.path, req.query.paneId);
    return listWorktrees({
      repoPath,
      workspace,
      includeLifecycle: req.query.lifecycle !== 'false',
    });
  }));

  router.get('/slug', handle(async (req) => ({
    slug: generateWorktreeSlug(String(req.query.seed || '')),
  })));

  router.post('/', requireSameOrigin, handle(async (req, res) => {
    const body = req.body || {};
    const repoPath = await resolveAllowedPath(pathGuard, body.path, body.paneId);
    const targetDir = body.targetDir ? await resolveAllowedPath(pathGuard, body.targetDir) : null;
    const created = await createWorktree({
      repoPath,
      branch: body.branch,
      name: body.name,
      autoName: body.autoName === true,
      baseRef: body.baseRef || null,
      createBranch: body.createBranch !== false,
      targetDir,
      sharedDirectories: body.sharedDirectories,
      openWindow: body.openWindow === true,
      sessionId: body.sessionId || null,
      configDir,
      tmux,
      workspace,
    });
    res.status(201);
    return created;
  }));

  router.post('/check-remove', requireSameOrigin, handle(async (req) => {
    const body = req.body || {};
    const repoPath = await resolveAllowedPath(pathGuard, body.path, body.paneId);
    const worktreePath = await resolveAllowedPath(pathGuard, body.worktreePath);
    return checkRemoveWorktree({ repoPath, worktreePath, baseBranch: body.baseBranch || null, workspace });
  }));

  router.delete('/', requireSameOrigin, handle(async (req) => {
    const body = req.body && Object.keys(req.body).length ? req.body : req.query;
    const repoPath = await resolveAllowedPath(pathGuard, body.path, body.paneId);
    const worktreePath = await resolveAllowedPath(pathGuard, body.worktreePath);
    return removeWorktree({
      repoPath,
      worktreePath,
      force: body.force === true || body.force === 'true',
      deleteBranch: body.deleteBranch === true || body.deleteBranch === 'true',
      baseBranch: body.baseBranch || null,
      configDir,
      workspace,
    });
  }));

  return router;
}
