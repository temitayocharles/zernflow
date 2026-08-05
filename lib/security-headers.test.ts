import { describe, expect, it } from 'vitest';
import {
  AUTH_NO_STORE_HEADER,
  getContentSecurityPolicy,
  getSecurityHeaders,
} from './security-headers';

describe('security headers', () => {
  it('blocks framing, plugins and insecure subresources', () => {
    const csp = getContentSecurityPolicy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain("connect-src 'self' https://*.supabase.co wss://*.supabase.co");
  });

  it('sets the browser hardening headers required in production', () => {
    const headers = Object.fromEntries(
      getSecurityHeaders().map(({ key, value }) => [key, value]),
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });

  it('prevents stale authentication pages after deployments', () => {
    expect(AUTH_NO_STORE_HEADER.value).toContain('no-store');
    expect(AUTH_NO_STORE_HEADER.value).toContain('must-revalidate');
  });
});
