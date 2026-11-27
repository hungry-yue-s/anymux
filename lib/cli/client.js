/**
 * Panel pairing discovery, pinned-TLS transport, Hub/Node auth separation, and --server routing.
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import tls from 'node:tls';
import { appPathCandidates } from '../legacy-names.js';
import { CliError, classifyApiError, classifyTransportError } from './errors.js';

export const SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 15_000;

export function resolveServerId({ flagValue = null, env = process.env } = {}) {
  const raw = flagValue != null ? flagValue : env?.ANYMUX_SERVER;
  if (raw == null || String(raw).trim() === '') return 'local';
  const trimmed = String(raw).trim();
  if (!SERVER_ID_RE.test(trimmed)) {
    throw new CliError('invalid_argument', `Invalid server id: ${trimmed}`, {
      data: { serverId: trimmed },
      nextSteps: ['Run `anymux server list --json` to list available servers, or pass `--server local`.'],
      exitCode: 2,
    });
  }
  return trimmed;
}

export function assertLocalOnly(commandName, serverId, nextSteps = []) {
  if (serverId !== 'local') {
    throw new CliError(
      'unsupported_remote',
      `${commandName} only runs on the local machine (got --server ${serverId})`,
      {
        data: { serverId, command: commandName },
        nextSteps,
        exitCode: 2,
      },
    );
  }
}

export function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function readPairing({ env = process.env, readFile = readFileSync } = {}) {
  const defaultPaths = appPathCandidates('config', 'node.json');
  const paths = env?.ANYMUX_CONFIG_DIR
    ? [join(env.ANYMUX_CONFIG_DIR, 'node.json'), ...defaultPaths]
    : defaultPaths;
  let lastSyntaxError = null;
  for (const path of paths) {
    let raw;
    try {
      raw = readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      lastSyntaxError = error;
    }
  }
  const message = lastSyntaxError
    ? `invalid pairing file (${lastSyntaxError.message})`
    : `no panel on this machine (${paths[0]} not found)`;
  throw new CliError('panel_unavailable', message, {
    data: { paths },
    nextSteps: ['Start the AnyMux panel service on this machine, or check ANYMUX_CONFIG_DIR.'],
    exitCode: 1,
  });
}

/**
 * Computes the HTTP target path and auth headers while enforcing Hub/Node token isolation:
 * pairing.token (node token) MUST NEVER be sent to `/n/:serverId/...` or Hub-only routes.
 */
export function buildRequestPlan({
  method,
  path,
  serverId = 'local',
  scope = 'node',
  pairing,
  authToken = null,
}) {
  const cleanAuth = typeof authToken === 'string' && authToken.trim() ? authToken.trim() : null;
  const headers = {};
  let targetPath = path;

  if (scope === 'hub') {
    if (cleanAuth) {
      headers.Authorization = `Bearer ${cleanAuth}`;
    } else if (!isLoopbackHost(pairing?.host)) {
      throw new CliError('auth_required', 'Hub authentication token required for non-loopback panel access', {
        data: { serverId, scope, host: pairing?.host },
        nextSteps: ['Set ANYMUX_AUTH_TOKEN to a Hub login token.'],
        exitCode: 1,
      });
    }
  } else if (serverId !== 'local') {
    targetPath = `/n/${encodeURIComponent(serverId)}${path.startsWith('/') ? path : '/' + path}`;
    if (cleanAuth) {
      headers.Authorization = `Bearer ${cleanAuth}`;
    } else if (!isLoopbackHost(pairing?.host)) {
      throw new CliError('auth_required', 'Hub authentication token required for remote server routing', {
        data: { serverId, scope, host: pairing?.host },
        nextSteps: ['Set ANYMUX_AUTH_TOKEN to a Hub login token.'],
        exitCode: 1,
      });
    }
  } else {
    if (pairing?.token) {
      headers.Authorization = `Bearer ${pairing.token}`;
    } else if (cleanAuth) {
      headers.Authorization = `Bearer ${cleanAuth}`;
    }
  }

  return { method, path: targetPath, headers };
}

/** TLS socket whose certificate matches the pinned fingerprint, checked before any byte is sent. */
function pinnedSocket(pairing) {
  return new Promise((resolveSocket, reject) => {
    const socket = tls.connect({ host: pairing.host, port: pairing.port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      if (fingerprint !== pairing.tlsFingerprint) {
        socket.destroy();
        reject(new CliError('panel_unavailable', 'panel certificate does not match the pairing file', {
          nextSteps: ['Restart or re-pair the local AnyMux panel service.'],
        }));
      } else {
        resolveSocket(socket);
      }
    });
    socket.on('error', reject);
  });
}

async function defaultTransport({ pairing, method, path, headers, body, timeoutMs }) {
  const payload = body == null ? null : JSON.stringify(body);
  const reqHeaders = { ...headers };
  if (payload != null) {
    reqHeaders['Content-Type'] = 'application/json';
    reqHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  const socket = pairing.tls ? await pinnedSocket(pairing) : null;
  const options = {
    host: pairing.host,
    port: pairing.port,
    path,
    method,
    headers: reqHeaders,
  };
  if (socket) options.createConnection = () => socket;

  return new Promise((resolveResponse, reject) => {
    const req = (pairing.tls ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawText = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = JSON.parse(rawText);
        } catch {
          data = null;
        }
        resolveResponse({ status: res.statusCode || 500, data, rawText });
      });
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Request timeout after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    if (payload != null) req.end(payload);
    else req.end();
  });
}

export function createPanelClient({
  serverId = 'local',
  env = process.env,
  readPairingFn = readPairing,
  transport = defaultTransport,
} = {}) {
  const resolvedServerId = resolveServerId({ flagValue: serverId, env });
  const authToken = env?.ANYMUX_AUTH_TOKEN || null;

  async function requestJson(method, path, body = null, { scope = 'node', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const pairing = readPairingFn({ env });
    const plan = buildRequestPlan({
      method,
      path,
      serverId: resolvedServerId,
      scope,
      pairing,
      authToken,
    });
    let response;
    try {
      response = await transport({
        pairing,
        method: plan.method,
        path: plan.path,
        headers: plan.headers,
        body,
        timeoutMs,
      });
    } catch (error) {
      throw classifyTransportError(error, { serverId: resolvedServerId });
    }
    const { status, data } = response || {};
    if (status >= 200 && status < 300 && (!data || data.success !== false)) {
      return data && typeof data === 'object' && 'data' in data ? data.data : data;
    }
    throw classifyApiError({
      status: status || 500,
      data,
      path: plan.path,
      serverId: resolvedServerId,
      scope,
    });
  }

  return {
    serverId: resolvedServerId,
    requestJson,
    postJson(path, body, opts) {
      return requestJson('POST', path, body, opts);
    },
  };
}
