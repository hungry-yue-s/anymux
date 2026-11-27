import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
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
    expect(controls[0].commands.some(c => c.includes('resize-window -t @2 -x 120 -y 40'))).toBe(true);

    // A NEW unknown foreign PID connects -> %client-session-changed revokes takeover immediately
    setClients('$1|441\n$1|888\n$1|777\n$1|999\n');
    controls[0].emit('notification', '%client-session-changed $9 $1 work');
    await new Promise(r => setTimeout(r, 10));
    expect(frames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'follow-foreign', foreignClient: true });

    lease.close();
    pool.dispose();
  });

  it('emits layout without redundant resnapshot on synced %layout-change resize, scopes notifications, and recovers cleanly on %pause', async () => {
    const { pool, controls, target, setWindowSpec } = makeFixture();
    const frames = [];
    const lease = await pool.subscribeWindow(target, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    const initialSnaps = frames.filter(f => f.kind === 'snapshot').length;

    await lease.selectPane('%4');
    expect(controls[0].commands).toContain('select-pane -t %4');
    expect(frames.filter(f => f.kind === 'snapshot')).toHaveLength(initialSnaps);
    expect(frames.filter(f => f.type === 'layout').at(-1).activePaneId).toBe('%4');

    // Synced pane resize emits layout update immediately without blocking behind capture-pane -Q!
    setWindowSpec({
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 90, height: 48, command: 'zsh', label: 'left', cwd: '/repo/a' },
        { id: '%4', index: 1, x: 91, y: 0, width: 79, height: 48, command: 'claude', label: 'right', cwd: '/repo/b' },
      ],
    });
    const snapsBeforeLayout = frames.filter(f => f.kind === 'snapshot').length;
    controls[0].emit('notification', '%layout-change @2 ...');
    await new Promise(r => setTimeout(r, 20));
    expect(frames.filter(f => f.kind === 'snapshot')).toHaveLength(snapsBeforeLayout);
    expect(frames.filter(f => f.type === 'layout').at(-1).panes[0].width).toBe(90);

    // Notification scoped to another window (@99) does not redundantly reconcile @2
    const layoutCountBeforeOther = frames.filter(f => f.type === 'layout').length;
    controls[0].emit('notification', '%layout-change @99 ...');
    await new Promise(r => setTimeout(r, 20));
    expect(frames.filter(f => f.type === 'layout')).toHaveLength(layoutCountBeforeOther);

    // %pause recovery executes continue + capture-pane -Q atomically
    controls[0].emit('pause', '%4');
    await new Promise(r => setTimeout(r, 200));
    expect(controls[0].commands).toContain('refresh-client -A %4:continue ; capture-pane -Q -p -t %4');
    expect(frames.filter(f => f.kind === 'snapshot').at(-1).paneId).toBe('%4');

    lease.close();
    pool.dispose();
  });

  it('keeps seq monotonic across resize layout updates and holds post-resize output until layout broadcasts', async () => {
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

    // Hold post-resize output while resize-pane runs so `layout` arrives strictly before `'c'`
    const origCmd = controls[0].command.bind(controls[0]);
    controls[0].command = async (text, opts) => {
      if (text.startsWith('resize-pane -t %3 -x 70')) {
        controls[0].emit('output', '%3', Buffer.from('c'));
      }
      return origCmd(text, opts);
    };
    setWindowSpec({
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 70, height: 48, command: 'zsh', label: 'left', cwd: '/repo/a' },
        { id: '%4', index: 1, x: 71, y: 0, width: 99, height: 48, command: 'claude', label: 'right', cwd: '/repo/b' },
      ],
    });
    expect(await lease.resizePaneSize('%3', { cols: 70 })).toBe(true);
    expect(controls[0].commands).toContain('resize-pane -t %3 -x 70');

    const lastLayoutIdx = frames.findLastIndex(f => f.type === 'layout');
    const cOutputIdx = frames.findLastIndex(f => f.kind === 'output' && f.paneId === '%3' && f.data.toString() === 'c');
    expect(lastLayoutIdx).toBeGreaterThan(-1);
    expect(cOutputIdx).toBeGreaterThan(lastLayoutIdx);
    expect(frames[cOutputIdx].seq).toBe(3);

    // Atomic multi-pane resizePaneBatch executes a single tmux transaction and advances seq monotonically
    setWindowSpec({
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 75, height: 20, command: 'zsh', label: 'left', cwd: '/repo/a' },
        { id: '%4', index: 1, x: 76, y: 0, width: 94, height: 48, command: 'claude', label: 'right', cwd: '/repo/b' },
      ],
    });
    expect(await lease.resizePaneBatch([{ paneId: '%3', cols: 75 }, { paneId: '%4', rows: 20 }])).toBe(true);
    expect(controls[0].commands).toContain('resize-pane -t %3 -x 75 ; resize-pane -t %4 -y 20');
    controls[0].emit('output', '%3', Buffer.from('d'));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%3').at(-1)).toMatchObject({ seq: 4 });

    // Explicit resync with forceSnapshot refreshes VT snapshot even without dimension changes (e.g. respawn-pane).
    const snapsBeforeResync = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%3').length;
    expect(await lease.resync({ paneId: '%3', forceSnapshot: true })).toBe(true);
    expect(frames.filter(f => f.kind === 'snapshot' && f.paneId === '%3')).toHaveLength(snapsBeforeResync + 1);
    controls[0].emit('output', '%3', Buffer.from('e'));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%3').at(-1)).toMatchObject({ seq: 6 });

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
      resizeSnapshotOnChange: true,
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

    // Moderate post-resize TUI clear+redraw bursts (e.g. 60KB < 512KB) stream live immediately without coalescing into a snapshot,
    // while massive floods (>= 512KB) still trigger emergency burst coalescing.
    const outputsBeforeModerate = frames.filter(f => f.kind === 'output' && f.paneId === '%4').length;
    const snapsBeforeModerate = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length;
    control.emit('output', '%4', Buffer.from('\x1b[2J\x1b[3J\x1b[H' + 'TUI_REDRAW\r\n'.repeat(4500)));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%4')).toHaveLength(outputsBeforeModerate + 1);
    expect(frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4')).toHaveLength(snapsBeforeModerate);

    const outputsBeforeBurst = frames.filter(f => f.kind === 'output' && f.paneId === '%4').length;
    control.emit('output', '%4', Buffer.from('\x1b[2J\x1b[3J\x1b[H' + 'TURN_REPLAY\r\n'.repeat(42000)));
    expect(frames.filter(f => f.kind === 'output' && f.paneId === '%4')).toHaveLength(outputsBeforeBurst);
    await new Promise(r => setTimeout(r, 150));
    const snapsAfterBurst = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4');
    expect(snapsAfterBurst).toHaveLength(snapsBeforeModerate + 1);
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

  it('caches positive capabilities across concurrent calls and supports fast base64 snapshot validation', async () => {
    let displayCalls = 0;
    const pool = new ControlPool({
      tmux: {
        run: async argv => {
          if (argv[0] === 'display-message') {
            displayCalls++;
            await new Promise(r => setTimeout(r, 10));
            return '1|1';
          }
          throw new Error(`unexpected: ${argv.join(' ')}`);
        },
      },
      workspace: {},
    });

    const [capA, capB, winCap] = await Promise.all([
      pool.capability(),
      pool.capability(),
      pool.windowStreamCapability(),
    ]);
    expect(displayCalls).toBe(1);
    expect(capA).toEqual({ available: true, protocol: 1, snapshotVersion: 1 });
    expect(capB).toEqual(capA);
    expect(winCap).toEqual({ available: true, protocol: 1, snapshotVersion: 1, binary: true, richPane: true });

    // Cached hit makes 0 additional tmux subprocess calls.
    expect(await pool.capability()).toEqual(capA);
    expect(displayCalls).toBe(1);

    const { decodeSnapshot } = await import('../../lib/terminal/control-pool.js');
    for (const raw of ['', 'YQ==', 'YWI=', 'YWJj', Buffer.from('\x1bcHELLO_WORLD!').toString('base64')]) {
      const parsed = decodeSnapshot(Buffer.from(JSON.stringify({
        version: 1, instanceId: '99:100', windowId: '@2', paneId: '%3', cols: 80, rows: 24, dataBase64: raw,
      })));
      expect(parsed.dataBase64).toBe(raw);
    }
    for (const bad of ['abc', 'ab=d', 'ab_d', '====']) {
      expect(() => decodeSnapshot(Buffer.from(JSON.stringify({
        version: 1, instanceId: '99:100', windowId: '@2', paneId: '%3', cols: 80, rows: 24, dataBase64: bad,
      })))).toThrow();
    }

    pool.dispose();
  });

  it('keeps background parked subscribers warm without stealing owner lease or re-snapshotting on foreground restore', async () => {
    const { pool, controls, target } = makeFixture();
    const firstFrames = [];
    const secondFrames = [];

    const first = await pool.subscribeWindow(target, f => firstFrames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    const snapsAfterFirst = controls[0].commands.filter(c => c.startsWith('capture-pane')).length;

    // Parking first subscriber sends visibility(true, { background: true }) — keeps streaming 0x01 without re-snapshot.
    await first.visibility(true, { background: true });
    expect(controls[0].commands.filter(c => c.startsWith('capture-pane')).length).toBe(snapsAfterFirst);

    // Second subscriber in another client becomes owner; first remains warm in background and keeps receiving 0x01.
    const second = await pool.subscribeWindow(target, f => secondFrames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
    controls[0].emit('output', '%3', Buffer.from('warm-msg'));
    expect(firstFrames.filter(f => f.kind === 'output').at(-1)?.data.toString()).toBe('warm-msg');
    expect(secondFrames.filter(f => f.kind === 'output').at(-1)?.data.toString()).toBe('warm-msg');
    expect(await first.input('%3', 'no')).toBe(false);

    // Restoring first to foreground (visible=true, background=false) reclaims owner WITHOUT any capture-pane re-snapshot!
    const snapsBeforeForeground = controls[0].commands.filter(c => c.startsWith('capture-pane')).length;
    await first.visibility(true, { background: false });
    expect(controls[0].commands.filter(c => c.startsWith('capture-pane')).length).toBe(snapsBeforeForeground);
    expect(await first.input('%3', 'ok')).toBe(true);
    expect(await second.input('%3', 'no')).toBe(false);

    first.close();
    second.close();
    pool.dispose();
  });

  it('keeps non-resize TUI clear-screen scrolling live across 120ms tumbling windows and coalesces concurrent input writes', async () => {
    vi.useFakeTimers();
    try {
      const { pool, controls, target } = makeFixture();
      const pendingSendKeys = [];
      const frames = [];
      const lease = await pool.subscribeWindow(target, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));
      const origCommand = controls[0].command.bind(controls[0]);
      controls[0].command = async (line, opts) => {
        if (line.startsWith('send-keys -H ')) {
          controls[0].commands.push(line);
          return await new Promise((resolve, reject) => pendingSendKeys.push({ line, resolve, reject }));
        }
        return await origCommand(line, opts);
      };
      const snapsBeforeScroll = frames.filter(f => f.kind === 'snapshot').length;

      // Three ~55KB clear+redraw bursts spaced 130ms apart reset cleanly on tumbling 120ms window (<128KB threshold).
      for (let i = 0; i < 3; i++) {
        controls[0].emit('output', '%3', Buffer.from('\x1b[2J\x1b[H' + 'CODEX_ROW_\r\n'.repeat(4500)));
        await vi.advanceTimersByTimeAsync(130);
      }
      expect(frames.filter(f => f.kind === 'snapshot').length).toBe(snapsBeforeScroll);
      expect(frames.filter(f => f.kind === 'output').length).toBeGreaterThanOrEqual(3);

      // Concurrent lease.input calls while one send-keys -H is in flight coalesce into a single follow-up command.
      const p1 = lease.input('%3', 'A');
      const p2 = lease.input('%3', '\x1b[<65;5;5M');
      const p3 = lease.input('%3', '\x1b[<65;5;5M');
      expect(pendingSendKeys).toHaveLength(1);
      pendingSendKeys.shift().resolve('');
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingSendKeys).toHaveLength(1);
      expect(pendingSendKeys[0].line).toBe(
        'send-keys -H -t %3 1b 5b 3c 36 35 3b 35 3b 35 4d 1b 5b 3c 36 35 3b 35 3b 35 4d',
      );
      pendingSendKeys.shift().resolve('');
      expect(await Promise.all([p1, p2, p3])).toEqual([true, true, true]);

      lease.close();
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('grants per-pane ownership when desktop and mobile share a multi-pane window, and supports per-pane takeover without window lockstep', async () => {
    const { pool, controls, target } = makeFixture();
    const desktopFrames = [];
    const mobileFrames = [];

    const desktop = await pool.subscribeWindow(
      { ...target, device: 'desktop' },
      f => desktopFrames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f),
    );
    expect(desktopFrames.find(f => f.type === 'ready')).toMatchObject({
      sizeLease: 'owner',
      inputAllowed: true,
      paneLeases: {
        '%3': { owner: true, inputAllowed: true },
        '%4': { owner: true, inputAllowed: true },
      },
    });

    // Mobile joins focusing %4 -> Mobile gets %4 ONLY (follow-peer), Desktop keeps %3 + owner sizeLease!
    const mobile = await pool.subscribeWindow(
      { ...target, device: 'mobile', paneId: '%4' },
      f => mobileFrames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f),
    );
    expect(mobileFrames.find(f => f.type === 'ready')).toMatchObject({
      sizeLease: 'follow-peer',
      inputAllowed: true,
      paneLeases: {
        '%3': { owner: false, inputAllowed: false, driverDevice: 'desktop' },
        '%4': { owner: true, inputAllowed: true },
      },
    });
    expect(desktopFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({
      sizeLease: 'owner',
      inputAllowed: true,
      paneLeases: {
        '%3': { owner: true, inputAllowed: true },
        '%4': { owner: false, inputAllowed: false, driverDevice: 'mobile' },
      },
    });

    // Desktop types freely in %3 while blocked only in %4; Mobile types in %4 while blocked in %3.
    expect(await desktop.input('%3', 'ls')).toBe(true);
    expect(await desktop.input('%4', 'no')).toBe(false);
    expect(await mobile.input('%4', 'ok')).toBe(true);
    expect(await mobile.input('%3', 'no')).toBe(false);
    expect(await desktop.resizeWindow(150, 44)).toBe(true);
    expect(await mobile.resizeWindow(50, 20)).toBe(false);

    // Switching active pane on Mobile releases %4 back to Desktop and claims %3 WITHOUT yanking tmux select-pane on Desktop!
    const selectCmdsBefore = controls[0].commands.filter(c => c.startsWith('select-pane')).length;
    await mobile.selectPane('%3');
    expect(controls[0].commands.filter(c => c.startsWith('select-pane')).length).toBe(selectCmdsBefore);
    expect(await mobile.input('%3', 'ok')).toBe(true);
    expect(await mobile.input('%4', 'no')).toBe(false);
    expect(await desktop.input('%4', 'ok')).toBe(true);

    // Desktop reclaims %3 via single-pane takeover while letting everything converge cleanly
    await desktop.takeover({ paneId: '%3' });
    expect(await desktop.input('%3', 'ok')).toBe(true);
    expect(await mobile.input('%3', 'no')).toBe(false);

    // Mobile can reclaim size explicitly when desired, and releaseTakeover returns sizeLease to Desktop
    await mobile.takeover({ paneId: '%4', claimSize: true });
    expect(mobileFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'owner', sizeOverridden: true });
    await mobile.releaseTakeover();
    expect(desktopFrames.filter(f => f.type === 'ready').at(-1)).toMatchObject({ sizeLease: 'owner' });

    mobile.close();
    desktop.close();
    pool.dispose();
  });

  it('routes input over dedicated no-output client (excluded from foreign PIDs), mutes hidden panes via refresh-client -A, recovers ACK overflows, and retries TERMINAL_BUSY history', async () => {
    const controls = [];
    const tmuxRuns = [];
    let clientsList = '$1|441\n';
    let capReply = '2|1|1';
    let busyCount = 0;
    const pool = new ControlPool({
      tmux: {
        run: async argv => {
          tmuxRuns.push(argv);
          if (argv[0] === 'list-panes') {
            const fmtIdx = argv.indexOf('-F');
            if (fmtIdx !== -1 && String(argv[fmtIdx + 1] || '').includes('#{pid}:#{start_time}|')) {
              return '99:100|$1|@2|%3|80|48|2|0|160|48\n99:100|$1|@2|%4|79|48|2|0|160|48\n';
            }
            return makeWindowListOutput({ cols: 160, rows: 48, activePaneId: '%3' });
          }
          if (argv[0] === 'display-message') return capReply;
          if (argv[0] === 'list-clients') return clientsList;
          throw new Error(`unexpected: ${argv.join(' ')}`);
        },
      },
      workspace: { invalidate() {}, resolvePane: async paneId => ({ windowId: '@2', paneId }) },
      dedicatedInputChannel: true,
      outputBatchMs: 0,
      createControl: opts => {
        const isInput = opts.flags === 'no-output,ignore-size';
        if (isInput) clientsList = '$1|441\n$1|552\n';
        const ctrl = new (class extends EventEmitter {
          constructor() { super(); this.commands = []; this.flags = opts.flags; this.child = { pid: isInput ? 992 : 991 }; }
          async command(text, { onResult, blocks = 1, collect = false } = {}) {
            this.commands.push(text);
            if (text.includes('#{client_pid}')) {
              const b = Buffer.from(`99:100|$1|${isInput ? 552 : 441}`);
              onResult?.(b);
              return b;
            }
            if (text.includes('#{history_size}')) return Buffer.from(`99:100|$1|@2|%3|${busyCount >= 1 ? 605 : 600}|0`);
            if (text.includes('capture-pane -Q -p -t ')) {
              const paneId = /capture-pane -Q -p -t (%\d+)/.exec(text)[1];
              const snap = Buffer.from(JSON.stringify({
                version: 1, instanceId: '99:100', windowId: '@2', paneId, cols: 80, rows: 48,
                historyLines: 250, historyTotal: 600,
                dataBase64: Buffer.from(`\x1bc\x1b[?25l\x1b[?7h\x1b[?6l\x1b[4l\x1b[0m\x0f\x1b(B\x1b)0LINE\x1b]8;;\x1b\\\x1b[3g`).toString('base64'),
              }));
              const val = collect ? [Buffer.from('OLD1\nOLD2'), snap].slice(0, blocks) : snap;
              onResult?.(val);
              return val;
            }
            return Buffer.alloc(0);
          }
          async transaction(lines) {
            this.commands.push(lines.join(' ; '));
            busyCount++;
            if (busyCount === 1) {
              return [Buffer.from('99:100|$1|@2|%3|600|0'), Buffer.from('line1'), Buffer.from('99:100|$1|@2|%3|605|0')];
            }
            return [Buffer.from('99:100|$1|@2|%3|605|0'), Buffer.from('ok1\nok2'), Buffer.from('99:100|$1|@2|%3|605|0')];
          }
          dispose() { this.disposed = true; }
        })();
        controls.push(ctrl);
        return ctrl;
      },
    });

    const frames = [];
    const lease = await pool.subscribeWindow(
      { instanceId: '99:100', sessionId: '$1', windowId: '@2', ack: true },
      f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f),
    );
    const mainCtrl = controls[0];
    // v2 capability negotiates binary-output flag and native -Q -S -2000
    expect(mainCtrl.commands).toContain('refresh-client -f pause-after=5,binary-output');
    expect(mainCtrl.commands.some(c => c.includes('capture-pane -Q -p -t %3 -S -2000'))).toBe(true);
    expect(frames.find(f => f.type === 'ready').foreignClient).toBe(false);

    // Input lazily spawns dedicated no-output channel & its clientPid (552) is treated as owned
    expect(await lease.input('%3', 'hi')).toBe(true);
    expect(controls).toHaveLength(2);
    expect(controls[1].flags).toBe('no-output,ignore-size');
    expect(controls[1].commands.some(c => c.startsWith('send-keys -H -t %3 '))).toBe(true);
    expect(mainCtrl.commands.some(c => c.startsWith('send-keys -H '))).toBe(false);
    expect(frames.filter(f => f.type === 'ready').every(f => f.foreignClient === false)).toBe(true);

    // Focusing single visible pane mutes hidden %4 via refresh-client -A '%4:off'; switching back unmutes via snapshot
    await lease.setPaneFocus({ paneId: '%3', visiblePaneIds: ['%3'] });
    expect(mainCtrl.commands).toContain("refresh-client -A '%4:off'");
    const snapsBeforeUnmute = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length;
    await lease.setPaneFocus({ paneId: '%4', visiblePaneIds: ['%4'] });
    expect(mainCtrl.commands).toContain("refresh-client -A '%3:off'");
    expect(frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length).toBe(snapsBeforeUnmute + 1);

    // Deep resync expands historyLines
    const snapsBeforeDeep = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length;
    expect(await lease.resync({ paneId: '%4', forceSnapshot: true, historyLines: 5000 })).toBe(true);
    expect(mainCtrl.commands.some(c => c.includes('capture-pane -Q -p -t %4 -S -5000'))).toBe(true);
    expect(frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length).toBe(snapsBeforeDeep + 1);

    // ACK overflow on slow window triggers automatic recovery snapshot instead of disconnecting
    const snapsBeforeOverflow = frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length;
    mainCtrl.emit('output', '%4', Buffer.alloc(600 * 1024, 0x41));
    mainCtrl.emit('output', '%4', Buffer.alloc(300 * 1024, 0x42));
    await new Promise(r => setTimeout(r, 20));
    expect(frames.filter(f => f.kind === 'snapshot' && f.paneId === '%4').length).toBeGreaterThan(snapsBeforeOverflow);

    // history() automatically retries on transient TERMINAL_BUSY shift
    const hist = await pool.history({ instanceId: '99:100', sessionId: '$1', windowId: '@2', paneId: '%3' }, { limit: 10 });
    expect(hist.lines).toEqual(['ok1', 'ok2']);
    expect(busyCount).toBe(2);

    lease.close();
    pool.dispose();
  });

  it('scales asymmetric multi-pane layouts proportionally on resizeWindow and updates intent only on explicit pane resize', async () => {
    const { pool, controls, target, setWindowSpec } = makeFixture();
    // 1:3 initial split (30 : 90 across 121 cols)
    setWindowSpec({
      cols: 121,
      rows: 40,
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 30, height: 40, command: 'zsh', label: 'left', cwd: '/a' },
        { id: '%4', index: 1, x: 31, y: 0, width: 90, height: 40, command: 'codex', label: 'right', cwd: '/b' },
      ],
    });
    const frames = [];
    const lease = await pool.subscribeWindow(target, f => frames.push(Buffer.isBuffer(f) ? decodeBinaryFrame(f) : f));

    // Shrink 121 -> 81 cols: issues resize-window + proportional select-layout (20:60) & persists @anymux_layout_ratios
    setWindowSpec({
      cols: 81,
      rows: 40,
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 20, height: 40, command: 'zsh', label: 'left', cwd: '/a' },
        { id: '%4', index: 1, x: 21, y: 0, width: 60, height: 40, command: 'codex', label: 'right', cwd: '/b' },
      ],
    });
    expect(await lease.resizeWindow(81, 40)).toBe(true);
    const shrinkCmd = controls[0].commands.find((c) => c.includes('resize-window -t @2 -x 81 -y 40'));
    expect(shrinkCmd).toBeTruthy();
    expect(shrinkCmd).toContain("select-layout -t @2 '");
    expect(shrinkCmd).toContain("81x40,0,0{20x40,0,0,3,60x40,21,0,4}'");

    // Now drag divider explicitly to 50:30 at 81 cols -> updates intent ratio to 5:3!
    setWindowSpec({
      cols: 81,
      rows: 40,
      panes: [
        { id: '%3', index: 0, x: 0, y: 0, width: 50, height: 40, command: 'zsh', label: 'left', cwd: '/a' },
        { id: '%4', index: 1, x: 51, y: 0, width: 30, height: 40, command: 'codex', label: 'right', cwd: '/b' },
      ],
    });
    expect(await lease.resizePaneBatch([{ paneId: '%3', cols: 50 }])).toBe(true);
    expect(controls[0].commands.some((c) => c.includes('@anymux_layout_ratios'))).toBe(true);

    // Re-expand 81 -> 161 cols: uses updated 5:3 intent => 100:60!
    await lease.resizeWindow(161, 40);
    const expandCmd = controls[0].commands.filter((c) => c.includes('resize-window -t @2 -x 161 -y 40')).at(-1);
    expect(expandCmd).toContain("select-layout -t @2 '");
    expect(expandCmd).toContain("161x40,0,0{100x40,0,0,3,60x40,101,0,4}'");

    lease.close();
    pool.dispose();
  });
});
