/** WebSocket gateway for multiplexed multi-pane binary window streams (`/ws/window-stream/:windowId`). */
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_DIMENSION, MAX_HELD_INPUT_BYTES, MAX_INPUT_BYTES, outputFrameOptions } from './protocol.js';
import { validControlSize } from './control-pool.js';
import { parseWindowStreamTarget } from './window-protocol.js';

function decodeClientInput(message) {
  if (typeof message.data !== 'string') throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal input');
  let input = message.data;
  if (message.encoding === 'base64') {
    if (input.length > 4 * Math.ceil(MAX_INPUT_BYTES / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal input encoding');
    }
    input = Buffer.from(input, 'base64');
  } else if (message.encoding !== undefined) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported terminal input encoding');
  }
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Terminal input exceeded its limit');
  return input;
}

export class WindowStreamGateway {
  constructor({ pool, parseTarget = parseWindowStreamTarget }) {
    this.pool = pool;
    this.parseTarget = parseTarget;
  }

  async handle(ws, pathname, query) {
    let lease = null, detached = false, earlyBytes = 0, pongTimer = null;
    const early = [];

    const send = frame => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_HELD_INPUT_BYTES) {
        ws.close(1013, 'window stream backpressure');
        throw new AppError(ErrorCode.CONNECTION_LIMIT, 'The terminal window is too slow');
      }
      if (Buffer.isBuffer(frame)) {
        ws.send(frame, { binary: true, ...outputFrameOptions(frame) });
      } else {
        const data = JSON.stringify(frame);
        ws.send(data, outputFrameOptions(data));
      }
    };

    const fail = error => {
      const safe = error instanceof AppError ? error : new AppError(ErrorCode.INTERNAL, 'Window stream failed');
      try { send({ type: 'error', code: safe.code, message: safe.message, retryable: safe.retryable }); } catch { /* closed on backpressure */ }
      if (ws.readyState === ws.OPEN) ws.close(safe.retryable ? 1011 : 1008, safe.code);
    };

    const dispatch = async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || !lease || detached) return;

      switch (message.type) {
        case 'input': {
          const input = decodeClientInput(message);
          await lease.input(message.paneId, input);
          break;
        }
        case 'resize-window':
          if (!validControlSize(message.cols, message.rows)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal window grid');
          await lease.resizeWindow(message.cols, message.rows);
          break;
        case 'resize-pane-size': {
          const { cols, rows } = message;
          const hasCols = cols !== undefined;
          const hasRows = rows !== undefined;
          if ((!hasCols && !hasRows)
            || (hasCols && (!Number.isInteger(cols) || cols < 1 || cols > MAX_DIMENSION))
            || (hasRows && (!Number.isInteger(rows) || rows < 1 || rows > MAX_DIMENSION))) {
            throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane dimensions');
          }
          await lease.resizePaneSize(message.paneId, { cols, rows });
          break;
        }
        case 'resize-pane-batch': {
          const resizes = message.resizes;
          if (!Array.isArray(resizes) || resizes.length < 1 || resizes.length > 4) {
            throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane resize batch');
          }
          const clean = resizes.map((item) => {
            const cols = item?.cols;
            const rows = item?.rows;
            const hasCols = cols !== undefined;
            const hasRows = rows !== undefined;
            if ((!hasCols && !hasRows)
              || (hasCols && (!Number.isInteger(cols) || cols < 1 || cols > MAX_DIMENSION))
              || (hasRows && (!Number.isInteger(rows) || rows < 1 || rows > MAX_DIMENSION))) {
              throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane dimensions');
            }
            return { paneId: item.paneId, ...(hasCols ? { cols } : {}), ...(hasRows ? { rows } : {}) };
          });
          await lease.resizePaneBatch(clean);
          break;
        }
        case 'select-pane':
          await lease.selectPane(message.paneId);
          break;
        case 'zoom-pane':
          await lease.zoomPane(message.paneId, message.zoomed);
          break;
        case 'takeover': {
          let paneId;
          if (message.paneId !== undefined && message.paneId !== null) {
            if (typeof message.paneId !== 'string' || !/^%\d+$/.test(message.paneId)) {
              throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane identity');
            }
            paneId = message.paneId;
          }
          const claimSize = message.claimSize === true;
          if (!paneId && !claimSize) await lease.takeover();
          else await lease.takeover({ ...(paneId ? { paneId } : {}), ...(claimSize ? { claimSize: true } : {}) });
          break;
        }
        case 'release-takeover':
          await lease.releaseTakeover();
          break;
        case 'resync':
          await lease.resync?.({
            paneId: typeof message.paneId === 'string' ? message.paneId : null,
            forceSnapshot: message.forceSnapshot === true,
          });
          break;
        case 'visibility':
          if (typeof message.visible !== 'boolean') throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal visibility');
          await lease.visibility(message.visible, { background: message.background === true });
          break;
        default:
          break;
      }
    };

    const receive = raw => {
      if (detached) return;
      if (!lease) {
        earlyBytes += Buffer.byteLength(raw);
        if (earlyBytes > MAX_HELD_INPUT_BYTES || early.length >= 128) {
          fail(new AppError(ErrorCode.VALIDATION_ERROR, 'Too much input before the window snapshot'));
          return;
        }
        early.push(raw);
      } else {
        dispatch(raw).catch(fail);
      }
    };

    const detach = () => {
      if (detached) return;
      detached = true;
      clearInterval(ping);
      clearTimeout(pongTimer);
      early.length = 0;
      ws.off('message', receive);
      ws.off('pong', pong);
      lease?.close();
    };

    const pong = () => { clearTimeout(pongTimer); pongTimer = null; };
    const ping = setInterval(() => {
      if (ws.readyState !== ws.OPEN || pongTimer) return;
      pongTimer = setTimeout(() => {
        detach();
        ws.terminate?.();
      }, 10_000);
      pongTimer.unref?.();
      try { ws.ping?.(); } catch { detach(); ws.terminate?.(); }
    }, 15_000);
    ping.unref?.();
    ws.on('pong', pong);
    ws.on('message', receive);
    ws.once('close', detach);
    ws.on('error', detach);

    try {
      const target = this.parseTarget(pathname, query);
      lease = await this.pool.subscribeWindow(target, send, {
        cancelled: () => detached || ws.readyState !== ws.OPEN,
        end: (code, reason) => { if (code instanceof Error) fail(code); else if (ws.readyState === ws.OPEN) ws.close(code, reason); },
      });
      if (detached || ws.readyState !== ws.OPEN) { lease?.close(); return null; }
      if (lease) for (const raw of early.splice(0)) await dispatch(raw);
      return lease;
    } catch (error) {
      fail(error);
      detach();
      return null;
    }
  }
}
