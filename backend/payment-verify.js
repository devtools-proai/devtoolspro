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

const crypto = require('crypto');
const { getClient } = require('./db');

// ─── Screenshot upload configuration ────────────────────────────────
// Kept lax on the server side (we let the client compress before
// upload) but capped so a hostile client can't force us to swallow a
// 20MB image. If you raise this, also raise the JSON body limit on
// the /api/payment/upload-screenshot route in server.js.
const SCREENSHOT_MAX_BYTES = 800 * 1024; // 800KB post-decode
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

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

/* ═══════════════════════════════════════════════════════════════
 * Screenshot upload + verification
 * ─────────────────────────────────────────────────────────────── */

/**
 * Parse a "data:image/xxx;base64,YYYY" string into { mime, buffer }.
 * Returns null on any format error.
 */
function parseDataUrl(str) {
  if (typeof str !== 'string') return null;
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(str);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  try {
    // Node's Buffer.from ignores whitespace + accepts standard base64.
    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer || buffer.length === 0) return null;
    return { mime, buffer };
  } catch {
    return null;
  }
}

/**
 * Score how well the OCR'd values line up with the ground truth.
 *
 * Inputs:
 *   userUtr           — the UTR the user typed into the form
 *   expectedAmount    — payments.amount for the row
 *   extractedUtr      — the UTR the client-side OCR pulled out
 *                       (null if OCR didn't find one)
 *   extractedAmount   — the amount the client-side OCR pulled out
 *
 * Returns 0-100. Both values matching = 100. UTR matching but amount
 * missing/off = 70. UTR mismatch = 0 (fail-closed).
 *
 * This is a UX / audit signal — the actual fraud gate is
 *   (a) the user-entered UTR passes format validation + isn't a
 *       reused verified UTR, AND
 *   (b) the screenshot's sha256 isn't a reused screenshot.
 */
function computeScreenshotMatchScore({ userUtr, expectedAmount, extractedUtr, extractedAmount }) {
  const u = String(userUtr || '').replace(/\s+/g, '').toLowerCase();
  const eu = String(extractedUtr || '').replace(/\s+/g, '').toLowerCase();
  if (!u || !eu) {
    // No extraction — neutral, admin will review visually.
    return 40;
  }
  if (u !== eu) {
    // The screenshot's UTR doesn't match what the user typed. This is
    // the strongest fraud signal we can produce automatically.
    return 0;
  }
  // UTR matches. Grade the amount separately.
  const exp = Number(expectedAmount);
  const got = Number(extractedAmount);
  if (!Number.isFinite(got) || !Number.isFinite(exp)) return 70;
  const diff = Math.abs(got - exp);
  // Within ₹1 = perfect. Within ₹5 = 90 (rounding differences in some
  // UPI apps). Otherwise degrade linearly.
  if (diff <= 1) return 100;
  if (diff <= 5) return 90;
  if (diff <= 25) return 75;
  return 50;
}

/**
 * Validate + normalise the incoming screenshot payload. Returns
 *   { valid: true, mime, buffer, sha256, base64Body }
 *   { valid: false, message, status? }
 */
function prepareScreenshotUpload(imageDataUrl) {
  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) {
    return { valid: false, message: 'Screenshot must be a data:image/...;base64,... URL' };
  }
  if (!ALLOWED_MIME.has(parsed.mime)) {
    return { valid: false, message: 'Screenshot must be JPEG, PNG, or WebP' };
  }
  if (parsed.buffer.length > SCREENSHOT_MAX_BYTES) {
    return {
      valid: false,
      message: `Screenshot too large (${(parsed.buffer.length / 1024).toFixed(0)}KB). Please compress to under ${(SCREENSHOT_MAX_BYTES / 1024).toFixed(0)}KB.`,
    };
  }
  const sha256 = crypto.createHash('sha256').update(parsed.buffer).digest('hex');
  const base64Body = parsed.buffer.toString('base64');
  return {
    valid: true,
    mime: parsed.mime,
    buffer: parsed.buffer,
    sha256,
    base64Body,
  };
}

