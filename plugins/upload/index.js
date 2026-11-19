// Uploads (/api/upload): files dropped onto the page land in an
// installation-owned directory and are reported by the path a pane would use
// (an MSYS path on Windows), ready to paste into the terminal, and by the path
// native programs read (nativePath). On the page (client/js/terminal-upload.js)
// an image pasted into a terminal, or a file dropped on it, is uploaded to the
// pane's machine and its path pasted, which Claude Code and Codex attach.

import { join } from 'node:path';
import { IS_WINDOWS, toNativePath, toPosixPath } from '../../lib/msys.js';
import { createUploadRouter } from '../../lib/api/upload.js';

export const name = 'upload';

export const inject = ['launch', 'http'];

/** @param {{ dir?: string }} [config] */
export function apply(ctx, config) {
  const launch = ctx.launch;
  if (IS_WINDOWS) {
    const dir = config?.dir ?? toNativePath('/tmp/anymux-uploads');
    ctx.http.mount('/api/upload', createUploadRouter(dir, { displayPath: toPosixPath }), { json: false });
  } else {
    const dir = config?.dir ?? (launch.managedRuntime ? join(launch.configDir, 'uploads') : '/tmp/anymux-uploads');
    ctx.http.mount('/api/upload', createUploadRouter(dir), { json: false });
  }
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
