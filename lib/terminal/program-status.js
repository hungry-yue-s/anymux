// Passive PTY byte-stream scanner for OSC 7501 (Program Status Protocol),
// OSC 133 (prompt/command lifecycle), and standalone BEL (0x07).
// Guarantees that 0x07 terminating an OSC sequence is NEVER misclassified as BEL.
// Ported from stablyai/orca (MIT).

export const PROGRAM_STATUS_OSC_PREFIX = '\x1b]7501;';
export const HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 * 60 * 1000;

const PROGRAM_STATUS_STATES = ['idle', 'working', 'done', 'blocked', 'error'];
const PROGRAM_STATUS_KINDS = ['permission', 'question', 'auth'];
export const PROGRAM_STATUS_QUERY_REPLY = `${PROGRAM_STATUS_OSC_PREFIX}?:states=${PROGRAM_STATUS_STATES.join(',')}:kinds=${PROGRAM_STATUS_KINDS.join(',')}\x1b\\`;

export const PROGRAM_STATUS_MAX_BODY_BYTES = 4087;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_ID_LENGTH = 128;
const MAX_ID_DEPTH = 8;
const MAX_APP_BYTES = 32;
const MAX_CARRY_LENGTH = 4200;

const KEY_RE = /^[a-z]+$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_RE = /^[A-Za-z0-9_.+-]+$/;
const PROGRESS_RE = /^0*(\d{1,3})$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const APP_TO_AGENT_TYPE = Object.freeze({
  'claude-code': 'claude',
  'grok-build': 'grok',
  'kimi-code': 'kimi',
  'kiro-cli': 'kiro',
});

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function withinUtf8Limit(text, maxBytes) {
  return Buffer.byteLength(String(text || ''), 'utf8') <= maxBytes;
}

function isValidId(id) {
  if (id.length > MAX_ID_LENGTH) return false;
  const segments = id.split('/');
  return segments.length <= MAX_ID_DEPTH && segments.every((seg) => SEGMENT_RE.test(seg));
}

function decodeText(encoded, maxDecoded) {
  if (!BASE64_RE.test(encoded)) return null;
  const unpadded = encoded.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  let bytes;
  try {
    bytes = Buffer.from(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4), 'base64');
  } catch {
    return null;
  }
  if (bytes.byteLength > maxDecoded) return null;
  let text;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
  return CONTROL_RE.test(text) ? null : text;
}

export function parseProgramStatusBody(body) {
  if (typeof body !== 'string' || !withinUtf8Limit(body, PROGRAM_STATUS_MAX_BODY_BYTES)) {
    return null;
  }
  if (body.trim() === '?') {
    return { type: 'query' };
  }
  const pairs = new Map();
  const texts = {};
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (
      !withinUtf8Limit(key, MAX_KEY_BYTES)
      || (key === 'app' && !withinUtf8Limit(value, MAX_APP_BYTES))
      || (key === 'msg' && !withinUtf8Limit(value, MAX_MSG_ENCODED))
      || (key === 'title' && !withinUtf8Limit(value, MAX_TITLE_ENCODED))
      || (key === 'id' && !isValidId(value))
    ) {
      return null;
    }
    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) continue;
    if (key === 'msg' || key === 'title') {
      const decoded = decodeText(value, key === 'msg' ? MAX_MSG_DECODED : MAX_TITLE_DECODED);
      if (decoded === null) return null;
      texts[key] = decoded;
      continue;
    }
    pairs.set(key, value);
  }

  const state = pairs.get('state');
  if (state === undefined || (state !== 'clear' && !PROGRAM_STATUS_STATES.includes(state))) {
    return null;
  }
  const rawId = pairs.get('id');
  const report = { id: rawId ?? null, state };
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind !== undefined && PROGRAM_STATUS_KINDS.includes(kind)) {
    report.kind = kind;
  }
  const progressDigits = PROGRESS_RE.exec(pairs.get('progress') ?? '')?.[1];
  if ((state === 'working' || state === 'blocked') && progressDigits !== undefined) {
    const num = Number.parseInt(progressDigits, 10);
    if (num <= 100) report.progress = num;
  }
  const app = pairs.get('app');
  if (app !== undefined && APP_RE.test(app)) {
    report.app = app;
  }
  if (texts.msg) report.msg = texts.msg;
  if (texts.title) report.title = texts.title;
  return { type: 'report', report };
}

export function canonicalAppAgentType(app) {
  if (!app) return '';
  return Object.hasOwn(APP_TO_AGENT_TYPE, app) ? APP_TO_AGENT_TYPE[app] : app;
}

/**
 * Map a parsed OSC 7501 report to Anymux's agent-event payload shape.
 */