/**
 * Reject known-fraudulent duplicate screenshots. Returns
 *   { duplicate: false }                       — good to proceed
 *   { duplicate: true, previousPaymentId }     — same image already used
 *
 * The check is scoped ACROSS all users — the same screenshot re-uploaded
 * by a different account is the exact fraud pattern we want to catch.
 * We prefer the payments-table check because it's guaranteed indexed;
 * the payment_screenshots.sha256 UNIQUE index is the second-line defence
 * that catches races between two near-simultaneous uploads.
 */
async function checkScreenshotDuplicate(sha256, currentPaymentId) {
  if (!sha256) return { duplicate: false };
  const client = getClient();
  const { data, error } = await client
    .from('payments')
    .select('id, user_id, status, created_at')
    .eq('screenshot_sha256', sha256)
    .neq('id', currentPaymentId)
    .limit(1);
  if (error) {
    console.warn('checkScreenshotDuplicate warning:', error.message || error);
    return { duplicate: false };
  }
  const hit = (data || [])[0];
  if (!hit) return { duplicate: false };
  return { duplicate: true, previousPaymentId: hit.id, previousStatus: hit.status };
}

/**
 * Persist the screenshot blob (payment_screenshots) plus its metadata
 * on the payments row. Called AFTER prepareScreenshotUpload +
 * checkScreenshotDuplicate have passed.
 *
 * Also updates the payments row with the extracted OCR values +
 * computed match score, and finally attaches the UTR via submitUTR.
 * This is the single-transaction entry point the route handler uses.
 *
 * Returns { success, matchScore, isDuplicateUtr?, message? }
 */
