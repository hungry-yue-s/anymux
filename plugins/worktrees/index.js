import { createWorktreesRouter } from '../../lib/api/worktrees.js';

export const name = 'worktrees';

export const inject = ['http', 'fileAccess', 'workspace', 'tmux', 'launch'];

export function apply(ctx) {
  ctx.http.mount('/api/worktrees', createWorktreesRouter({
    pathGuard: ctx.fileAccess.pathGuard,
    tmux: ctx.tmux,
    workspace: ctx.workspace,
    configDir: ctx.launch.configDir,
  }));
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
