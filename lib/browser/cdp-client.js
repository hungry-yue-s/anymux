// Strict loopback-only CDP (Chrome DevTools Protocol) target inspector.
// Refuses all non-loopback hosts to prevent SSRF / LAN exposure.
// Ported from stablyai/orca (MIT).

import { redactSensitiveValue } from './element-grab.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLoopbackCdpEndpoint(rawEndpoint) {
  if (typeof rawEndpoint !== 'string' || !rawEndpoint.trim()) {
    throw new Error('CDP endpoint is required');
  }
  let parsed;
  try {
    parsed = new URL(rawEndpoint.trim());
  } catch {
    throw new Error('Invalid CDP endpoint URL');
  }
  if (!['http:', 'ws:'].includes(parsed.protocol)) {
    throw new Error('Only http: or ws: CDP endpoints are permitted');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing non-loopback CDP host: ${parsed.hostname}`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CDP endpoint must specify an explicit valid port');
  }
  const httpBase = `http://${parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname}:${port}`;
  return { url: parsed, httpBase, port };
}

export async function listCdpTargets(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const { httpBase } = assertLoopbackCdpEndpoint(endpoint);
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(`${httpBase}/json/list`, { signal: ac.signal });
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list.slice(0, 40).map((t) => ({
      id: String(t.id || ''),
      type: String(t.type || 'page'),
      title: redactSensitiveValue(String(t.title || '')).slice(0, 200),
      url: redactSensitiveValue(String(t.url || '')).slice(0, 512),
      webSocketDebuggerUrl: typeof t.webSocketDebuggerUrl === 'string' && /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):/i.test(t.webSocketDebuggerUrl)
        ? t.webSocketDebuggerUrl
        : null,
    }));
  } finally {
    clearTimeout(timer);
  }
}
