import { Router } from 'express';
import { handle, AppError, ErrorCode } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';
import { draftLocation as defaultDraftLocation } from '../agent-docs/project.js';
import { readDocInfo } from '../agent-docs/doc-info.js';

// /api/agent-docs: documents agents write for the side panel.
//
//   POST /draft  {cwd, name, ext}   where `anymux doc path` puts a draft
//   GET  /info   ?path&paneId       its kind and, for a draft, the suggested place
//   POST /reply  {paneId, text}     types a reply into the agent's pane, never Enter
//
// /draft is called by the CLI with the node token, like /api/open, so there is
// no browser Origin to check. /reply types into a terminal and only the page
// calls it.

const MAX_REPLY = 2000;
const MAX_PREFILL_BYTES = 16 * 1024;

export function createAgentDocsRouter({ pathGuard, roots, typeText, prefillText = null, getServerInstance = null, draftLocation = defaultDraftLocation }) {
  const router = Router();

  router.post('/draft', handle(async (req) => {
    const { cwd, name, ext } = req.body || {};
    return draftLocation({ cwd, name, ext, roots });
  }));

  router.get('/info', handle(async (req) => {
    const { path, paneId } = req.query;
    if (paneId != null && (typeof paneId !== 'string' || !/^%\d+$/.test(paneId))) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane');
    }
    const target = await pathGuard.resolve(path, paneId || undefined);
    if (target.error) throw new AppError(ErrorCode.VALIDATION_ERROR, target.error, { status: target.status });
    if (!target.stat.isFile()) return { path: target.linkPath, doc: null };
    return { path: target.linkPath, doc: await readDocInfo(target.linkPath, target.nativePath) };
  }));

  router.post('/reply', requireSameOrigin, handle(async (req) => {
    const { paneId, text, serverInstance } = req.body || {};
    if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane');
    if (typeof text !== 'string') throw new AppError(ErrorCode.VALIDATION_ERROR, 'Text is required');
    // One line: a newline would send it.
    const line = text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!line || line.length > MAX_REPLY || line.startsWith('-')) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid reply');
    if (serverInstance && typeof getServerInstance === 'function') {
      const liveInstance = await getServerInstance().catch(() => null);
      if (!liveInstance || liveInstance !== serverInstance) {
        throw new AppError(ErrorCode.PANE_NOT_FOUND, '原窗格所属 tmux 已重启，已阻止写入', { status: 409 });
      }
    }
    try {
      await typeText(paneId, line);
    } catch (error) {
      if (/can't find pane|no server running/i.test(error?.stderr || error?.message || '')) {
        throw new AppError(ErrorCode.PANE_NOT_FOUND, 'The pane is gone');
      }
      if (error?.code === 'PANE_IN_MODE') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '窗格正处于复制模式（滚动查看历史），先按 q 退出再试', { status: 409 });
      }
      throw error;
    }
    return { paneId, typed: line.length };
  }));

  router.post('/prefill', requireSameOrigin, handle(async (req) => {
    const { paneId, text, serverInstance } = req.body || {};
    if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane');
    if (typeof text !== 'string' || !text.trim()) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Text is required');
    // Sanitize raw ESC (0x1b -> U+241B) and non-whitespace control chars; NEVER send Enter.
    const sanitized = text.replace(/\x1b/g, '\u241b').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    const bytes = Buffer.byteLength(sanitized, 'utf8');
    if (!sanitized.trim() || bytes > MAX_PREFILL_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid prefill payload (max 16 KiB)');
    }
    if (serverInstance && typeof getServerInstance === 'function') {
      const liveInstance = await getServerInstance().catch(() => null);
      if (!liveInstance || liveInstance !== serverInstance) {
        throw new AppError(ErrorCode.PANE_NOT_FOUND, '原窗格所属 tmux 已重启，已阻止写入', { status: 409 });
      }
    }
    const writer = prefillText || typeText;
    try {
      await writer(paneId, prefillText ? sanitized : sanitized.replace(/[\r\n\t]+/g, ' ').trim());
    } catch (error) {
      if (/can't find pane|no server running/i.test(error?.stderr || error?.message || '')) {
        throw new AppError(ErrorCode.PANE_NOT_FOUND, 'The pane is gone');
      }
      if (error?.code === 'PANE_IN_MODE') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '窗格正处于复制模式（滚动查看历史），先按 q 退出再试', { status: 409 });
      }
      throw error;
    }
    return { paneId, prefilledBytes: bytes };
  }));

  return router;
}
