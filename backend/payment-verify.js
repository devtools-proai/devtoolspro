/**
 * Payment Verification Module
 *
 * How it works:
 * 1. User pays via UPI (QR/PhonePe/GPay/any UPI app)
 * 2. User enters their UTR/Transaction ID
 * 3. Frontend polls /api/payment/status/:paymentId every 3 seconds
 * 4. High-confidence UTRs auto-verify; the rest wait for admin verification
 * 5. Admin verifies via /api/payment/verify/:paymentId (JWT-protected route)
 *
 * UTR Format:
 *   Bank UPI UTRs are 12-digit numeric strings. We accept slightly looser
 *   alphanumeric formats (6–22 chars) to cover edge-case bank refs, but
 *   reject anything else — including hyphens / spaces / underscores — to
 *   block obvious tampering.
 */

const { getClient } = require('./db');

/**
 * Validate UTR format. Returns { valid: boolean, message: string }.
 */
function validateUTR(utr) {
  if (!utr || typeof utr !== 'string') {
    return { valid: false, message: 'UTR is required' };
  }
  const cleaned = utr.trim();
  if (cleaned.length < 6) {
    return { valid: false, message: 'UTR must be at least 6 characters' };
  }
  if (cleaned.length > 22) {
    return { valid: false, message: 'UTR seems too long. Please check and re-enter.' };
  }
  // Strict alphanumeric — no separators. Real bank UTRs do not contain
  // hyphens, and accepting them only gives users a way to dodge dedup checks
  // (e.g. `123-456-789-012` vs `123456789012`).
  if (!/^[a-zA-Z0-9]+$/.test(cleaned)) {
    return { valid: false, message: 'UTR should only contain letters and numbers' };
  }
  return { valid: true, message: 'Valid format' };
}

/**
 * Create a payment record when user initiates payment.
 *
 * userId is required (the route enforces auth before calling here).
 * Stored on the payment row so the duplicate-session guard and the
 * /api/payment/submit-utr ownership check can scope queries by user.
 */
async function createPaymentRecord({ amount, plan, upiId, userId }) {
  const client = getClient();

  const record = {
    user_id: userId || null,
    amount,
    plan,
    upi_id: upiId || 'devtoolpro@ybl',
    status: 'pending', // pending → awaiting_verification → verified
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min expiry
  };

  const { data: inserted, error } = await client
    .from('payments')
    .insert(record)
    .select()
    .single();

  if (error) {
    console.error('Create payment error:', error.message);
    return { success: false, message: error.message };
  }

  return { success: true, paymentId: inserted.id, record: inserted };
}

/**
 * Look up the user's most recent non-terminal payment row, if any.
 * Used by /api/payment/create to detect a duplicate session before
 * inserting a new one. Returns:
 *   - null              — no open session, OK to create a new payment
 *   - { row, isStale }  — open session exists; isStale=true means the
 *                         pending row's expires_at has passed and the
 *                         caller should treat it as effectively gone
 */
async function findOpenPaymentForUser(userId) {
  if (!userId) return null;
  const client = getClient();
  const { data, error } = await client
    .from('payments')
    .select('id, status, plan, amount, expires_at, created_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'awaiting_verification'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('findOpenPaymentForUser warning:', error.message || error);
    return null;
  }
  const row = (data || [])[0];
  if (!row) return null;
  if (row.status === 'awaiting_verification') return { row, isStale: false };
  // pending → check expiry
  const isStale = new Date(row.expires_at).getTime() <= Date.now();
  return { row, isStale };
}

/**
 * Attach a UTR to an existing payment row.
 */
async function submitUTR(paymentId, utrId) {
  const client = getClient();

  const validation = validateUTR(utrId);
  if (!validation.valid) {
    return { success: false, message: validation.message };
  }

  // Reject UTRs that have already been used for a verified payment.
  const { data: existing } = await client
    .from('payments')
    .select('id')
    .ilike('utr_id', utrId.trim())
    .eq('status', 'verified')
    .limit(1);

  if (existing && existing.length > 0) {
    return { success: false, message: 'This UTR has already been used for another payment' };
  }

  const { data: updated, error } = await client
    .from('payments')
    .update({
      utr_id: utrId.trim(),
      status: 'awaiting_verification',
      utr_submitted_at: new Date().toISOString(),
    })
    .eq('id', paymentId)
    .select()
    .single();

  if (error) {
    return { success: false, message: 'Failed to submit UTR' };
  }

  return { success: true, status: 'awaiting_verification', record: updated };
}

