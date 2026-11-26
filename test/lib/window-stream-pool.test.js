import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { ControlPool } from '../../lib/terminal/control-pool.js';
import { tmuxLayoutChecksum } from '../../lib/terminal/tmux-layout.js';
import { compactNativeSnapshot, decodeBinaryFrame } from '../../lib/terminal/window-protocol.js';

const SEP = '=:=';
const withChecksum = body => `${tmuxLayoutChecksum(body)},${body}`;

function makeWindowListOutput({ cols = 160, rows = 48, zoomed = false, activePaneId = '%3', panes = null } = {}) {
  const layoutBody = panes ? undefined : `${cols}x${rows},0,0{80x${rows},0,0,3,79x${rows},81,0,4}`;
  const defaultPanes = [
    { id: '%3', index: 0, x: 0, y: 0, width: 80, height: rows, command: 'zsh', label: 'left', cwd: '/repo/a' },
    { id: '%4', index: 1, x: 81, y: 0, width: 79, height: rows, command: 'claude', label: 'right', cwd: `/repo/with${SEP}sep` },
  ];
  const actualPanes = panes || defaultPanes;
  const body = layoutBody || (actualPanes.length === 1
    ? `${cols}x${rows},0,0,${actualPanes[0].id.slice(1)}`
    : `${cols}x${rows},0,0{${actualPanes.map(p => `${p.width}x${p.height},${p.x},${p.y},${p.id.slice(1)}`).join(',')}}`);
  const layout = withChecksum(body);
  const pLines = actualPanes.map(p => [
    'P', '99:100', '$1', '@2', '0', String(cols), String(rows), zoomed ? '1' : '0', layout,
    p.id, String(p.index), String(p.x), String(p.y), String(p.width), String(p.height),
    p.id === activePaneId ? '1' : '0', p.command, p.label,
  ].join(SEP));
  const dLines = actualPanes.map(p => ['D', p.id, p.cwd || ''].join(SEP));
  return [...pLines, ...dLines].join('\n') + '\n';
}

class FakeControl extends EventEmitter {
  constructor({ onSnapshot, dimsForPane } = {}) {
    super();
    this.commands = [];
    this.child = { pid: 999 };
    this.onSnapshot = onSnapshot;
    this.dimsForPane = dimsForPane;
  }
  async command(text, { onResult, blocks = 1, collect = false } = {}) {
    this.commands.push(text);
    if (text.includes('#{client_pid}')) {
      const bytes = Buffer.from('99:100|$1|441');
      onResult?.(bytes);
      return bytes;
    }
    if (text.startsWith('refresh-client -f ')) return Buffer.alloc(0);
    if (text.includes('capture-pane -Q -p -t ')) {
      const m = /capture-pane -Q -p -t (%\d+)/.exec(text);
      const paneId = m[1];
      this.onSnapshot?.(paneId, text);
      const dims = this.dimsForPane?.(paneId) || { cols: paneId === '%4' ? 79 : 80, rows: 48 };
      const snap = Buffer.from(JSON.stringify({
        version: 1,
        instanceId: '99:100',
        windowId: '@2',
        paneId,
        cols: dims.cols,
        rows: dims.rows,
        historyLines: 10,
        historyTotal: 100,
        dataBase64: Buffer.from(`\x1bcSNAP-${paneId}`).toString('base64'),
      }));
      const value = collect ? [Buffer.alloc(0), snap].slice(0, blocks) : snap;
      onResult?.(value);
      return value;
    }
    return Buffer.alloc(0);
  }
  dispose() { this.disposed = true; }
}

function makeFixture({ clients = '', ownedPids = [] } = {}) {
  const controls = [];
  let windowSpec = { cols: 160, rows: 48, zoomed: false, activePaneId: '%3' };
  let clientsOutput = clients;
  const dimsForPane = paneId => {
    const found = (windowSpec.panes || [{ id: '%3', width: 80, height: 48 }, { id: '%4', width: 79, height: 48 }]).find(p => p.id === paneId);
    return found ? { cols: found.width, rows: found.height } : { cols: 80, rows: 48 };
  };
  const tmux = {
    run: async argv => {
      if (argv[0] === 'list-panes') return makeWindowListOutput(windowSpec);
      if (argv[0] === 'display-message') return '1';
      if (argv[0] === 'list-clients') return clientsOutput;
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    },
  };
  const invalidate = () => { tmux.invalidations = (tmux.invalidations || 0) + 1; };
  const pool = new ControlPool({
    tmux,
    workspace: { invalidate },
    getOwnedClientPids: () => ownedPids,
    outputBatchMs: 0,
    createControl: () => {
      const ctrl = new FakeControl({ dimsForPane });
      controls.push(ctrl);
      return ctrl;
    },
  });
  const target = { instanceId: '99:100', sessionId: '$1', windowId: '@2' };
  return {
    pool,
    controls,
    target,
    tmux,
    setWindowSpec: next => { windowSpec = { ...windowSpec, ...next }; },
    setClients: next => { clientsOutput = next; },
  };
}