export function projectProgramStatusToAgentEvent(report, context = {}) {
  if (!report || report.state === 'clear') return null;
  if (report.id !== null) return null; // Root record owns pane state; children are tracked as subagent count
  const agent = canonicalAppAgentType(report.app) || context.agent || 'agent';
  let event = 'agent_stop';
  let state = 'agent_stopped';
  if (report.state === 'working') {
    event = 'agent_running';
    state = 'agent_running';
  } else if (report.state === 'blocked') {
    event = report.kind === 'permission' ? 'permission_wait' : 'waiting_attention';
    state = 'waiting_attention';
  } else if (report.state === 'error') {
    event = 'stop_failure';
    state = 'failed';
  } else if (report.state === 'idle' || report.state === 'done') {
    event = 'agent_stop';
    state = 'agent_stopped';
  }
  return {
    ...context,
    source: 'osc7501',
    origin: 'terminal',
    agent,
    event,
    state,
    ...(report.msg ? { reason: report.msg, lastMessage: report.msg } : {}),
    ...(report.title ? { prompt: report.title } : {}),
    ...(report.kind ? { blockKind: report.kind } : {}),
    ...(typeof report.progress === 'number' ? { progress: report.progress } : {}),
  };
}

/**
 * Determine whether an explicit hook still owns this pane over passive terminal heuristics.
 */
export function shouldProgramStatusYieldToHook(previousPaneState, incomingEvent, now = Date.now()) {
  if (!previousPaneState || !incomingEvent) return false;
  if (previousPaneState.source === 'osc7501' || previousPaneState.source === 'osc133' || previousPaneState.source === 'bel') {
    return false;
  }
  const hookUpdatedAt = Number(previousPaneState.updatedAt || 0);
  if (!hookUpdatedAt) return false;

  // Explicit hook silence fallback window (2 minutes)
  if (now - hookUpdatedAt >= HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS) {
    return false;
  }
  return true;
}

/**
 * Find where an OSC sequence starting right after `\x1b]` terminates.
 * Returns { endIndex, body, aborted } or null if still incomplete.
 */
function findOscTerminator(data, bodyStart) {
  for (let i = bodyStart; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code === 0x07) {
      return { endIndex: i + 1, body: data.slice(bodyStart, i), aborted: false };
    }
    if (code === 0x18 || code === 0x1a) {
      return { endIndex: i + 1, body: '', aborted: true };
    }
    if (code === 0x1b) {
      if (i + 1 >= data.length) return null;
      if (data.charCodeAt(i + 1) === 0x5c) {
        return { endIndex: i + 2, body: data.slice(bodyStart, i), aborted: false };
      }
      // Unconsumed non-ST ESC cancels this OSC so outer scanner can re-process from `i`.
      return { endIndex: i, body: '', aborted: true };
    }
  }
  return null;
}

/**
 * Stateful passive scanner for one pane's LIVE byte stream (OSC 7501, OSC 133, standalone BEL, RIS).
 */
export function createProgramStatusScanner() {
  let pending = '';
  let adjacent133 = '';

  return {
    reset() {
      pending = '';
      adjacent133 = '';
    },
    scan(chunk) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk || '').toString('utf8');
      if (!text) return [];
      const combined = pending + text;
      pending = '';
      const events = [];
      let i = 0;

      while (i < combined.length) {
        const code = combined.charCodeAt(i);

        // Standalone BEL outside any OSC sequence
        if (code === 0x07) {
          adjacent133 = '';
          events.push({ type: 'bel', offset: i + 1 });
          i += 1;
          continue;
        }

        if (code !== 0x1b) {
          adjacent133 = '';
          i += 1;
          continue;
        }

        // Trailing bare ESC might be split across chunks
        if (i + 1 >= combined.length) {
          pending = '\x1b';
          break;
        }

        const next = combined[i + 1];

        // Full reset ESC c
        if (next === 'c') {
          adjacent133 = '';
          events.push({ type: 'full-reset', offset: i + 2 });
          i += 2;
          continue;
        }

        // Any OSC sequence ESC ] ... (BEL | ST) — consume whole frame so internal BEL never triggers standalone BEL
        if (next === ']') {
          const term = findOscTerminator(combined, i + 2);
          if (!term) {
            const rem = combined.slice(i);
            pending = rem.length > MAX_CARRY_LENGTH ? '' : rem;
            break;
          }
          i = term.endIndex;
          if (term.aborted) {
            adjacent133 = '';
            continue;
          }
          if (term.body.startsWith('7501;')) {
            adjacent133 = '';
            const msg = parseProgramStatusBody(term.body.slice(5));
            if (msg) events.push({ ...msg, offset: i });
          } else if (term.body.startsWith('133;')) {
            const payload = term.body.slice(4);
            const [seq, exitRaw] = payload.split(';');
            const closesAppZone = seq === 'D' && exitRaw === '0' && adjacent133.endsWith('BC');
            adjacent133 = (adjacent133 + String(seq || '').slice(0, 1)).slice(-2);
            if (!closesAppZone) {
              if (seq === 'A') {
                events.push({ type: 'prompt-start', offset: i });
              } else if (seq === 'C') {
                events.push({ type: 'command-start', offset: i });
              } else if (seq === 'D') {
                const parsedExit = exitRaw !== undefined && exitRaw !== '' ? Number.parseInt(exitRaw, 10) : null;
                events.push({
                  type: 'command-finished',
                  exitCode: Number.isNaN(parsedExit) ? null : parsedExit,
                  offset: i,
                });
              }
            }
          } else {
            adjacent133 = '';
          }
          continue;
        }

        adjacent133 = '';
        i += 2;
      }

      return events;
    },
  };
}