async function attachScreenshotAndSubmitUTR({
  paymentId,
  userId,
  utrId,
  imageDataUrl,
  extractedUtr,
  extractedAmount,
}) {
  const prep = prepareScreenshotUpload(imageDataUrl);
  if (!prep.valid) return { success: false, message: prep.message };

  // Validate UTR format up front — no point uploading anything if
  // the UTR itself is malformed.
  const utrCheck = validateUTR(utrId);
  if (!utrCheck.valid) return { success: false, message: utrCheck.message };

  const client = getClient();

  // Pull the payment row so we can (a) confirm ownership, (b) compute
  // the match score against the expected amount, and (c) reject if
  // the payment is already verified / expired / failed.
  const { data: paymentRow, error: pErr } = await client
    .from('payments')
    .select('id, user_id, amount, status, plan')
    .eq('id', paymentId)
    .maybeSingle();
  if (pErr || !paymentRow) {
    return { success: false, message: 'Payment not found' };
  }
  if (paymentRow.user_id && paymentRow.user_id !== userId) {
    return { success: false, message: 'Payment is not yours' };
  }
  if (!['pending', 'awaiting_verification'].includes(paymentRow.status)) {
    return { success: false, message: `Payment is already ${paymentRow.status}` };
  }

  // Duplicate-screenshot fraud check.
  const dup = await checkScreenshotDuplicate(prep.sha256, paymentId);
  if (dup.duplicate) {
    return {
      success: false,
      message: 'This screenshot has already been used for another payment. Please upload the actual receipt for THIS transaction.',
      code: 'DUPLICATE_SCREENSHOT',
    };
  }

  const matchScore = computeScreenshotMatchScore({
    userUtr: utrCheck.valid ? utrId.trim() : null,
    expectedAmount: paymentRow.amount,
    extractedUtr,
    extractedAmount,
  });

  // Reject up front if the OCR proved the screenshot doesn't match the
  // typed UTR. Score 0 means we're confident the two don't line up.
  if (matchScore === 0) {
    return {
      success: false,
      message: "The UTR we found in your screenshot doesn't match the one you typed. Please double-check both.",
      code: 'UTR_MISMATCH_IN_SCREENSHOT',
    };
  }

  // Insert the screenshot blob first. If this fails (duplicate sha256
  // race, storage error) we bail out BEFORE mutating the payments row
  // so retries stay clean.
  const dataUrl = `data:${prep.mime};base64,${prep.base64Body}`;
  const { error: shotErr } = await client
    .from('payment_screenshots')
    .upsert(
      {
        payment_id: paymentId,
        user_id: userId,
        image_data: dataUrl,
        mime_type: prep.mime,
        sha256: prep.sha256,
        byte_length: prep.buffer.length,
      },
      { onConflict: 'payment_id' }
    );

  if (shotErr) {
    // 23505 = unique_violation. Most likely the sha256 uniqueness
    // triggered because two clients are racing the same duplicate;
    // surface that as a clean 409 rather than a generic 500.
    if (shotErr.code === '23505' || /duplicate key/i.test(shotErr.message || '')) {
      return {
        success: false,
        message: 'This screenshot has already been used for another payment. Please upload the actual receipt for THIS transaction.',
        code: 'DUPLICATE_SCREENSHOT',
      };
    }
    console.error('payment_screenshots insert error:', shotErr.message || shotErr);
    return { success: false, message: 'Failed to store screenshot. Please try again.' };
  }

  // Stamp the payments row with the screenshot metadata BEFORE calling
  // submitUTR — that way even if the UTR write later fails, the admin
  // can still see the uploaded screenshot on the pending payment.
  const { error: metaErr } = await client
    .from('payments')
    .update({
      screenshot_uploaded_at: new Date().toISOString(),
      screenshot_sha256: prep.sha256,
      screenshot_extracted_utr: extractedUtr ? String(extractedUtr).trim().slice(0, 40) : null,
      screenshot_extracted_amount: Number.isFinite(Number(extractedAmount))
        ? Number(extractedAmount)
        : null,
      screenshot_extracted_at: new Date().toISOString(),
      screenshot_match_score: matchScore,
    })
    .eq('id', paymentId);
  if (metaErr) {
    console.warn('payments metadata update warning:', metaErr.message || metaErr);
    // Non-fatal: the blob is stored, the admin can still verify manually.
  }

  // Attach the UTR (this is what flips the row to awaiting_verification
  // and runs the "UTR already used for verified payment" check).
  const utrResult = await submitUTR(paymentId, utrId);
  if (!utrResult.success) {
    // The screenshot is already stored; we deliberately keep it so
    // admins can see the evidence of the attempted UTR submission.
    return { success: false, message: utrResult.message, code: 'UTR_SUBMIT_FAILED' };
  }

  return {
    success: true,
    matchScore,
    record: utrResult.record,
  };
}

/**
 * Fetch the raw screenshot blob for a payment. Admin-only —
 * gate at the route layer. Returns { found, imageData, mime, sha256,
 * uploadedAt, matchScore } or { found: false }.
 */
async function getScreenshotForAdmin(paymentId) {
  const client = getClient();
  const { data, error } = await client
    .from('payment_screenshots')
    .select('image_data, mime_type, sha256, byte_length, created_at')
    .eq('payment_id', paymentId)
    .maybeSingle();
  if (error) {
    console.error('getScreenshotForAdmin error:', error.message || error);
    return { found: false };
  }
  if (!data) return { found: false };
  return {
    found: true,
    imageData: data.image_data,
    mime: data.mime_type,
    sha256: data.sha256,
    byteLength: data.byte_length,
    uploadedAt: data.created_at,
  };
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
  // Screenshot helpers
  attachScreenshotAndSubmitUTR,
  getScreenshotForAdmin,
  computeScreenshotMatchScore,
  prepareScreenshotUpload,
  checkScreenshotDuplicate,
  SCREENSHOT_MAX_BYTES,
};
