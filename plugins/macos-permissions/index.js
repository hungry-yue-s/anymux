// `ctx.macosPermissions`: inspects macOS Full Disk Access, helper-bundle TCC attribution,
// watches live TCC consent prompts, and exposes /api/macos-permissions for settings & nudges.
import { Router } from 'express';
import { requireSameOrigin } from '../../lib/api/same-origin.js';
import { AppError, ErrorCode, handle } from '../../lib/servers/errors.js';
import {
  inspectLiveTmuxAttribution,
  openPrivacySettings,
  probeFullDiskAccess,
  probeTmuxFullDiskAccess,
  resolveInstalledAppPathAsync,
  resolveInstalledTmuxPath,
  revealInFinder,
} from '../../lib/macos-permissions/probe.js';
import { MacosTccPromptWatch, TccPromptStore } from '../../lib/macos-permissions/tcc-prompt-watch.js';
import { TMUX_BIN } from '../../lib/msys.js';
import { REPO_ROOT } from '../../lib/paths.js';
import { isPrivateServer } from '../../lib/tmux-server.js';

export const name = 'macos-permissions';

export const inject = ['http', 'launch', 'tmux'];

export function createMacosPermissionsRouter({
  platform = process.platform,
  tmux,
  runtimePath = null,
  projectDir = REPO_ROOT,
  store,
  onDismiss,
  probeFda = probeFullDiskAccess,
  probeTmuxFda = probeTmuxFullDiskAccess,
  inspectAttribution = inspectLiveTmuxAttribution,
  openSettings = openPrivacySettings,
  reveal = revealInFinder,
} = {}) {
  const router = Router();
  router.use(requireSameOrigin);

  const tmuxRun = tmux?.run ? (args, opts) => tmux.run(args, opts) : null;

  router.get('/status', handle(async () => {
    if (platform !== 'darwin') {
      return {
        supported: false,
        platform,
        panelFda: 'unsupported',
        tmuxFda: 'unsupported',
        attribution: { supported: false, state: 'unsupported', livePid: null },
        appPath: null,
        tmuxInstalledPath: null,
        tccPrompt: {
          promptCount: 0,
          lastService: null,
          lastResponsible: null,
          lastAt: null,
          dismissed: false,
          nudgePending: false,
        },
      };
    }

    const [panelFda, tmuxFda, attribution] = await Promise.all([
      probeFda({ platform }),
      probeTmuxFda({ platform, tmuxRun }),
      inspectAttribution({ platform, tmuxBin: TMUX_BIN, runtimePath, tmuxRun, projectDir }),
    ]);

    const appPath = attribution.app?.path || await resolveInstalledAppPathAsync();
    const tmuxInstalledPath = attribution.installed?.path || resolveInstalledTmuxPath({ tmuxBin: TMUX_BIN, runtimePath });
    const promptState = store ? store.snapshot() : { promptCount: 0, lastService: null, lastResponsible: null, lastAt: null, dismissed: false };
    const nudgePending = !promptState.dismissed
      && promptState.promptCount > 0
      && (tmuxFda !== 'granted' || panelFda !== 'granted');

    return {
      supported: true,
      platform,
      panelFda,
      tmuxFda,
      attribution,
      appPath,
      tmuxInstalledPath,
      tccPrompt: {
        ...promptState,
        nudgePending,
      },
    };
  }));

  router.post('/open-settings', handle(async (req) => {
    const id = String(req.body?.id || 'full-disk-access').trim();
    return openSettings(id, { platform });
  }));

  router.post('/reveal', handle(async (req) => {
    const target = String(req.body?.target || 'app').trim();
    if (target === 'app') {
      const appPath = await resolveInstalledAppPathAsync();
      if (!appPath) throw new AppError(ErrorCode.NOT_FOUND, 'Anymux.app not found on this Mac');
      return reveal(appPath, { platform });
    }
    if (target === 'tmux') {
      const tmuxPath = resolveInstalledTmuxPath({ tmuxBin: TMUX_BIN, runtimePath });
      if (!tmuxPath) throw new AppError(ErrorCode.NOT_FOUND, 'Managed tmux binary not found');
      return reveal(tmuxPath, { platform });
    }
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Unsupported reveal target: ${target}`);
  }));

  router.post('/dismiss-nudge', handle(async () => {
    const next = store ? await store.dismiss() : { dismissed: true };
    onDismiss?.();
    return next;
  }));

  return router;
}

export async function apply(ctx) {
  const store = TccPromptStore.forConfigDir(ctx.launch.configDir);
  await store.load();

  let watch = null;
  let watchTimer = null;

  const stopWatch = () => {
    if (watchTimer) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
    watch?.stop();
    watch = null;
  };

  ctx.http.mount('/api/macos-permissions', createMacosPermissionsRouter({
    tmux: ctx.tmux,
    runtimePath: ctx.launch.runtimePath,
    projectDir: REPO_ROOT,
    store,
    onDismiss: stopWatch,
  }));

  ctx.effect(() => () => stopWatch(), 'macosPermissions.tccWatch');

  if (process.platform === 'darwin' && !isPrivateServer() && !store.snapshot().dismissed) {
    watchTimer = setTimeout(() => {
      watchTimer = null;
      watch = new MacosTccPromptWatch({
        onPrompt: (event) => {
          store.recordPrompt(event).catch(() => {});
        },
      });
      watch.start();
    }, 5000);
    watchTimer.unref?.();
  }

  ctx.inject(['ui'], (innerCtx) => innerCtx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
