/**
 * Payment Verification Module
 * 
 * How it works:
 * 1. User pays via UPI (QR/PhonePe/GPay/any UPI app)
 * 2. User enters their UTR/Transaction ID
 * 3. Frontend polls /api/payment/status/:utrId every 3 seconds
 * 4. Admin (you) verifies payment from your UPI app notification and hits /api/payment/verify/:utrId
 * 5. Frontend gets "verified" status and proceeds
 * 
 * UTR Format Validation:
 * - Most UPI transactions have 12-digit numeric UTR
 * - Some banks use alphanumeric transaction refs
 * - We validate format + length to catch fake entries
 */

const { createClient } = require('@supabase/supabase-js');

function getClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

/**
 * Validate UTR format
 * Returns { valid: boolean, message: string }
 */
function validateUTR(utr) {
  if (!utr || typeof utr !== 'string') {
    return { valid: false, message: 'UTR is required' };
  }

  const cleaned = utr.trim();

  // Must be at least 6 characters
  if (cleaned.length < 6) {
    return { valid: false, message: 'UTR must be at least 6 characters' };
  }

  // Must be at most 22 characters (some banks have longer refs)
  if (cleaned.length > 22) {
    return { valid: false, message: 'UTR seems too long. Please check and re-enter.' };
  }

  // Must be alphanumeric (no special chars except hyphens)
  if (!/^[a-zA-Z0-9\-]+$/.test(cleaned)) {
    return { valid: false, message: 'UTR should only contain letters and numbers' };
  }

  return { valid: true, message: 'Valid format' };
}

/**
 * Create a payment record when user initiates payment
 */
async function createPaymentRecord(data) {
  const client = getClient();

  const { amount, plan, upiId } = data;

  const record = {
    amount,
    plan,
    upi_id: upiId || 'devtoolpro@ybl',
    status: 'pending', // pending → verified → completed
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min expiry
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
 * Submit UTR for a payment — user enters this after paying
 */
async function submitUTR(paymentId, utrId) {
  const client = getClient();

  // Validate UTR format
  const validation = validateUTR(utrId);
  if (!validation.valid) {
    return { success: false, message: validation.message };
  }

  // Check if UTR already used
  const { data: existing } = await client
    .from('payments')
    .select('id')
    .ilike('utr_id', utrId.trim())
    .eq('status', 'verified')
    .limit(1);

  if (existing && existing.length > 0) {
    return { success: false, message: 'This UTR has already been used for another payment' };
  }

  // Update payment with UTR
  const { data: updated, error } = await client
    .from('payments')
    .update({
      utr_id: utrId.trim(),
      status: 'awaiting_verification',
      utr_submitted_at: new Date().toISOString()
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
 * Check payment status (frontend polls this)
 */
async function getPaymentStatus(paymentId) {
  const client = getClient();

  const { data, error } = await client
    .from('payments')
    .select('id, status, utr_id, amount, plan, verified_at, created_at, expires_at')
    .eq('id', paymentId)
    .single();

  if (error || !data) {
    return { found: false };
  }

  // Check if expired
  if (data.status === 'pending' && new Date(data.expires_at) < new Date()) {
    await client
      .from('payments')
      .update({ status: 'expired' })
      .eq('id', data.id);
    return { found: true, status: 'expired' };
  }

  return {
    found: true,
    status: data.status,
    utrId: data.utr_id,
    amount: data.amount,
    plan: data.plan,
    verifiedAt: data.verified_at
  };
}

/**
 * Admin: Verify a payment (you call this after confirming in your UPI app)
 */
async function verifyPayment(paymentId, adminKey) {
  // Simple admin key check
  if (adminKey !== process.env.ADMIN_KEY) {
    return { success: false, message: 'Unauthorized' };
  }

  const client = getClient();

  const { data, error } = await client
    .from('payments')
    .update({
      status: 'verified',
      verified_at: new Date().toISOString()
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
 * Admin: Get all pending payments awaiting verification
 */
async function getPendingPayments(adminKey) {
  if (adminKey !== process.env.ADMIN_KEY) {
    return { success: false, message: 'Unauthorized' };
  }

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
 * Auto-verify: Check if UTR matches expected amount pattern
 * This is a basic check — not bank-level verification
 * Returns confidence score 0-100
 */
function getUTRConfidence(utr) {
  let score = 0;

  // 12-digit numeric = standard UPI UTR format (high confidence)
  if (/^\d{12}$/.test(utr)) score += 70;
  // Starts with digits and is 12-16 chars (common)
  else if (/^\d{12,16}$/.test(utr)) score += 60;
  // Alphanumeric, reasonable length
  else if (/^[A-Z0-9]{8,16}$/i.test(utr)) score += 40;
  // Has some structure
  else if (utr.length >= 6) score += 20;

  // Bonus: doesn't look like a test/fake entry
  if (!/^(test|fake|1234|0000|aaaa)/i.test(utr)) score += 15;
  // Bonus: no repeating chars
  if (!/(.)\1{4,}/.test(utr)) score += 15;

  return Math.min(score, 100);
}

module.exports = {
  validateUTR,
  createPaymentRecord,
  submitUTR,
  getPaymentStatus,
  verifyPayment,
  getPendingPayments,
  getUTRConfidence
};