describe('ControlPool multi-pane window-stream', () => {
  it('delivers binary 0x02 snapshots, sequential binary 0x01 outputs, layout tree, and chunks >4KiB inputs', async () => {
    const { pool, controls, target } = makeFixture();
    const received = [];
    const lease = await pool.subscribeWindow(target, frame => received.push(Buffer.isBuffer(frame) ? decodeBinaryFrame(frame) : frame));

    expect(controls[0].commands).toContain('refresh-client -f pause-after=5');
    expect(received[0]).toMatchObject({ type: 'ready', sizeLease: 'owner', inputAllowed: true, windowCols: 160, windowRows: 48 });
    expect(received[1]).toMatchObject({ type: 'layout', windowId: '@2', activePaneId: '%3' });
    expect(received[1].tree.type).toBe('split');
    expect(received[1].panes[1].cwd).toBe(`/repo/with${SEP}sep`);

    const snaps = received.filter(f => f.kind === 'snapshot');
    expect(snaps.map(s => [s.paneId, s.seq, s.data.toString()])).toEqual([
      ['%3', 0, '\x1bcSNAP-%3'],
      ['%4', 0, '\x1bcSNAP-%4'],
    ]);

    controls[0].emit('output', '%4', Buffer.from('live-a'));
    controls[0].emit('output', '%4', Buffer.from('live-b'));
    const outs = received.filter(f => f.kind === 'output');
    expect(outs.map(o => [o.paneId, o.seq, o.data.toString()])).toEqual([
      ['%4', 1, 'live-a'],
      ['%4', 2, 'live-b'],
    ]);

    // Large input (>4 KiB) splits into chunks cleanly
    const big = 'A'.repeat(5000);
    await lease.input('%4', big);
    const sendCmds = controls[0].commands.filter(c => c.startsWith('send-keys -H -t %4 '));
    expect(sendCmds).toHaveLength(2);
    expect(sendCmds[0].slice('send-keys -H -t %4 '.length).split(' ')).toHaveLength(4096);
    expect(sendCmds[1].slice('send-keys -H -t %4 '.length).split(' ')).toHaveLength(904);

    lease.close();
    pool.dispose();
  });

  it('enforces sizeLease follow-foreign, takeover, instant %client-session-changed revocation, and ignores owned native client PIDs', async () => {
    const { pool, controls, target, setClients } = makeFixture({
      clients: '$1|441\n$1|888\n$1|777\n',
      ownedPids: ['888'], // native-window client owned by this panel
    });
    const frames = [];
    const lease = await pool.subscribeWindow(target, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));

    expect(frames[0]).toMatchObject({ sizeLease: 'follow-foreign', inputAllowed: true, foreignClient: true });
    // input still works while follow-foreign!
    expect(await lease.input('%3', 'x')).toBe(true);
    // resize blocked while follow-foreign
    expect(await lease.resizeWindow(120, 40)).toBe(false);

    // Explicit takeover grants owner
    expect(await lease.takeover()).toBe(true);
    expect(frames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'owner', foreignClient: true });
    expect(await lease.resizeWindow(120, 40)).toBe(true);
    expect(controls[0].commands).toContain('resize-window -t @2 -x 120 -y 40');

    // A NEW unknown foreign PID connects -> %client-session-changed revokes takeover immediately
    setClients('$1|441\n$1|888\n$1|777\n$1|999\n');
    controls[0].emit('notification', '%client-session-changed $9 $1 work');
    await new Promise(r => setTimeout(r, 10));
    expect(frames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'follow-foreign', foreignClient: true });

    lease.close();
    pool.dispose();
  });

  it('emits layout without resnapshot on selectPane, resnapshots on %layout-change resize, and recovers cleanly on %pause', async () => {
    const { pool, controls, target, setWindowSpec } = makeFixture();
    const frames = [];
    const lease = await pool.subscribeWindow(target, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    const initialSnaps = frames.filter(f => f.kind === 'snapshot').length;

    await lease.selectPane('%4');
    expect(controls[0].commands).toContain('select-pane -t %4');
    expect(frames.filter(f => f.kind === 'snapshot')).toHaveLength(initialSnaps);
    expect(frames.filter(f => f.type === 'layout').at(-1).activePaneId).toBe('%4');

    // Only %3 resizes -> only %3 re-snapshots!
    setWindowSpec({
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 90, height: 48, command: 'zsh', label: 'left', cwd: '/repo/a' },
        { id: '%4', index: 1, x: 91, y: 0, width: 79, height: 48, command: 'claude', label: 'right', cwd: '/repo/b' },
      ],
    });
    controls[0].emit('notification', '%layout-change @2 ...');
    await new Promise(r => setTimeout(r, 20));
    const newSnaps = frames.filter(f => f.kind === 'snapshot').slice(initialSnaps);
    expect(newSnaps.map(s => s.paneId)).toEqual(['%3']);

    // %pause recovery executes continue + capture-pane -Q atomically
    controls[0].emit('pause', '%4');
    await new Promise(r => setTimeout(r, 200));
    expect(controls[0].commands).toContain('refresh-client -A %4:continue ; capture-pane -Q -p -t %4');
    expect(frames.filter(f => f.kind === 'snapshot').at(-1).paneId).toBe('%4');

    lease.close();
    pool.dispose();
  });

  it('keeps snapshot seq monotonic across resize resyncs so client output never stalls', async () => {
    const { pool, controls, target, setWindowSpec } = makeFixture();
    const frames = [];
    const lease = await pool.subscribeWindow(target, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));

    expect(frames.filter(f => f.kind === 'snapshot').map(s => [s.paneId, s.seq])).toEqual([
      ['%3', 0],
      ['%4', 0],
    ]);

    controls[0].emit('output', '%3', Buffer.from('a'));
    controls[0].emit('output', '%3', Buffer.from('b'));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%3').map(o => o.seq)).toEqual([1, 2]);

    setWindowSpec({
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 70, height: 48, command: 'zsh', label: 'left', cwd: '/repo/a' },
        { id: '%4', index: 1, x: 71, y: 0, width: 99, height: 48, command: 'claude', label: 'right', cwd: '/repo/b' },
      ],
    });
    expect(await lease.resizePaneSize('%3', { cols: 70 })).toBe(true);
    expect(controls[0].commands).toContain('resize-pane -t %3 -x 70');

    const resyncSnap = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%3').at(-1);
    expect(resyncSnap.seq).toBe(3);

    controls[0].emit('output', '%3', Buffer.from('c'));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%3').at(-1)).toMatchObject({
      seq: 4,
    });
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%3').at(-1).data.toString()).toBe('c');

    // Atomic multi-pane resizePaneBatch executes a single tmux transaction and advances seq monotonically
    setWindowSpec({
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 75, height: 20, command: 'zsh', label: 'left', cwd: '/repo/a' },
        { id: '%4', index: 1, x: 76, y: 0, width: 94, height: 48, command: 'claude', label: 'right', cwd: '/repo/b' },
      ],
    });
    expect(await lease.resizePaneBatch([{ paneId: '%3', cols: 75 }, { paneId: '%4', rows: 20 }])).toBe(true);
    expect(controls[0].commands).toContain('resize-pane -t %3 -x 75 ; resize-pane -t %4 -y 20');
    const snapAfterBatch = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%3').at(-1);
    expect(snapAfterBatch.seq).toBe(5);
    controls[0].emit('output', '%3', Buffer.from('d'));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%3').at(-1)).toMatchObject({ seq: 6 });

    // Explicit resync with forceSnapshot refreshes VT snapshot even without dimension changes (e.g. respawn-pane).
    const snapsBeforeResync = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%3').length;
    expect(await lease.resync({ paneId: '%3', forceSnapshot: true })).toBe(true);
    expect(frames.filter(f => f.kind === 'snapshot' && f.paneId === '%3')).toHaveLength(snapsBeforeResync + 1);

    lease.close();
    pool.dispose();
  });

  it('demotes earlier window subscribers to observer, lets observer reclaim ownership via takeover(), and restores remaining subscriber on close', async () => {
    const { pool, target } = makeFixture();
    const desktopFrames = [];
    const mobileFrames = [];

    const desktop = await pool.subscribeWindow(target, f => desktopFrames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    expect(desktopFrames.find(f => f.type === 'ready')).toMatchObject({ sizeLease: 'owner', inputAllowed: true });

    const mobile = await pool.subscribeWindow(target, f => mobileFrames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    expect(mobileFrames.find(f => f.type === 'ready')).toMatchObject({ sizeLease: 'owner', inputAllowed: true });
    expect(desktopFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'observer', inputAllowed: false });
    expect(await desktop.input('%3', 'ls')).toBe(false);

    // Demoted observer reclaims ownership via takeover(), demoting mobile to observer.
    expect(await desktop.takeover()).toBe(true);
    expect(desktopFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'owner', inputAllowed: true });
    expect(mobileFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'observer', inputAllowed: false });
    expect(await desktop.input('%3', 'ls')).toBe(true);
    expect(await mobile.input('%3', 'ls')).toBe(false);
    expect(await desktop.resizeWindow(140, 40)).toBe(true);

    // When desktop closes, mobile automatically regains owner lease.
    desktop.close();
    await new Promise(r => setTimeout(r, 10));
    expect(mobileFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'owner', inputAllowed: true });

    mobile.close();
    pool.dispose();
  });

  it('compacts native snapshots along logical \\r\\n lines, strips default trailing spaces, and bounds resize snapshots to 80 history lines', async () => {
    const HDR = '\x1bc\x1b[?25l\x1b[?7h\x1b[?6l\x1b[4l';
    const PFX = '\x1b[0m\x0f\x1b(B\x1b)0';
    const SFX = '\x1b]8;;\x1b\\';
    const POST = '\x1b[3g';
    // H0 (complete), H1+H2 (soft-wrapped pair, NO \r\n between H1 & H2), H3 (complete), V0+V1 (visible rows=2).
    const raw = Buffer.from(
      HDR
      + `${PFX}H0     ${SFX}\r\n`
      + `${PFX}H1_WRAP   ${SFX}`
      + `${PFX}H2_CONT   ${SFX}\r\n`
      + `${PFX}H3\x1b[42m   ${SFX}\r\n`
      + `${PFX}V0     ${SFX}\r\n`
      + `${PFX}V1${SFX}`
      + POST,
    );
    // Asking for maxHistoryLines=2 from 4 history rows -> cutIdx=2 hits inside soft-wrapped H2_CONT, advances to H3 (historyLines=1).
    const bounded = compactNativeSnapshot(raw, { rows: 2, maxHistoryLines: 2 });
    const boundedText = bounded.data.toString('utf8');
    expect(bounded.historyTotal).toBe(4);
    expect(bounded.historyLines).toBe(1);
    expect(boundedText).not.toContain('H0');
    expect(boundedText).not.toContain('H2_CONT');
    expect(boundedText).toContain(`${PFX}H3\x1b[42m   ${SFX}\r\n`); // keeps colored trailing spaces
    expect(boundedText).toContain(`${PFX}V0${SFX}\r\n`); // strips default-bg trailing spaces
    expect(boundedText).toContain(`${PFX}V1${SFX}`);

    // Unbounded trailing-space strip preserves wrapped rows while trimming unwrapped rows.
    const full = compactNativeSnapshot(raw, { rows: 2, maxHistoryLines: 10 });
    expect(full.historyLines).toBe(4);
    expect(full.data.toString('utf8')).toContain(`${PFX}H1_WRAP   ${SFX}${PFX}H2_CONT${SFX}\r\n`);

    // Alt-screen snapshot preserves alt section and bounds normal history.
    const altRaw = Buffer.from(
      HDR
      + `${PFX}NH0   ${SFX}\r\n${PFX}NH1   ${SFX}\r\n${PFX}NV0   ${SFX}`
      + `\x1b[?1049h\x1b[H${PFX}ALT0   ${SFX}\r\n${PFX}ALT1${SFX}`
      + POST,
    );
    const altBounded = compactNativeSnapshot(altRaw, { rows: 1, maxHistoryLines: 1 });
    expect(altBounded.historyTotal).toBe(2);
    expect(altBounded.historyLines).toBe(1);
    expect(altBounded.data.toString('utf8')).toContain(`\x1b[?1049h\x1b[H${PFX}ALT0${SFX}\r\n${PFX}ALT1${SFX}`);

    // Non-native payloads pass through unchanged.
    const plain = Buffer.from('\x1bcPLAIN');
    expect(compactNativeSnapshot(plain, { rows: 24 })).toEqual({ data: plain, historyLines: null, historyTotal: null });

    // ControlPool snapshots active pane first and enforces resizeSnapshotHistoryLines (80) on resize.
    const bigSnap = Buffer.from(
      HDR + Array.from({ length: 120 }, (_, i) => `${PFX}L${i}     ${SFX}`).join('\r\n') + POST,
    );
    const snapOrder = [];
    let pane4Width = 79;
    let control;
    const pool = new ControlPool({
      tmux: {
        run: async argv => {
          if (argv[0] === 'list-panes') {
            return makeWindowListOutput({
              cols: 80 + 1 + pane4Width,
              rows: 10,
              activePaneId: '%4',
              panes: [
                { id: '%3', index: 0, x: 0, y: 0, width: 80, height: 10, command: 'zsh', label: 'left', cwd: '/repo/a' },
                { id: '%4', index: 1, x: 81, y: 0, width: pane4Width, height: 10, command: 'claude', label: 'right', cwd: '/repo/b' },
              ],
            });
          }
          if (argv[0] === 'display-message') return '1';
          if (argv[0] === 'list-clients') return '';
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      },
      workspace: { invalidate() {} },
      outputBatchMs: 0,
      pauseAfterSec: 5,
      initialSnapshotHistoryLines: 100,
      resizeSnapshotHistoryLines: 10,
      createControl: () => {
        control = new (class extends EventEmitter {
          constructor() { super(); this.commands = []; this.child = { pid: 999 }; }
          async command(text, { onResult } = {}) {
            this.commands.push(text);
            if (text.includes('#{client_pid}')) { const b = Buffer.from('99:100|$1|441'); onResult?.(b); return b; }
            const resizeMatch = /resize-pane -t %4 -x (\d+)/.exec(text);
            if (resizeMatch) pane4Width = Number(resizeMatch[1]);
            if (text.includes('capture-pane -Q -p -t ')) {
              const paneId = /capture-pane -Q -p -t (%\d+)/.exec(text)[1];
              snapOrder.push(paneId);
              const snap = Buffer.from(JSON.stringify({
                version: 1, instanceId: '99:100', windowId: '@2', paneId,
                cols: paneId === '%4' ? pane4Width : 80,
                rows: 10,
                dataBase64: bigSnap.toString('base64'),
              }));
              onResult?.(snap);
              return snap;
            }
            return Buffer.alloc(0);
          }
          dispose() {}
        })();
        return control;
      },
    });
    const frames = [];
    const lease = await pool.subscribeWindow({ instanceId: '99:100', sessionId: '$1', windowId: '@2' }, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    expect(snapOrder[0]).toBe('%4'); // active pane snapshotted first
    const initSnap = frames.find(f => f.kind === 'snapshot' && f.paneId === '%4');
    expect(initSnap.historyLines).toBe(100);

    await lease.resizePaneBatch([{ paneId: '%4', cols: 70 }]);
    const resizedSnap = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').at(-1);
    expect(resizedSnap.historyLines).toBe(10);

    // Post-resize SIGWINCH redraw storm (\x1b[2J\x1b[3J\x1b[H + 60KB burst) is coalesced into a single compacted 0x02 snapshot with 0 bytes of flooded 0x01 output.
    const outputsBeforeBurst = frames.filter(f => f.kind === 'output' && f.paneId === '%4').length;
    const snapsBeforeBurst = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length;
    control.emit('output', '%4', Buffer.from('\x1b[2J\x1b[3J\x1b[H' + 'TURN_REPLAY\r\n'.repeat(4500)));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%4')).toHaveLength(outputsBeforeBurst);
    await new Promise(r => setTimeout(r, 150));
    const snapsAfterBurst = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4');
    expect(snapsAfterBurst).toHaveLength(snapsBeforeBurst + 1);
    expect(snapsAfterBurst.at(-1).historyLines).toBe(10);

    // Normal small live output still streams immediately as binary 0x01 after burst settles.
    control.emit('output', '%4', Buffer.from('small-live-line\r\n'));
    await new Promise(r => setTimeout(r, 15));
    const tailOutputs = frames.filter(f => f.kind === 'output' && f.paneId === '%4');
    expect(tailOutputs.length).toBeGreaterThan(outputsBeforeBurst);
    expect(tailOutputs.at(-1).data.toString('utf8')).toBe('small-live-line\r\n');

    lease.close();
    pool.dispose();
  });
});
