/**
 * Unit tests for the Indian phone normaliser.
 * All the accept / reject cases are enumerated so a future refactor
 * can't quietly re-broaden the rules.
 */

const {
  normalizeIndianPhone,
  isCanonical,
  formatForDisplay,
  describeReason,
  REASONS,
} = require('../utils/phone');

describe('normalizeIndianPhone — accepts', () => {
  const cases = [
    // Bare 10-digit subscriber.
    ['9876543210', '919876543210'],
    ['6019879108', '916019879108'],
    ['7019879108', '917019879108'],
    ['8019879108', '918019879108'],
    // Already canonical.
    ['919876543210', '919876543210'],
    // +91 with separators.
    ['+91 98765 43210', '919876543210'],
    ['+91-98765-43210', '919876543210'],
    ['+91(98765)43210', '919876543210'],
    ['+919876543210', '919876543210'],
    // Leading STD 0.
    ['09876543210', '919876543210'],
    // Whitespace / mixed junk.
    ['  9876543210  ', '919876543210'],
    ['91 98765 43210', '919876543210'],
  ];

  test.each(cases)('normalises %s → %s', (input, expected) => {
    const r = normalizeIndianPhone(input);
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe(expected);
    expect(r.reason).toBe('ok');
  });
});

describe('normalizeIndianPhone — rejects', () => {
  test('empty / whitespace', () => {
    expect(normalizeIndianPhone('').reason).toBe(REASONS.EMPTY);
    expect(normalizeIndianPhone('   ').reason).toBe(REASONS.EMPTY);
    expect(normalizeIndianPhone(null).reason).toBe(REASONS.EMPTY);
    expect(normalizeIndianPhone(undefined).reason).toBe(REASONS.EMPTY);
  });

  test('too short', () => {
    expect(normalizeIndianPhone('987654321').reason).toBe(REASONS.TOO_SHORT); // 9 digits
    expect(normalizeIndianPhone('12345').reason).toBe(REASONS.TOO_SHORT);
  });

  test('too long', () => {
    expect(normalizeIndianPhone('9198765432101').reason).toBe(REASONS.TOO_LONG); // 13 digits
    expect(normalizeIndianPhone('98765432109876').reason).toBe(REASONS.TOO_LONG);
  });

  test('invalid first digit of subscriber (0-5)', () => {
    // 10-digit starting with 5 → not an Indian mobile.
    expect(normalizeIndianPhone('5876543210').reason).toBe(REASONS.INVALID_FIRST_DIGIT);
    // 12-digit 91-prefixed with subscriber starting with 3.
    expect(normalizeIndianPhone('913876543210').reason).toBe(REASONS.INVALID_FIRST_DIGIT);
    // 11-digit "0" prefixed but subscriber starts with 2.
    expect(normalizeIndianPhone('02876543210').reason).toBe(REASONS.INVALID_FIRST_DIGIT);
  });

  test('11-digit that does not start with 0', () => {
    // e.g. the "+9 18575 86985" row in the wild: 91857586985 (11 digits).
    expect(normalizeIndianPhone('91857586985').reason).toBe(REASONS.NOT_INDIAN);
  });

  test('12-digit that does not start with 91', () => {
    // e.g. "+8 91229 41941" in the wild: 891229 41941 = 89122941941 (11 digits) — that's TOO_SHORT-ish, but
    // let's cover the exact 12-digit variant too:
    expect(normalizeIndianPhone('189122941941').reason).toBe(REASONS.NOT_INDIAN);
    // Iranian country code 98 — we don't support it.
    expect(normalizeIndianPhone('989876543210').reason).toBe(REASONS.NOT_INDIAN);
  });
});

describe('isCanonical', () => {
  test('true for exact 91XXXXXXXXXX with valid first digit', () => {
    expect(isCanonical('919876543210')).toBe(true);
    expect(isCanonical('916019879108')).toBe(true);
  });

  test('false for anything else', () => {
    expect(isCanonical('')).toBe(false);
    expect(isCanonical('9876543210')).toBe(false);
    expect(isCanonical('09876543210')).toBe(false);
    expect(isCanonical('+919876543210')).toBe(false); // + is not stored
    expect(isCanonical('912876543210')).toBe(false); // subscriber starts with 2
    expect(isCanonical('9198765432')).toBe(false); // too short
    expect(isCanonical(null)).toBe(false);
    expect(isCanonical(12345)).toBe(false);
  });
});

describe('formatForDisplay', () => {
  test('canonical → +91 XXXXX XXXXX', () => {
    expect(formatForDisplay('919876543210')).toBe('+91 98765 43210');
    expect(formatForDisplay('916019879108')).toBe('+91 60198 79108');
  });

  test('non-canonical → returned as-is (caller decides how to warn)', () => {
    expect(formatForDisplay('9876543210')).toBe('9876543210');
    expect(formatForDisplay('91857586985')).toBe('91857586985');
    expect(formatForDisplay('')).toBe('');
    expect(formatForDisplay(null)).toBe('');
  });
});

describe('describeReason', () => {
  test('every reason yields a non-empty user-facing message', () => {
    for (const reason of Object.values(REASONS)) {
      const msg = describeReason(reason);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test('unknown reason falls back to a generic message', () => {
    expect(describeReason('anything_else')).toMatch(/valid Indian WhatsApp number/i);
  });
});
