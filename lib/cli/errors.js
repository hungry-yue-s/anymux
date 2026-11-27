/**
 * Structured CLI errors, API/transport classification, and unified output formatting.
 */

export class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ data?: unknown, nextSteps?: string[], exitCode?: number }} [options]
   */
  constructor(code, message, { data = undefined, nextSteps = [], exitCode = 1 } = {}) {
    super(message || code);
    this.name = 'CliError';
    this.code = code || 'runtime_error';
    if (data !== undefined) this.data = data;
    this.nextSteps = Array.isArray(nextSteps) ? nextSteps.filter(Boolean) : [];
    this.exitCode = Number.isInteger(exitCode) && exitCode > 0 ? exitCode : 1;
  }
}

function toSnakeCode(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function extractApiErrorInfo(data, status) {
  const rawErr = data && typeof data === 'object' ? data.error : null;
  if (rawErr && typeof rawErr === 'object') {
    return {
      serverCode: rawErr.code ? String(rawErr.code) : '',
      message: rawErr.message ? String(rawErr.message) : `HTTP ${status}`,
      details: rawErr.details,
    };
  }
  if (typeof rawErr === 'string' && rawErr.trim()) {
    return { serverCode: '', message: rawErr.trim(), details: undefined };
  }
  return { serverCode: '', message: `HTTP ${status}`, details: undefined };
}

/**
 * Maps an HTTP/API failure into a structured CliError with recovery nextSteps.
 */
export function classifyApiError({ status = 500, data = null, path = '', serverId = 'local', scope = 'node' } = {}) {
  const { serverCode, message, details } = extractApiErrorInfo(data, status);
  const previewMatch = /\b(preview_source_(?:ambiguous|untrusted|unavailable|invalid_pane))\b/.exec(message);
  if (previewMatch) {
    return new CliError(previewMatch[1], message, {
      data: details !== undefined ? details : { path, serverId },
      nextSteps: message.includes('--pane') ? ['Re-run with `--pane %N` using the matching pane ID.'] : [],
      exitCode: 1,
    });
  }

  if (status === 401) {
    const nextSteps = (scope === 'hub' || serverId !== 'local')
      ? ['Set ANYMUX_AUTH_TOKEN to a Hub login token, or ensure loopback trustLocal is enabled on the Hub.']
      : ['Check that ~/.config/anymux/node.json matches the running panel, or set ANYMUX_AUTH_TOKEN.'];
    return new CliError('auth_required', message, {
      data: { status, serverId, scope },
      nextSteps,
      exitCode: 1,
    });
  }

  if (serverCode === 'SERVER_NOT_FOUND') {
    return new CliError('server_not_found', message, {
      data: { serverId, ...(details ? { details } : {}) },
      nextSteps: ['Run `anymux server list --json` to inspect registered server IDs.'],
      exitCode: 1,
    });
  }

  if (serverCode === 'NODE_NOT_RUNNING' || serverCode === 'SERVER_OFFLINE' || serverCode === 'NODE_NOT_INSTALLED') {
    return new CliError('panel_unavailable', message, {
      data: { serverId, serverCode, ...(details ? { details } : {}) },
      nextSteps: ['Run `anymux server list --json` to inspect server reachability.'],
      exitCode: 1,
    });
  }

  if (serverCode === 'VALIDATION_ERROR') {
    return new CliError('invalid_argument', message, {
      ...(details !== undefined ? { data: details } : {}),
      exitCode: 2,
    });
  }

  const normalized = toSnakeCode(serverCode) || (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'api_error');
  return new CliError(normalized, message, {
    data: { status, serverId, ...(serverCode ? { serverCode } : {}), ...(details !== undefined ? { details } : {}) },
    exitCode: 1,
  });
}

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Maps a network/socket failure into a structured CliError.
 */
export function classifyTransportError(err, { serverId = 'local' } = {}) {
  if (err instanceof CliError) return err;
  const code = err?.code ? String(err.code) : '';
  if (TRANSPORT_CODES.has(code) || /timeout/i.test(err?.message || '')) {
    return new CliError('panel_unavailable', err?.message || 'Unable to reach AnyMux panel', {
      data: { serverId, ...(code ? { transportCode: code } : {}) },
      nextSteps: ['Check that the AnyMux panel service is running, then run `anymux status --json`.'],
      exitCode: 1,
    });
  }
  return new CliError('transport_error', err?.message || 'Transport error', {
    data: { serverId, ...(code ? { transportCode: code } : {}) },
    exitCode: 1,
  });
}

/**
 * Ensures any thrown error becomes a CliError instance.
 */
export function normalizeCliError(err) {
  if (err instanceof CliError) return err;
  return new CliError('runtime_error', err?.message || String(err || 'Unknown error'), { exitCode: 1 });
}

/**
 * Formats a CliError for either `--json` stdout envelope or human-readable stderr.
 */
export function formatCliError(err, { json = false } = {}) {
  const normalized = normalizeCliError(err);
  if (json) {
    const payload = {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.data !== undefined ? { data: normalized.data } : {}),
        ...(normalized.nextSteps.length ? { nextSteps: normalized.nextSteps } : {}),
      },
    };
    return { stream: 'stdout', text: JSON.stringify(payload, null, 2) + '\n', exitCode: normalized.exitCode };
  }
  const steps = normalized.nextSteps.length
    ? '\n' + normalized.nextSteps.map((step) => `Next step: ${step}`).join('\n')
    : '';
  return {
    stream: 'stderr',
    text: `anymux: ${normalized.message}${steps}\n`,
    exitCode: normalized.exitCode,
  };
}

/**
 * Formats a successful command payload for either `--json` envelope or text mode.
 */
export function formatCliSuccess(data, { json = false, warnings = [], formatText = null } = {}) {
  if (json) {
    const payload = {
      ok: true,
      data: data === undefined ? null : data,
      ...(Array.isArray(warnings) && warnings.length ? { warnings } : {}),
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }
  if (typeof formatText === 'function') {
    const out = formatText(data, warnings);
    return out.endsWith('\n') ? out : out + '\n';
  }
  return JSON.stringify(data, null, 2) + '\n';
}
