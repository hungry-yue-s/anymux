/** Real private-socket tmux integration tests for rich panes (`@pane_kind` / `@pane_payload`). */
import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTmuxApi } from '../../lib/tmux.js';
import { WorkspaceService } from '../../lib/workspace/service.js';
import { ControlProcess } from '../../lib/terminal/control-process.js';
import { ControlPool } from '../../lib/terminal/control-pool.js';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';
import { adoptLegacyEnv } from '../../lib/legacy-names.js';

const binary = adoptLegacyEnv({ ...process.env }).ANYMUX_CONTROL_TEST_TMUX;
const exec = promisify(execFile);
const env = { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' };
delete env.TMUX;
delete env.TMUX_PANE;

async function startPrivateFixture() {
  const dir = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'anymux-rich-')));
  const socket = join(dir, 'sock');
  const run = async (args) => (await exec(binary, ['-S', socket, ...args], { env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const config = join(dir, 'tmux.conf');
  await writeFile(config, 'set -g history-limit 1000\n');
  await run(['-f', config, 'new-session', '-d', '-s', 'rich-test', '-x', '100', '-y', '30', process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  const readIdentity = async () => parsePrivateTmuxIdentity(await run(['display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT]), socket);
  const identity = await readIdentity();
  const tmux = createTmuxApi({
    id: 'private-rich-test',
    tmuxBin: binary,
    transport: 'local',
    exec: async (_f, args) => ({ stdout: await run(args), stderr: '' }),
  });
  const workspace = new WorkspaceService({ tmux });
  const instanceId = (await run(['display-message', '-p', '#{pid}:#{start_time}'])).trim();
  const [sessionId, windowId, paneId] = (await run(['display-message', '-p', '#{session_id}|#{window_id}|#{pane_id}'])).trim().split('|');
  const pool = new ControlPool({
    tmux,
    workspace,
    args: ['-S', socket],
    env,
    createControl: (options) => new ControlProcess({ ...options, spawn: (_f, args, opts) => spawn(binary, args, opts) }),
  });
  return {
    dir,
    socket,
    run,
    tmux,
    workspace,
    pool,
    instanceId,
    sessionId,
    windowId,
    paneId,
    cleanup: async (primaryError) => {
      pool.dispose();
      await new Promise((r) => setTimeout(r, 30));
      await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run(['kill-server']), primaryError });
    },
  };
}

describe.skipIf(!binary || !existsSync(binary))('tmux rich-pane integration', () => {
  it('creates rich panes via workspace/tmux APIs, reads them in readSnapshot & window-stream layout, and reverts to terminal', async () => {
    const fx = await startPrivateFixture();
    let error;
    try {
      const created = await fx.workspace.splitPane(fx.windowId, {
        paneId: fx.paneId,
        direction: 'horizontal',
        kind: 'browser',
        payload: { url: 'https://example.com' },
        label: 'Docs',
      });
      expect(created.id).toMatch(/^%\d+$/);
      expect(created.kind).toBe('browser');

      const wsTree = await fx.workspace.getWorkspace();
      const panes = wsTree.sessions[0].windows[0].panes;
      const richPane = panes.find((p) => p.id === created.id);
      expect(richPane).toMatchObject({ kind: 'browser', payload: '{"url":"https://example.com"}', label: 'Docs' });

      const resolved = await fx.pool.resolveWindow({ instanceId: fx.instanceId, sessionId: fx.sessionId, windowId: fx.windowId });
      expect(resolved.panes.find((p) => p.id === created.id)).toMatchObject({ kind: 'browser', payload: '{"url":"https://example.com"}' });

      const frames = [];
      const lease = await fx.pool.subscribeWindow(
        { instanceId: fx.instanceId, sessionId: fx.sessionId, windowId: fx.windowId },
        (frame) => frames.push(frame),
      );
      const layoutFrame = frames.find((f) => !Buffer.isBuffer(f) && f.type === 'layout');
      expect(layoutFrame.panes.find((p) => p.id === created.id)?.kind).toBe('browser');

      // Rich panes should NOT trigger binary 0x02 VT snapshot frames.
      const richPaneNum = Number(created.id.slice(1));
      const snapFramesForRich = frames.filter((f) => Buffer.isBuffer(f) && f.readUInt8(0) === 0x02 && f.readUInt32BE(1) === richPaneNum);
      expect(snapFramesForRich).toEqual([]);

      await fx.workspace.updatePane(created.id, { kind: 'terminal' });
      const resolvedAfter = await fx.pool.resolveWindow({ instanceId: fx.instanceId, sessionId: fx.sessionId, windowId: fx.windowId });
      expect(resolvedAfter.panes.find((p) => p.id === created.id)).toMatchObject({ kind: 'terminal', payload: '' });
      lease.close();
    } catch (err) {
      error = err;
      throw err;
    } finally {
      await fx.cleanup(error);
    }
  });

  it('renders SSH fallback card via rich-pane.patch when tmux exposes rich_pane_version=1', async () => {
    const fx = await startPrivateFixture();
    let error;
    try {
      const cap = await fx.pool.richPaneCapability();
      if (!cap.available) return;

      const richId = await fx.tmux.splitRichPane(fx.paneId, {
        direction: 'horizontal',
        kind: 'browser',
        payload: 'https://anymux.local/preview',
      });
      const vars = (await fx.run(['display-message', '-p', '-t', richId, '#{pane_kind}|#{pane_payload}|#{rich_pane_version}'])).trim();
      expect(vars).toBe('browser|https://anymux.local/preview|1');

      const screen = await fx.tmux.capturePane(richId);
      expect(screen).toContain('[ANYMUX] browser');
      expect(screen).toContain('https://anymux.local/preview');
      expect(screen).toContain('Open in AnyMux Web UI');

      await fx.tmux.resizePaneTo(richId, { cols: 48, rows: 12 });
      const resizedScreen = await fx.tmux.capturePane(richId);
      expect(resizedScreen).toContain('[ANYMUX] browser');
    } catch (err) {
      error = err;
      throw err;
    } finally {
      await fx.cleanup(error);
    }
  });
});
