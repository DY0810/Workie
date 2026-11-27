import { afterEach, describe, expect, it, vi } from 'vitest';

import { privateJson, privateResponse } from '@/lib/applicant-access';

vi.mock('server-only', () => ({}));

const origin = 'https://workie.example.test';
afterEach(() => { vi.unstubAllEnvs(); });

describe('private response boundaries', () => {
  it('imports actual routes without environment/configuration and returns private 503 instead of initializing on import', async () => {
    for (const key of ['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'WORKIE_HOUSEHOLD_PASSCODE', 'WORKIE_HOUSEHOLD_DY_EMAIL',
      'WORKIE_HOUSEHOLD_MAY_EMAIL', 'WORKIE_PRIVATE_DATABASE_URL']) vi.stubEnv(key, '');
    const { GET: applicant } = await import('@/app/api/auth/applicant/route');
    const { GET: applicants } = await import('@/app/api/auth/applicants/route');
    for (const response of [
      await applicant(new Request(`${origin}/api/auth/applicant`)),
      await applicants(new Request(`${origin}/api/auth/applicants`)),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('refuses an applicant switch from another site before reading the session', async () => {
    for (const [key, value] of Object.entries({ BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'a'.repeat(64), WORKIE_HOUSEHOLD_PASSCODE: '123456',
      WORKIE_HOUSEHOLD_DY_EMAIL: 'dy@example.test', WORKIE_HOUSEHOLD_MAY_EMAIL: 'may@example.test' })) vi.stubEnv(key, value);
    const { POST: select } = await import('@/app/api/auth/applicants/route');
    const response = await select(new Request(`${origin}/api/auth/applicants`, { method: 'POST',
      headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: 'household-may-v1' }) }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('overrides shared cache headers while preserving Vary and multiple Set-Cookie headers', () => {
    const headers = new Headers({
      'Vary': 'Accept-Encoding',
      'Cache-Control': 'public, max-age=300',
      'Vercel-CDN-Cache-Control': 'max-age=300',
    });
    headers.append('Set-Cookie', 'one=1; HttpOnly');
    headers.append('Set-Cookie', 'two=2; HttpOnly');
    const result = privateResponse(new Response(null, { headers }));
    expect(result.headers.getSetCookie()).toEqual(['one=1; HttpOnly', 'two=2; HttpOnly']);
    expect(result.headers.get('vary')).toBe('Accept-Encoding, Cookie, Origin');
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(privateJson({ ok: true }).headers.get('referrer-policy')).toBe('no-referrer');
  });
});