/**
 * Check payment status (frontend polls this).
 *
 * Returns `justExpired: true` when this call is the one that flipped the
 * row from pending → expired, so the caller can fire a one-shot Slack
 * alert without us having to scan the DB on a cron.
 */
async function getPaymentStatus(paymentId) {
  const client = getClient();

  const { data, error } = await client
    .from('payments')
    .select('id, user_id, status, utr_id, amount, plan, verified_at, created_at, expires_at')
    .eq('id', paymentId)
    .single();

  if (error || !data) {
    return { found: false };
  }

  // Auto-expire stale pending rows.
  if (data.status === 'pending' && new Date(data.expires_at) < new Date()) {
    await client.from('payments').update({ status: 'expired' }).eq('id', data.id);
    return {
      found: true,
      status: 'expired',
      justExpired: true,
      userId: data.user_id || null,
      paymentId: data.id,
      plan: data.plan,
      amount: data.amount,
    };
  }

  return {
    found: true,
    status: data.status,
    utrId: data.utr_id,
    amount: data.amount,
    plan: data.plan,
    verifiedAt: data.verified_at,
  };
}

/**
 * Mark a payment as verified. Caller is responsible for authorization —
 * route handlers MUST gate this behind admin auth. The function itself
 * deliberately accepts no credential argument so the auth model is
 * single-sourced at the route layer.
 */
async function verifyPayment(paymentId) {
  const client = getClient();

  const { data, error } = await client
    .from('payments')
    .update({
      status: 'verified',
      verified_at: new Date().toISOString(),
    })
    .eq('id', paymentId)
    .in('status', ['awaiting_verification', 'pending'])
    .select()
    .single();

  if (error || !data) {
    return { success: false, message: 'Payment not found or already processed' };
  }

  return { success: true, record: data };
}

/**
 * Get all payments awaiting verification. Admin-only — guard at route layer.
 */
async function getPendingPayments() {
  const client = getClient();

  const { data, error } = await client
    .from('payments')
    .select('*')
    .in('status', ['awaiting_verification', 'pending'])
    .order('created_at', { ascending: false });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, payments: data || [] };
}

/**
 * Return the user_id stored on a payment row, or null if the row
 * doesn't exist. Used by /api/payment/submit-utr to verify the
 * caller owns the paymentId before letting them attach a UTR.
 *
 * Legacy rows created before user_id was added will return null;
 * the calling route treats that as "pre-binding era, allow it" for
 * backwards compat. Newly created rows always have user_id set.
 */
async function getPaymentOwner(paymentId) {
  const client = getClient();
  const { data, error } = await client
    .from('payments')
    .select('user_id, status')
    .eq('id', paymentId)
    .single();
  if (error || !data) return null;
  return { userId: data.user_id || null, status: data.status };
}

/**
 * UTR confidence score (0-100). We auto-verify high-confidence values to
 * reduce manual workload, but the threshold is intentionally conservative.
 *
 * Scoring:
 *   - 12-digit numeric            +70   (standard UPI UTR format)
 *   - longer numeric (12-16)      +60   (rare bank variants)
 *   - alphanumeric 8-16           +40   (edge cases)
 *   - anything ≥6 chars           +20
 *   - bonus if no "test/fake/1234/0000/aaaa" prefix  +15
 *   - bonus if no 5+ char run of the same character  +15
 *
 * A clean 12-digit UTR scores 100. Repeating patterns and obvious test
 * strings cap at 85, which sits below our 95 auto-verify threshold.
 */
function getUTRConfidence(utr) {
  let score = 0;
  if (/^\d{12}$/.test(utr)) score += 70;
  else if (/^\d{12,16}$/.test(utr)) score += 60;
  else if (/^[A-Z0-9]{8,16}$/i.test(utr)) score += 40;
  else if (utr.length >= 6) score += 20;

  if (!/^(test|fake|1234|0000|aaaa)/i.test(utr)) score += 15;
  if (!/(.)\1{4,}/.test(utr)) score += 15;

  return Math.min(score, 100);
}

module.exports = {
  validateUTR,
  createPaymentRecord,
  findOpenPaymentForUser,
  getPaymentOwner,
  submitUTR,
  getPaymentStatus,
  verifyPayment,
  getPendingPayments,
  getUTRConfidence,
};
