/**
 * Indian WhatsApp number normalisation.
 *
 * Single source of truth for anywhere a phone number enters the
 * system — registration, admin edit, imports, backfills. Everything
 * ends up in the canonical form `91XXXXXXXXXX` (12 digits total,
 * no separators, country code always present).
 *
 * The rules mirror TRAI mobile numbering:
 *   • Country code 91
 *   • 10-digit subscriber number
 *   • First digit of the subscriber number is 6, 7, 8, or 9
 *
 * We accept and normalise any of these inputs:
 *   • `+91 98765 43210`   → `919876543210`
 *   • `+919876543210`     → `919876543210`
 *   • `919876543210`      → `919876543210`
 *   • `09876543210`       → `919876543210`   (leading STD 0)
 *   • `9876543210`        → `919876543210`   (bare 10-digit)
 *
 * We REJECT (with a machine-readable reason) any input we can't
 * safely resolve — nine-digit numbers, non-Indian country codes,
 * numbers starting with 0-5, etc. The caller surfaces the reason
 * to the user with a helpful message.
 */

// Valid Indian mobile subscriber-number first digit.
const VALID_FIRST_DIGIT = /^[6-9]$/;

// Reasons returned in the `reason` field. Kept as short codes so
// callers can localise error messages without regexing the text.
const REASONS = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  TOO_SHORT: 'too_short',
  TOO_LONG: 'too_long',
  INVALID_FIRST_DIGIT: 'invalid_first_digit',
  NOT_INDIAN: 'not_indian',
});

/**
 * Strip everything that isn't a digit. Country-code plus-sign,
 * hyphens, spaces, parens all disappear here.
 */
function toDigits(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/\D+/g, '');
}

/**
 * Normalise an Indian phone number to `91XXXXXXXXXX`.
 *
 * Returns:
 *   { valid: true,  normalized: '91XXXXXXXXXX', reason: 'ok' }
 *   { valid: false, normalized: null,           reason: '<one of REASONS>' }
 *
 * Callers should treat `reason` as advisory — do not concatenate it
 * into user-facing text. Use `describeReason(reason)` for that.
 */
function normalizeIndianPhone(input) {
  const digits = toDigits(input);

  if (!digits) return fail(REASONS.EMPTY);

  // Reject anything too short to POSSIBLY be a valid Indian mobile.
  if (digits.length < 10) return fail(REASONS.TOO_SHORT);
  // Anything past 12 digits either has extra junk (garbage input) or
  // is a non-Indian number we don't support.
  if (digits.length > 12) return fail(REASONS.TOO_LONG);

  let subscriber;

  if (digits.length === 10) {
    // Bare 10-digit subscriber number. Common when users type just
    // "9876543210" without the country code.
    subscriber = digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // Legacy STD dialling — drop the leading 0.
    subscriber = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    // Already country-coded. Strip 91 to validate the subscriber part.
    subscriber = digits.slice(2);
  } else {
    // 11-digit that doesn't start with 0, or 12-digit that doesn't
    // start with 91. Either way we can't safely treat it as Indian
    // — reject rather than mangle it into something wrong.
    return fail(REASONS.NOT_INDIAN);
  }

  if (subscriber.length !== 10) {
    // Belt-and-braces: every branch above should hand us 10 digits.
    return fail(REASONS.TOO_SHORT);
  }
  if (!VALID_FIRST_DIGIT.test(subscriber[0])) {
    return fail(REASONS.INVALID_FIRST_DIGIT);
  }

  return { valid: true, normalized: '91' + subscriber, reason: REASONS.OK };
}

/**
 * Machine-readable → human-readable. Copy-writing lives here so
 * the same wording is used across auth + admin + slack alerts.
 */
function describeReason(reason) {
  switch (reason) {
    case REASONS.EMPTY:
      return 'WhatsApp number is required.';
    case REASONS.TOO_SHORT:
      return 'That doesn\'t look like a full 10-digit Indian mobile number. Example: +91 98765 43210.';
    case REASONS.TOO_LONG:
      return 'Too many digits. Please enter a 10-digit Indian mobile number (with or without +91).';
    case REASONS.INVALID_FIRST_DIGIT:
      return 'Indian mobile numbers must start with 6, 7, 8, or 9. Please double-check the number.';
    case REASONS.NOT_INDIAN:
      return 'We currently support Indian (+91) WhatsApp numbers only. Please enter a 10-digit Indian mobile.';
    default:
      return 'Please enter a valid Indian WhatsApp number.';
  }
}

/**
 * True iff `stored` is already in the canonical form. Used by admin
 * display and by the users-table backfill to skip rows that are
 * already good.
 */
function isCanonical(stored) {
  if (!stored || typeof stored !== 'string') return false;
  if (!/^91[6-9]\d{9}$/.test(stored)) return false;
  return true;
}

/**
 * Format a canonical number for display: `+91 XXXXX XXXXX`. Returns
 * the raw string unchanged if it isn't canonical, so the caller can
 * decide whether to show it with an invalid-warning affordance.
 */
function formatForDisplay(stored) {
  if (!isCanonical(stored)) return stored || '';
  // stored is exactly 12 chars: 91 + 10-digit subscriber.
  const sub = stored.slice(2);
  return `+91 ${sub.slice(0, 5)} ${sub.slice(5)}`;
}

function fail(reason) {
  return { valid: false, normalized: null, reason };
}

module.exports = {
  REASONS,
  toDigits,
  normalizeIndianPhone,
  describeReason,
  isCanonical,
  formatForDisplay,
};
