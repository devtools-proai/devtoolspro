/**
 * Security-critical unit tests.
 * Covers the surface area flagged in the v1.1 security review:
 *   - UTR validator strictness
 *   - UTR confidence scoring (auto-verify gating)
 *   - Plan price consistency vs the public pricing card data
 */

const { validateUTR, getUTRConfidence } = require('../payment-verify');
const { PLAN_HIERARCHY } = require('../plan-hierarchy');

describe('validateUTR', () => {
  test('rejects empty / non-string', () => {
    expect(validateUTR('').valid).toBe(false);
    expect(validateUTR(null).valid).toBe(false);
    expect(validateUTR(undefined).valid).toBe(false);
    expect(validateUTR(12345).valid).toBe(false);
  });

  test('rejects too short (<6) and too long (>22) UTRs', () => {
    expect(validateUTR('12345').valid).toBe(false);
    expect(validateUTR('a'.repeat(23)).valid).toBe(false);
  });

  test('rejects hyphens, spaces, and other separators', () => {
    expect(validateUTR('123-456-789-012').valid).toBe(false);
    expect(validateUTR('123 456 789 012').valid).toBe(false);
    expect(validateUTR('abc_def_123').valid).toBe(false);
    expect(validateUTR('abc.def').valid).toBe(false);
  });

  test('accepts the standard 12-digit UTR format', () => {
    expect(validateUTR('412345678901').valid).toBe(true);
  });

  test('accepts alphanumeric bank refs in range', () => {
    expect(validateUTR('ABCD1234EFGH').valid).toBe(true);
  });

  test('trims whitespace before validating', () => {
    expect(validateUTR('  412345678901  ').valid).toBe(true);
  });
});

describe('getUTRConfidence', () => {
  test('clean 12-digit UTR scores 100', () => {
    // 12 digits + not starting with test/fake/1234/0000/aaaa + no 5+ run
    expect(getUTRConfidence('512345678901')).toBe(100);
  });

  test('UTR starting with 1234 is penalised below auto-verify threshold', () => {
    // 70 (12-digit) + 0 (1234 prefix) + 15 (no long runs) = 85
    expect(getUTRConfidence('123456789012')).toBe(85);
  });

  test('UTR with 5+ repeating characters is penalised', () => {
    // 70 + 15 - 15 (has run of 6 zeros) = 70
    expect(getUTRConfidence('600000098765')).toBeLessThan(95);
  });

  test('obvious test strings score low', () => {
    expect(getUTRConfidence('testtest')).toBeLessThan(95);
    expect(getUTRConfidence('fake1234ABC')).toBeLessThan(95);
  });

  test('non-numeric short strings score very low', () => {
    expect(getUTRConfidence('abc123')).toBeLessThanOrEqual(50);
  });

  test('caps at 100', () => {
    expect(getUTRConfidence('512345678901')).toBeLessThanOrEqual(100);
  });
});

describe('PLAN_HIERARCHY pricing', () => {
  test('USD prices follow the 10/20/50/100 ladder', () => {
    expect(PLAN_HIERARCHY.find(p => p.name === 'Pro').priceUSD).toBe(10);
    expect(PLAN_HIERARCHY.find(p => p.name === 'Pro+').priceUSD).toBe(20);
    expect(PLAN_HIERARCHY.find(p => p.name === 'Pro Max').priceUSD).toBe(50);
    expect(PLAN_HIERARCHY.find(p => p.name === 'Power').priceUSD).toBe(100);
  });

  test('INR prices match the public pricing cards', () => {
    // These must mirror the data-amount / data-inr-discounted attrs on
    // dashboard.html and index.html. Drift breaks the user dashboard's
    // prorated maths.
    expect(PLAN_HIERARCHY.find(p => p.name === 'Pro').price).toBe(946);
    expect(PLAN_HIERARCHY.find(p => p.name === 'Pro+').price).toBe(1892);
    expect(PLAN_HIERARCHY.find(p => p.name === 'Pro Max').price).toBe(4731);
    expect(PLAN_HIERARCHY.find(p => p.name === 'Power').price).toBe(9461);
  });

  test('INR-to-USD ratios are roughly consistent', () => {
    // Rough sanity check — every plan's INR price should be ~94x its USD
    // price. Any wider drift means a typo somewhere.
    for (const plan of PLAN_HIERARCHY) {
      const ratio = plan.price / plan.priceUSD;
      expect(ratio).toBeGreaterThan(90);
      expect(ratio).toBeLessThan(98);
    }
  });
});
