import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WindowStreamGateway } from '../../lib/terminal/window-gateway.js';
import { encodeOutputFrame, decodeBinaryFrame } from '../../lib/terminal/window-protocol.js';

class Socket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.frames = [];
    this.bufferedAmount = 0;
  }
  send(data) {
    this.frames.push(Buffer.isBuffer(data) ? data : JSON.parse(data));
  }
  close(code) {
    this.code = code;
    this.readyState = 3;
    this.emit('close');
  }
  ping() {}
}

const params = () => new URLSearchParams('instanceId=1:2&sessionId=$1&windowId=@2&protocol=1');

describe('window stream gateway', () => {
  it('sends binary data frames verbatim and dispatches all window control commands', async () => {
    const ws = new Socket();
    const calls = [];
    const lease = {
      close: vi.fn(),
      input: (paneId, data) => calls.push(['input', paneId, Buffer.isBuffer(data) ? [...data] : data]),
      resizeWindow: (cols, rows) => calls.push(['resize-window', cols, rows]),
      resizePaneSize: (paneId, dims) => calls.push(['resize-pane-size', paneId, dims]),
      resizePaneBatch: (resizes) => calls.push(['resize-pane-batch', resizes]),
      selectPane: paneId => calls.push(['select-pane', paneId]),
      zoomPane: (paneId, zoomed) => calls.push(['zoom-pane', paneId, zoomed]),
      takeover: () => calls.push(['takeover']),
      releaseTakeover: () => calls.push(['release-takeover']),
      visibility: v => calls.push(['visibility', v]),
    };
    const pool = {
      subscribeWindow: async (_target, send) => {
        send({ type: 'ready', protocol: 1 });
        send(encodeOutputFrame(5, 1, Buffer.from('ok')));
        return lease;
      },
    };
    const gw = new WindowStreamGateway({ pool });
    await gw.handle(ws, '/ws/window-stream/%402', params());

    expect(ws.frames[0]).toEqual({ type: 'ready', protocol: 1 });
    expect(Buffer.isBuffer(ws.frames[1])).toBe(true);
    expect(decodeBinaryFrame(ws.frames[1]).data.toString()).toBe('ok');

    ws.emit('message', JSON.stringify({ type: 'input', paneId: '%5', encoding: 'base64', data: 'G1tNIP+A' }));
    ws.emit('message', JSON.stringify({ type: 'resize-window', cols: 120, rows: 40 }));
    ws.emit('message', JSON.stringify({ type: 'resize-pane-size', paneId: '%5', cols: 60 }));
    ws.emit('message', JSON.stringify({ type: 'resize-pane-batch', resizes: [{ paneId: '%5', cols: 64 }, { paneId: '%6', rows: 22 }] }));
    ws.emit('message', JSON.stringify({ type: 'select-pane', paneId: '%5' }));
    ws.emit('message', JSON.stringify({ type: 'zoom-pane', paneId: '%5', zoomed: true }));
    ws.emit('message', JSON.stringify({ type: 'takeover' }));
    ws.emit('message', JSON.stringify({ type: 'release-takeover' }));
    ws.emit('message', JSON.stringify({ type: 'visibility', visible: false }));
    await new Promise(r => setTimeout(r, 10));

    expect(calls).toEqual([
      ['input', '%5', [27, 91, 77, 32, 255, 128]],
      ['resize-window', 120, 40],
      ['resize-pane-size', '%5', { cols: 60, rows: undefined }],
      ['resize-pane-batch', [{ paneId: '%5', cols: 64 }, { paneId: '%6', rows: 22 }]],
      ['select-pane', '%5'],
      ['zoom-pane', '%5', true],
      ['takeover'],
      ['release-takeover'],
      ['visibility', false],
    ]);

    ws.close(1000);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('closes slow connections with 1013 and expires missing pongs', async () => {
    vi.useFakeTimers();
    const slow = new Socket();
    slow.bufferedAmount = 2 * 1024 * 1024;
    await new WindowStreamGateway({ pool: { subscribeWindow: async (_t, send) => { send({ type: 'ready' }); return null; } } })
      .handle(slow, '/ws/window-stream/@2', params());
    expect(slow.code).toBe(1013);

    const stale = new Socket();
    const lease = { close: vi.fn() };
    stale.ping = vi.fn();
    stale.terminate = vi.fn();
    try {
      await new WindowStreamGateway({ pool: { subscribeWindow: async () => lease } })
        .handle(stale, '/ws/window-stream/@2', params());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stale.ping).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stale.terminate).toHaveBeenCalledOnce();
      expect(lease.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
