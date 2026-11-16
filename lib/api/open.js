import { Router } from 'express';
import { spawn } from 'node:child_process';
import { requireSameOrigin } from './same-origin.js';
import { classifyDoc } from '../agent-docs/profiles.js';
import { pathSpace } from '../agent-docs/project.js';

// `anymux open <file|url>` from a pane: asks every browser watching this machine
// to preview the file (or show the page in the browser block). Also runs a
// notebook through Jupyter for the notebook block.
//
// `--dock` (placement 'dock') asks for the side panel instead of a modal: the
// page puts it there only while it shows that pane's window, without taking
// focus (see files-commands.js). `activate: false` adds the tab behind the
// current one, `replaces` swaps the tab of a draft that moved into the project,
// `fragment` is a Markdown heading to scroll to.

const NOTEBOOK_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_RE = /^[a-z0-9][\w.-]{0,39}$/i;

function fail(res, status, error) {
  res.status(status).json({ success: false, data: null, error });
}

/** The dock fields of an open request, checked; an `error` when one is malformed. */
function dockOptions(body, path) {
  const { placement, activate, replaces, fragment, kind, owner } = body;
  if (placement != null && placement !== 'dock' && placement !== 'modal') return { error: 'invalid_placement' };
  if (activate != null && typeof activate !== 'boolean') return { error: 'invalid_activate' };
  if (kind != null && (typeof kind !== 'string' || !TOKEN_RE.test(kind))) return { error: 'invalid_kind' };
  if (owner != null && (typeof owner !== 'string' || !TOKEN_RE.test(owner))) return { error: 'invalid_owner' };
  if (fragment != null && (typeof fragment !== 'string' || fragment.length > 200 || /[\x00-\x1f\x7f]/.test(fragment))) {
    return { error: 'invalid_fragment' };
  }
  let replaced = null;
  if (replaces != null) {
    if (typeof replaces !== 'string' || replaces.length > 4096 || /[\x00-\x1f]/.test(replaces)) return { error: 'invalid_replaces' };
    // The CLI sends it absolute; a relative path would resolve against the panel's cwd.
    const absolute = pathSpace.toApi(replaces);
    if (!absolute.startsWith('/')) return { error: 'invalid_replaces' };
    replaced = pathSpace.resolve(absolute);
  }
  const profile = classifyDoc(path);
  const options = {};
  if (placement === 'dock') {
    options.placement = 'dock';
    options.activate = activate ?? (profile ? profile.open !== 'background' : true);
  }
  if (replaced && replaced !== path) options.replaces = replaced;
  if (fragment) options.fragment = fragment;
  if (kind || profile) options.kind = kind || profile.kind;
  if (owner || profile) options.owner = owner || profile.owner;
  return { options };
}

export function createOpenRouter({ pathGuard, broadcast }) {
  const router = Router();

  // The CLI calls this with the node token from the pairing file, so there is
  // no browser Origin to check.
  router.post('/', async (req, res) => {
    try {
      const body = req.body || {};
      const { path, url, paneId } = body;
      if (paneId != null && (typeof paneId !== 'string' || !/^%\d+$/.test(paneId))) return fail(res, 400, 'invalid_pane');
      if (typeof url === 'string' && url) {
        if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 4096) return fail(res, 400, 'invalid_url');
        broadcast({ type: 'open-url', url, paneId: paneId || null });
        return res.json({ success: true, data: { url }, error: null });
      }
      const target = await pathGuard.resolve(path, paneId);
      if (target.error) return fail(res, target.status, target.error);
      const dock = dockOptions(body, target.linkPath);
      if (dock.error) return fail(res, 400, dock.error);
      broadcast({ type: 'open-file', path: target.linkPath, paneId: paneId || null, ...dock.options });
      return res.json({ success: true, data: { path: target.linkPath, ...dock.options }, error: null });
    } catch (error) {
      return fail(res, 500, error.message);
    }
  });

  return router;
}

export function createNotebookRouter({ pathGuard, run = runJupyter }) {
  const router = Router();
  router.use(requireSameOrigin);

  router.post('/execute', async (req, res) => {
    try {
      const target = await pathGuard.resolve((req.body || {}).path);
      if (target.error) return fail(res, target.status, target.error);
      if (!target.stat.isFile() || !/\.ipynb$/i.test(target.linkPath)) return fail(res, 400, 'not_a_notebook');
      const result = await run(target.nativePath);
      if (!result.ok) return fail(res, result.status || 400, result.error);
      return res.json({ success: true, data: { path: target.linkPath }, error: null });
    } catch (error) {
      return fail(res, 500, error.message);
    }
  });

  return router;
}

export function runJupyter(file) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('jupyter', ['nbconvert', '--to', 'notebook', '--execute', '--inplace', file], {
        windowsHide: true,
        env: process.env,
      });
    } catch {
      resolve({ ok: false, status: 501, error: 'jupyter_not_installed' });
      return;
    }
    const err = [];
    const timer = setTimeout(() => child.kill(), NOTEBOOK_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: error.code === 'ENOENT' ? 501 : 500, error: error.code === 'ENOENT' ? 'jupyter_not_installed' : error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else {
        const text = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-12).join('\n');
        resolve({ ok: false, status: 400, error: text || `jupyter exited with ${code}` });
      }
    });
  });
}
