// Browser element metadata capture, PII redaction, and zero-Enter Markdown note formatting.
// Ported from stablyai/orca (MIT).

const SECRET_PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/g, '[REDACTED_JWT]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED_TOKEN]'],
  [/\b(?:sk|ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]'],
  [/([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[REDACTED_EMAIL]@$2'],
];

export function redactSensitiveValue(text) {
  let value = String(text || '');
  for (const [re, replacement] of SECRET_PATTERNS) {
    value = value.replace(re, replacement);
  }
  return value;
}

export function formatElementGrabNote({
  url = '',
  selector = '',
  tag = '',
  role = '',
  text = '',
  rect = null,
  attributes = {},
} = {}) {
  const safeUrl = redactSensitiveValue(String(url || '').replace(/[\r\n]+/g, ' ').trim());
  const safeSelector = redactSensitiveValue(String(selector || '').replace(/[\r\n]+/g, ' ').trim());
  const safeTag = String(tag || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const safeRole = String(role || '').replace(/[\r\n]+/g, ' ').trim();
  const safeText = redactSensitiveValue(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, 280);

  const parts = ['[Browser Element Context]'];
  if (safeUrl) parts.push(`url: ${safeUrl}`);
  if (safeSelector) parts.push(`selector: \`${safeSelector}\``);
  if (safeTag || safeRole) parts.push(`element: <${safeTag || 'node'}${safeRole ? ` role="${safeRole}"` : ''}>`);
  if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
    parts.push(`bounds: ${Math.round(rect.x || 0)},${Math.round(rect.y || 0)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }
  const attrPairs = Object.entries(attributes || {})
    .filter(([k, v]) => k && v !== undefined && v !== null && !/password|token|secret|auth/i.test(k))
    .slice(0, 6)
    .map(([k, v]) => `${k}="${redactSensitiveValue(String(v)).slice(0, 80)}"`);
  if (attrPairs.length) parts.push(`attrs: ${attrPairs.join(' ')}`);
  if (safeText) parts.push(`text: "${safeText}"`);

  // Strip trailing CR/LF so prefill never auto-submits an interactive prompt.
  return parts.join('\n').replace(/[\r\n]+$/g, '');
}
