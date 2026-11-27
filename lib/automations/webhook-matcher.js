// HMAC-SHA256 webhook signature verifier and event filter matcher.
// Ported from stablyai/orca (MIT).

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature({ secret, payload, signatureHeader }) {
  const key = typeof secret === 'string' ? secret : '';
  if (!key) return true;
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) return false;
  const raw = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload ?? {});
  const expected = createHmac('sha256', key).update(raw).digest('hex');
  const provided = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
  if (provided.length !== expected.length || !/^[0-9a-f]+$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

export function matchWebhookEvent(job, { event = '', payload = null } = {}) {
  if (!job || job.enabled === false || !job.webhookEvent) return false;
  const expectedEvent = String(job.webhookEvent).trim();
  const actualEvent = String(event || '').trim();
  if (!expectedEvent || !actualEvent) return false;
  if (expectedEvent !== '*' && expectedEvent !== actualEvent) return false;

  if (job.webhookFilter && typeof job.webhookFilter === 'object') {
    for (const [key, expectedVal] of Object.entries(job.webhookFilter)) {
      if (String(payload?.[key] ?? '') !== String(expectedVal ?? '')) return false;
    }
  }
  return true;
}
