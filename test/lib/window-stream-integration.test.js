/** Opt-in real tmux integration tests for multi-pane /ws/window-stream. Never touches default server. */
import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { createTmuxApi } from '../../lib/tmux.js';
import { WorkspaceService } from '../../lib/workspace/service.js';
import { ControlProcess } from '../../lib/terminal/control-process.js';
import { ControlPool } from '../../lib/terminal/control-pool.js';
import { WindowStreamGateway } from '../../lib/terminal/window-gateway.js';
import { decodeBinaryFrame } from '../../lib/terminal/window-protocol.js';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';
import { adoptLegacyEnv } from '../../lib/legacy-names.js';

const binary = adoptLegacyEnv({ ...process.env }).ANYMUX_CONTROL_TEST_TMUX;
const exec = promisify(execFile);
const env = { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' };
delete env.TMUX; delete env.TMUX_PANE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, predicate, limit = 8000) {
  const began = Date.now();
  while (Date.now() - began < limit) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(15);
  }
  throw new Error('Window-stream integration condition timed out');
}

async function fixture(program, { border = 'top', cols = 120, rows = 36 } = {}) {
  const dir = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'anymux-win-')));
  const socket = join(dir, 'sock');
  const run = async args => (await exec(binary, ['-S', socket, ...args], { env, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const script = join(dir, 'program.cjs');
  await writeFile(script, program);
  const config = join(dir, 'tmux.conf');
  await writeFile(config, `set -g history-limit 4000\nset -g pane-border-status ${border}\n`);
  await run(['-f', config, 'new-session', '-d', '-s', 'win-integration', '-x', String(cols), '-y', String(rows), process.execPath, script]);
  const readIdentity = async () => parsePrivateTmuxIdentity(await run(['display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT]), socket);
  const identity = await readIdentity();
  const tmux = createTmuxApi({ id: 'private-win-test', tmuxBin: binary, transport: 'local', exec: async (_f, args) => ({ stdout: await run(args), stderr: '' }) });
  const workspace = new WorkspaceService({ tmux });
  const instanceId = (await run(['display-message', '-p', '#{pid}:#{start_time}'])).trim();
  const [sessionId, windowId, paneId] = (await run(['display-message', '-p', '#{session_id}|#{window_id}|#{pane_id}'])).trim().split('|');
  const pool = new ControlPool({
    tmux,
    workspace,
    args: ['-S', socket],
    env,
    outputBatchMs: 2,
    createControl: options => new ControlProcess({ ...options, spawn: (_f, args, opts) => spawn(binary, args, opts) }),
  });
  return {
    dir, socket, run, pool, tmux, workspace, instanceId, sessionId, windowId, paneId,
    target: { instanceId, sessionId, windowId },
    cleanup: async primaryError => {
      pool.dispose();
      await sleep(30);
      await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run(['kill-server']), primaryError });
    },
  };
}

function spawnExternalClient(socket, sessionId) {
  const child = spawn(binary, ['--panel-pty', '80x24', '-S', socket, '-N', '-u', 'attach-session', '-t', sessionId], {
    env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdout.on('data', () => {});
  return {
    child,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.destroy();
        child.kill('SIGTERM');
        await new Promise(resolve => {
          const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 1000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    },
  };
}

describe.skipIf(!binary || !existsSync(binary) || process.platform === 'win32')('real tmux multi-pane window-stream integration', () => {
  it('multiplexes 3 concurrently bursting panes into continuous binary snapshot/output frames and replays cleanly in headless xterm', async () => {
    const prog = "const tag=process.env.P_TAG||'P';let i=0;setInterval(()=>process.stdout.write(`\\x1b[32m${tag}:`+String(++i).padStart(5,'0')+'\\x1b[0m\\r\\n'),4);";
    const f = await fixture(prog);
    let error;
    try {
      const p2 = (await f.run(['split-window', '-h', '-t', f.paneId, '-P', '-F', '#{pane_id}', `${process.execPath}`, '-e', "let i=0;setInterval(()=>process.stdout.write('B:'+String(++i).padStart(5,'0')+'\\r\\n'),4);"])).trim();
      const p3 = (await f.run(['split-window', '-v', '-t', p2, '-P', '-F', '#{pane_id}', `${process.execPath}`, '-e', "let i=0;setInterval(()=>process.stdout.write('C:'+String(++i).padStart(5,'0')+'\\r\\n'),4);"])).trim();
      await until(() => f.run(['capture-pane', '-S', '-200', '-p', '-t', f.paneId]), text => /P:\d{5}/.test(text));
      await until(() => f.run(['capture-pane', '-S', '-200', '-p', '-t', p2]), text => /B:\d{5}/.test(text));
      await until(() => f.run(['capture-pane', '-S', '-200', '-p', '-t', p3]), text => /C:\d{5}/.test(text));

      const decoded = [];
      const lease = await f.pool.subscribeWindow(f.target, frame => decoded.push(Buffer.isBuffer(frame) ? decodeBinaryFrame(frame) : frame));

      const waitOutputs = paneId => until(() => {
        const outs = decoded.filter(m => m.kind === 'output' && m.paneId === paneId);
        return outs.length >= 10 ? outs : null;
      }, Boolean);

      const outs1 = await waitOutputs(f.paneId);
      const outs2 = await waitOutputs(p2);
      const outs3 = await waitOutputs(p3);

      expect(decoded.find(m => m.type === 'ready')).toMatchObject({ sizeLease: 'owner', inputAllowed: true });
      const layout = decoded.find(m => m.type === 'layout');
      expect(layout.panes.map(p => p.id).sort()).toEqual([f.paneId, p2, p3].sort());
      expect(layout.tree.type).toBe('split');

      const { Terminal } = headless;
      for (const [paneId, outs, prefix] of [[f.paneId, outs1, 'P'], [p2, outs2, 'B'], [p3, outs3, 'C']]) {
        const snap = decoded.find(m => m.kind === 'snapshot' && m.paneId === paneId);
        expect(snap.seq).toBe(0);
        for (let i = 0; i < outs.length; i++) expect(outs[i].seq).toBe(i + 1);

        const term = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true });
        await new Promise(resolve => term.write(snap.data, resolve));
        const liveBuf = Buffer.concat(outs.map(o => o.data));
        await new Promise(resolve => term.write(liveBuf, resolve));

        const snapTicks = [...snap.data.toString().matchAll(new RegExp(`${prefix}:(\\d{5})`, 'g'))].map(m => Number(m[1]));
        const liveTicks = [...liveBuf.toString().matchAll(new RegExp(`${prefix}:(\\d{5})`, 'g'))].map(m => Number(m[1]));
        expect(snapTicks.length).toBeGreaterThan(0);
        expect(liveTicks[0]).toBe(Math.max(...snapTicks) + 1);
        for (let i = 1; i < liveTicks.length; i++) expect(liveTicks[i]).toBe(liveTicks[i - 1] + 1);
        term.dispose();
      }

      // pause-after=2 should be active on control client
      const flags = await f.run(['list-clients', '-F', '#{client_flags}']);
      expect(flags).toContain('pause-after');

      lease.close();
    } catch (err) { error = err; throw err; } finally { await f.cleanup(error); }
  }, 25_000);

  it('switches active pane without spurious snapshots, converges 1:1 on resizeWindow with border, zooms, and swaps sizes cleanly', async () => {
    const f = await fixture('setInterval(()=>{},1000);');
    let error;
    try {
      const p2 = (await f.run(['split-window', '-h', '-t', f.paneId, '-P', '-F', '#{pane_id}', process.execPath, '-e', 'setInterval(()=>{},1000)'])).trim();
      const frames = [];
      const lease = await f.pool.subscribeWindow(f.target, frame => frames.push(Buffer.isBuffer(frame) ? decodeBinaryFrame(frame) : frame));
      const snapCountAfterStart = frames.filter(m => m.kind === 'snapshot').length;
      expect(snapCountAfterStart).toBe(2);

      // Focus switch emits layout update with 0 snapshots
      await lease.selectPane(f.paneId);
      expect(frames.filter(m => m.type === 'layout').at(-1).activePaneId).toBe(f.paneId);
      expect(frames.filter(m => m.kind === 'snapshot')).toHaveLength(snapCountAfterStart);

      // Zoom toggle updates layout zoomed flag and resizes panes
      await lease.zoomPane(p2, true);
      expect(frames.filter(m => m.type === 'layout').at(-1)).toMatchObject({ zoomed: true, activePaneId: p2 });
      await lease.zoomPane(p2, false);
      expect(frames.filter(m => m.type === 'layout').at(-1).zoomed).toBe(false);

      // Window resize 1:1 with pane-border-status top converges cleanly (no 32->33 oscillation!)
      await lease.resizeWindow(110, 32);
      expect((await f.run(['display-message', '-p', '-t', f.windowId, '#{window_width}|#{window_height}'])).trim()).toBe('110|32');
      await sleep(80);
      const snapsNow = frames.filter(m => m.kind === 'snapshot').length;
      expect(await lease.resizeWindow(110, 32)).toBe(true);
      expect(frames.filter(m => m.kind === 'snapshot')).toHaveLength(snapsNow);

      // Split bottom-right pane vertically to test 3-pane T-junction resizePaneBatch atomically against real tmux
      const p3 = (await f.run(['split-window', '-v', '-t', p2, '-P', '-F', '#{pane_id}', process.execPath, '-e', 'setInterval(()=>{},1000)'])).trim();
      await until(() => frames.filter(m => m.type === 'layout').at(-1), l => l?.panes?.length === 3);
      expect(await lease.resizePaneBatch([{ paneId: f.paneId, cols: 48 }, { paneId: p2, rows: 14 }])).toBe(true);
      const batchLayout = await until(
        () => frames.filter(m => m.type === 'layout').at(-1),
        l => l?.panes?.find(p => p.id === f.paneId)?.width === 48 && l?.panes?.find(p => p.id === p2)?.height === 14,
      );
      expect(batchLayout.panes.find(p => p.id === p3)).toBeTruthy();

      lease.close();
    } catch (err) { error = err; throw err; } finally { await f.cleanup(error); }
  }, 25_000);

  it('tracks external clients in follow-foreign (input still works), grants takeover, and auto-revokes when a second external client attaches', async () => {
    const f = await fixture("process.stdin.on('data',d=>process.stdout.write('IN:'+d.toString()));");
    let error;
    const external = [];
    try {
      const ext1 = spawnExternalClient(f.socket, f.sessionId);
      external.push(ext1);
      await until(() => f.run(['list-clients', '-F', '#{client_tty}']), out => out.includes('/dev/'));

      const frames = [];
      const lease = await f.pool.subscribeWindow(f.target, frame => frames.push(Buffer.isBuffer(frame) ? decodeBinaryFrame(frame) : frame));
      expect(frames[0]).toMatchObject({ sizeLease: 'follow-foreign', inputAllowed: true, foreignClient: true });
      expect(await lease.resizeWindow(100, 30)).toBe(false);

      // Input still works while follow-foreign!
      expect(await lease.input(f.paneId, 'hello_lease\r')).toBe(true);
      await until(() => f.run(['capture-pane', '-p', '-t', f.paneId]), out => out.includes('IN:hello_lease'));

      // Explicit takeover grants resize
      expect(await lease.takeover()).toBe(true);
      expect(frames.filter(m => m.type === 'ready').at(-1).sizeLease).toBe('owner');
      expect(await lease.resizeWindow(100, 30)).toBe(true);

      // 2nd external client triggers %client-session-changed and immediately revokes takeover
      const ext2 = spawnExternalClient(f.socket, f.sessionId);
      external.push(ext2);
      await until(
        () => frames.filter(m => m.type === 'ready').at(-1),
        ready => ready.sizeLease === 'follow-foreign' && ready.foreignClient === true,
      );

      lease.close();
    } catch (err) { error = err; throw err; } finally {
      await Promise.all(external.map(c => c.close()));
      await f.cleanup(error);
    }
  }, 25_000);

  it('disconnects a slow WebSocket subscriber (1013) without affecting a healthy sibling subscriber on the same window', async () => {
    const f = await fixture("let i=0;setInterval(()=>process.stdout.write('S:'+String(++i)+'\\r\\n'),5);");
    let error;
    try {
      class FakeWs extends EventEmitter {
        constructor(slow = false) { super(); this.OPEN = 1; this.readyState = 1; this.bufferedAmount = slow ? 2 * 1024 * 1024 : 0; this.frames = []; }
        send(data) { this.frames.push(data); }
        close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
        ping() {}
      }
      const gw = new WindowStreamGateway({ pool: f.pool });
      const query = new URLSearchParams({ instanceId: f.instanceId, sessionId: f.sessionId, protocol: '1' });
      const healthy = new FakeWs(false);
      await gw.handle(healthy, `/ws/window-stream/${encodeURIComponent(f.windowId)}`, query);
      const slow = new FakeWs(true);
      await gw.handle(slow, `/ws/window-stream/${encodeURIComponent(f.windowId)}`, query);

      expect(slow.code).toBe(1013);
      const countBefore = healthy.frames.length;
      await until(() => healthy.frames.length, len => len > countBefore + 3);
      expect(healthy.readyState).toBe(1);
      healthy.close(1000);
    } catch (err) { error = err; throw err; } finally { await f.cleanup(error); }
  }, 20_000);
});
