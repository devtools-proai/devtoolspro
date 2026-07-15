/**
 * Unit tests for detectKeyRole — the JWT-payload parser that determines
 * whether SUPABASE_KEY is the anon or service_role key without hitting
 * the DB. This is the earliest signal we have that a config problem
 * exists, so it needs to be bulletproof.
 */

const { detectKeyRole } = require('../db');

// A JWT is header.payload.signature — all base64url. We only decode
// the payload, so the header + signature can be junk for testing.
function makeJwt(payload) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `header.${b64(payload)}.signature`;
}

describe('detectKeyRole', () => {
  test('recognises service_role', () => {
    const key = makeJwt({ iss: 'supabase', role: 'service_role', iat: 1, exp: 9999999999 });
    expect(detectKeyRole(key)).toBe('service_role');
  });

  test('recognises anon', () => {
    const key = makeJwt({ iss: 'supabase', role: 'anon', iat: 1, exp: 9999999999 });
    expect(detectKeyRole(key)).toBe('anon');
  });

  test('returns unknown for a payload with no role claim', () => {
    const key = makeJwt({ iss: 'supabase', iat: 1 });
    expect(detectKeyRole(key)).toBe('unknown');
  });

  test('returns unknown for missing / non-string input', () => {
    expect(detectKeyRole(null)).toBe('unknown');
    expect(detectKeyRole(undefined)).toBe('unknown');
    expect(detectKeyRole('')).toBe('unknown');
    expect(detectKeyRole(42)).toBe('unknown');
    expect(detectKeyRole({})).toBe('unknown');
  });

  test('returns unknown for malformed JWTs (wrong segment count)', () => {
    expect(detectKeyRole('only.two')).toBe('unknown');
    expect(detectKeyRole('one')).toBe('unknown');
    expect(detectKeyRole('too.many.segments.here')).toBe('unknown');
  });

  test('returns unknown for invalid base64 in payload', () => {
    expect(detectKeyRole('header.@@@notbase64@@@.signature')).toBe('unknown');
  });

  test('handles unusual role claims safely', () => {
    // Anything not in the known set returns 'unknown', not the raw value.
    const key = makeJwt({ role: 'authenticated' });
    expect(detectKeyRole(key)).toBe('unknown');
  });

  test('base64url padding restoration works', () => {
    // Craft a payload whose length after base64 encoding produces zero
    // trailing '=' signs, so our restore-padding logic has to add them.
    // Payload with a service_role claim padded via long iss:
    const key = makeJwt({ role: 'service_role', pad: 'a'.repeat(2) });
    expect(detectKeyRole(key)).toBe('service_role');
  });
});
