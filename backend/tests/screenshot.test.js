/**
 * Unit tests for the screenshot-verification helpers introduced in v1.3.
 * Focuses on the pure functions — the DB-touching flow (attach + insert)
 * is exercised via the integration path in server.js and is covered by
 * manual smoke testing against a live Supabase instance.
 */

const {
  computeScreenshotMatchScore,
  prepareScreenshotUpload,
  SCREENSHOT_MAX_BYTES,
} = require('../payment-verify');

// Tiny 1×1 JPEG (base64) — 125 bytes decoded, well under any limit.
// Generated once via: `sharp -input <1x1 png> -f jpeg`.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsK' +
  'CwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wgALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACv/EABQBAQAAAAAAAAAAAAAAAAAAAAX/2gAIAQEAAD8Aof/Z';

const TINY_JPEG_DATA_URL = 'data:image/jpeg;base64,' + TINY_JPEG_BASE64;

describe('computeScreenshotMatchScore', () => {
  test('UTR match + exact amount = 100', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: '412345678901',
      extractedAmount: 946,
    })).toBe(100);
  });

  test('UTR match + amount within ₹1 rounds to 100', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: '412345678901',
      extractedAmount: 946.5,
    })).toBe(100);
  });

  test('UTR match + amount slightly off (₹5 diff) = 90', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: '412345678901',
      extractedAmount: 941,
    })).toBe(90);
  });

  test('UTR match + amount very different = 50', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: '412345678901',
      extractedAmount: 500,
    })).toBe(50);
  });

  test('UTR mismatch fails to zero regardless of amount', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: '999999999999',
      extractedAmount: 946,
    })).toBe(0);
  });

  test('OCR silence returns neutral 40 (admin reviews visually)', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: null,
      extractedAmount: null,
    })).toBe(40);
  });

  test('case-insensitive UTR comparison', () => {
    expect(computeScreenshotMatchScore({
      userUtr: 'abcd1234efgh',
      expectedAmount: 946,
      extractedUtr: 'ABCD1234EFGH',
      extractedAmount: 946,
    })).toBe(100);
  });

  test('trims whitespace before comparing UTRs', () => {
    expect(computeScreenshotMatchScore({
      userUtr: '412345678901',
      expectedAmount: 946,
      extractedUtr: '  412345678901  ',
      extractedAmount: 946,
    })).toBe(100);
  });
});

describe('prepareScreenshotUpload', () => {
  test('accepts a valid image data URL', () => {
    const result = prepareScreenshotUpload(TINY_JPEG_DATA_URL);
    expect(result.valid).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('produces stable sha256 for identical inputs', () => {
    const a = prepareScreenshotUpload(TINY_JPEG_DATA_URL);
    const b = prepareScreenshotUpload(TINY_JPEG_DATA_URL);
    expect(a.sha256).toBe(b.sha256);
  });

  test('rejects non-data-URL strings', () => {
    expect(prepareScreenshotUpload('https://example.com/foo.jpg').valid).toBe(false);
    expect(prepareScreenshotUpload('nope').valid).toBe(false);
    expect(prepareScreenshotUpload('').valid).toBe(false);
    expect(prepareScreenshotUpload(null).valid).toBe(false);
    expect(prepareScreenshotUpload(undefined).valid).toBe(false);
  });

  test('rejects disallowed mime types', () => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    expect(prepareScreenshotUpload(gif).valid).toBe(false);
    const pdf = 'data:application/pdf;base64,AAAA';
    expect(prepareScreenshotUpload(pdf).valid).toBe(false);
  });

  test('accepts png and webp mime types', () => {
    const png = 'data:image/png;base64,' + TINY_JPEG_BASE64;
    expect(prepareScreenshotUpload(png).valid).toBe(true);
    const webp = 'data:image/webp;base64,' + TINY_JPEG_BASE64;
    expect(prepareScreenshotUpload(webp).valid).toBe(true);
  });

  test('rejects oversize payloads', () => {
    // Build a data URL that decodes to > SCREENSHOT_MAX_BYTES bytes.
    const bytes = Buffer.alloc(SCREENSHOT_MAX_BYTES + 1024, 0);
    const oversizeUrl = 'data:image/jpeg;base64,' + bytes.toString('base64');
    const result = prepareScreenshotUpload(oversizeUrl);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/too large/i);
  });
});

describe('notifications.validateNotification', () => {
  const { validateNotification } = require('../notifications');

  test('accepts a minimal valid payload', () => {
    const r = validateNotification({ title: 'Hi', body: 'Please recheck your UTR.' });
    expect(r.valid).toBe(true);
    expect(r.data.kind).toBe('info');
  });

  test('trims and defaults kind', () => {
    const r = validateNotification({ title: '  Hi  ', body: '  Body  ' });
    expect(r.valid).toBe(true);
    expect(r.data.title).toBe('Hi');
    expect(r.data.body).toBe('Body');
    expect(r.data.kind).toBe('info');
  });

  test('rejects unknown kind', () => {
    expect(validateNotification({ title: 'Hi', body: 'B', kind: 'critical' }).valid).toBe(false);
  });

  test('rejects unsafe action_url schemes', () => {
    expect(validateNotification({
      title: 'Hi', body: 'B',
      actionUrl: 'javascript:alert(1)', actionLabel: 'Click',
    }).valid).toBe(false);
    expect(validateNotification({
      title: 'Hi', body: 'B',
      actionUrl: 'data:text/html,<script>', actionLabel: 'Click',
    }).valid).toBe(false);
  });

  test('accepts https and mailto action_url', () => {
    expect(validateNotification({
      title: 'Hi', body: 'B',
      actionUrl: 'https://wa.me/919019879108', actionLabel: 'Chat',
    }).valid).toBe(true);
    expect(validateNotification({
      title: 'Hi', body: 'B',
      actionUrl: 'mailto:hi@example.com', actionLabel: 'Email',
    }).valid).toBe(true);
  });

  test('requires both url + label together', () => {
    expect(validateNotification({
      title: 'Hi', body: 'B', actionUrl: 'https://example.com',
    }).valid).toBe(false);
    expect(validateNotification({
      title: 'Hi', body: 'B', actionLabel: 'Chat',
    }).valid).toBe(false);
  });

  test('rejects empty title/body', () => {
    expect(validateNotification({ title: '', body: 'B' }).valid).toBe(false);
    expect(validateNotification({ title: 'T', body: '' }).valid).toBe(false);
    expect(validateNotification({ title: '   ', body: 'B' }).valid).toBe(false);
  });

  test('rejects oversized title/body', () => {
    expect(validateNotification({ title: 'a'.repeat(200), body: 'B' }).valid).toBe(false);
    expect(validateNotification({ title: 'T', body: 'b'.repeat(1000) }).valid).toBe(false);
  });
});
