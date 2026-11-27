import { describe, expect, it } from 'vitest';
import { formatElementGrabNote, redactSensitiveValue } from '../../lib/browser/element-grab.js';
import { assertLoopbackCdpEndpoint, listCdpTargets } from '../../lib/browser/cdp-client.js';

describe('Browser Element Grab (zero-Enter + PII redaction) and Loopback CDP guard', () => {
  it('redacts tokens/emails and formats clean zero-Enter markdown snippet', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sigValueHere';
    expect(redactSensitiveValue(`Authorization: Bearer ${jwt} by alice@example.com sk-1234567890abcdef`))
      .toBe('Authorization: Bearer [REDACTED_JWT] by [REDACTED_EMAIL]@example.com [REDACTED_SECRET]');

    const note = formatElementGrabNote({
      url: 'http://localhost:3000/login?token=Bearer%20secretValue123456',
      selector: '#submit-btn',
      tag: 'button',
      role: 'button',
      text: 'Sign in as admin@corp.io with sk-secret1234567890\n',
      rect: { x: 10, y: 20, width: 120, height: 40 },
      attributes: { 'data-testid': 'login-btn', password: 'secret' },
    });
    expect(note).toContain('[Browser Element Context]');
    expect(note).toContain('selector: `#submit-btn`');
    expect(note).toContain('[REDACTED_EMAIL]@corp.io');
    expect(note).not.toContain('sk-secret1234567890');
    expect(note).not.toContain('password=');
    expect(note.endsWith('\n')).toBe(false);
    expect(note.endsWith('\r')).toBe(false);
  });

  it('strictly enforces loopback-only CDP endpoints and redacts target metadata', async () => {
    expect(() => assertLoopbackCdpEndpoint('http://192.168.1.10:9222')).toThrow(/non-loopback/i);
    expect(() => assertLoopbackCdpEndpoint('https://example.com:9222')).toThrow();
    expect(() => assertLoopbackCdpEndpoint('http://10.0.0.5:9222')).toThrow(/non-loopback/i);
    expect(() => assertLoopbackCdpEndpoint('http://127.0.0.1')).toThrow(/port/i);
    expect(assertLoopbackCdpEndpoint('http://127.0.0.1:9222').httpBase).toBe('http://127.0.0.1:9222');
    expect(assertLoopbackCdpEndpoint('http://localhost:9223').httpBase).toBe('http://localhost:9223');

    const targets = await listCdpTargets('http://127.0.0.1:9222', {
      fetchImpl: async (url) => {
        expect(url).toBe('http://127.0.0.1:9222/json/list');
        return {
          ok: true,
          json: async () => [{
            id: 't-1',
            type: 'page',
            title: 'User alice@example.com dashboard',
            url: 'http://localhost:3000/#ghp_abcdef1234567890',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
          }],
        };
      },
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].title).toBe('User [REDACTED_EMAIL]@example.com dashboard');
    expect(targets[0].url).toBe('http://localhost:3000/#[REDACTED_SECRET]');
    expect(targets[0].webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/devtools/page/1');
  });
});
