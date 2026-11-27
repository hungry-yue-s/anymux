// Extract dev-server URLs advertised in terminal output, normalizing wildcard bind hosts.
// Ported from stablyai/orca (MIT).

const ADVERTISED_URL_RE = /\b(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})(?:\/[^\s"'<>)\]]*)?)/gi;

export function normalizeAdvertisedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host === '0.0.0.0' || host === '::' || host === '[::]') {
      u.hostname = 'localhost';
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function extractAdvertisedUrls(text, { limit = 16 } = {}) {
  const clean = String(text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  if (!clean) return [];
  const seen = new Set();
  const out = [];
  let match;
  ADVERTISED_URL_RE.lastIndex = 0;
  while ((match = ADVERTISED_URL_RE.exec(clean)) !== null) {
    const port = Number(match[2]);
    if (port < 80 || port > 65535) continue;
    const normalized = normalizeAdvertisedUrl(match[1]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ url: normalized, port, raw: match[1] });
    if (out.length >= limit) break;
  }
  return out;
}
