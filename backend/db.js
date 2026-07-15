/**
 * Supabase PostgreSQL Database Module
 * Free tier: 500MB storage, unlimited API requests
 * 
 * Setup: https://supabase.com → New Project → Get URL + anon key
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase;

/**
 * Resilient fetch wrapper.
 * Retries on transient network errors ("Premature close", "fetch failed",
 * "ECONNRESET", "socket hang up") that happen when Render's idle keep-alive
 * connections are dropped by Supabase's load balancer.
 */
async function resilientFetch(url, options = {}, attempt = 1) {
  const MAX_ATTEMPTS = 3;

  // Merge headers safely. supabase-js may pass a Headers instance, a plain
  // object, or an array of [k,v] pairs — `new Headers(...)` handles all three.
  // (A naive `{ ...options.headers }` silently drops everything when the
  // input is a Headers instance, which strips apikey/Authorization.)
  const headers = new Headers(options.headers || {});
  headers.set('connection', 'close');

  try {
    return await fetch(url, { ...options, headers });
  } catch (err) {
    const msg = String(err && (err.message || err));
    const cause = String((err && err.cause && err.cause.message) || '');
    const transient = /Premature close|fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|other side closed/i
      .test(msg + ' ' + cause);

    if (transient && attempt < MAX_ATTEMPTS) {
      const backoff = 200 * attempt; // 200ms, 400ms
      console.warn(`Supabase fetch transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${msg}. Retrying in ${backoff}ms...`);
      await new Promise(r => setTimeout(r, backoff));
      return resilientFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

function getClient() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY must be set in environment variables');
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: resilientFetch },
      auth: { persistSession: false }
    });
  }
  return supabase;
}

/**
 * Decode the Supabase API key (a JWT) to determine which role it
 * represents. Both `anon` and `service_role` keys are JWTs — the
 * payload contains a `role` claim we can read without hitting the DB.
 *
 * The `service_role` key bypasses RLS. The `anon` key doesn't and
 * will hit every default-deny RLS policy in the project. If someone
 * accidentally sets SUPABASE_KEY to the anon key, most tables might
 * still "seem to work" (older RLS-disabled tables, permissive
 * policies) but every RLS-strict table will fail with 42501.
 *
 * Returns 'service_role' | 'anon' | 'unknown'.
 */
function detectKeyRole(key) {
  if (!key || typeof key !== 'string') return 'unknown';
  const parts = key.split('.');
  if (parts.length !== 3) return 'unknown';
  try {
    // JWT payload is base64url-encoded; convert to standard base64 first.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (payload.role === 'service_role') return 'service_role';
    if (payload.role === 'anon') return 'anon';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Initialize database — creates the table if it doesn't exist.
 * Run this once via `npm run setup-db` or the first time the server starts.
 */
async function initDB() {
  // Detect the API key type BEFORE we try any queries so the boot log
  // makes it obvious when the wrong key is configured. Historically the
  // most confusing production issue is someone pasting the anon key
  // into SUPABASE_KEY — everything on RLS-off tables still works, but
  // RLS-strict tables all 42501 with a "permission denied" that's easy
  // to misdiagnose. Fail loud, fail early.
  const keyRole = detectKeyRole(SUPABASE_KEY);
  if (keyRole === 'anon') {
    console.error('❌ SUPABASE_KEY is the ANON key, not the SERVICE_ROLE key.');
    console.error('   Every write to an RLS-protected table will fail with permission denied (42501).');
    console.error('   Go to Supabase Dashboard → Settings → API and copy the "service_role" secret');
    console.error('   into SUPABASE_KEY (on Render / your env). Do NOT ship the anon key server-side.');
    process.exit(1);
  } else if (keyRole === 'unknown') {
    console.warn('⚠️  Could not determine SUPABASE_KEY role from its JWT payload.');
    console.warn('   If admin writes fail with 42501, verify the key in the Supabase dashboard.');
  } else {
    console.log('✅ SUPABASE_KEY detected as service_role — RLS bypass confirmed.');
  }

  try {
    const client = getClient();
    // Test connection by querying the table
    const { error } = await client.from('submissions').select('id').limit(1);
    if (error && error.code === '42P01') {
      // Table doesn't exist — user needs to run the SQL setup
      console.error('❌ Table "submissions" does not exist. Run the SQL setup script in Supabase dashboard.');
      console.error('   See setup-db.sql for the required schema.');
      process.exit(1);
    } else if (error) {
      console.error('❌ Supabase connection error:', error.message);
      process.exit(1);
    }
    console.log('✅ Supabase connected — "submissions" table ready');
  } catch (err) {
    console.error('❌ Failed to initialize database:', err.message);
    process.exit(1);
  }
}

/**
 * Add a new submission
 */
async function addSubmission(submission) {
  const client = getClient();

  // Check for duplicate UTR
  const { data: existing } = await client
    .from('submissions')
    .select('id')
    .ilike('utr_id', submission.utrId)
    .limit(1);

  if (existing && existing.length > 0) {
    return { success: false, error: 'duplicate', message: 'UTR already exists' };
  }

  // Calculate subscription dates
  const startDate = new Date(submission.submissionTimestamp);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);
  if (endDate.getDate() !== startDate.getDate()) {
    endDate.setDate(0);
  }

  const record = {
    id: submission.id,
    first_name: submission.firstName,
    last_name: submission.lastName,
    email: submission.email,
    selected_plan: submission.selectedPlan,
    utr_id: submission.utrId,
    submission_timestamp: submission.submissionTimestamp,
    subscription_start: startDate.toISOString(),
    subscription_end: endDate.toISOString(),
    status: 'Active',
    meet_link: submission.meetLink || null,
    meet_scheduled: false,
    notes: submission.notes || ''
  };

  const { data, error } = await client
    .from('submissions')
    .insert(record)
    .select()
    .single();

  if (error) {
    console.error('Insert error:', error.message);
    return { success: false, error: 'write_failed', message: 'Failed to save: ' + error.message };
  }

  return { success: true, record: formatRecord(data) };
}

/**
 * Get all submissions
 */
async function getAllSubmissions() {
  const client = getClient();
  const { data, error } = await client
    .from('submissions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Read error:', error.message);
    return [];
  }
  return (data || []).map(formatRecord);
}

/**
 * Get submission by ID
 */
async function getSubmissionById(id) {
  const client = getClient();
  const { data, error } = await client
    .from('submissions')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return null;
  return formatRecord(data);
}

/**
 * Get submission by UTR
 */
async function getSubmissionByUTR(utrId) {
  const client = getClient();
  const { data, error } = await client
    .from('submissions')
    .select('*')
    .ilike('utr_id', utrId)
    .single();

  if (error) return null;
  return formatRecord(data);
}

/**
 * Update submission status
 */
async function updateSubmissionStatus(id, status) {
  const client = getClient();
  const { data, error } = await client
    .from('submissions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return null;
  return formatRecord(data);
}

/**
 * Get stats
 */
async function getStats() {
  const client = getClient();
  const { data, error } = await client
    .from('submissions')
    .select('status, created_at');

  if (error) return { total: 0, active: 0, expired: 0, lastSubmission: null };

  const records = data || [];
  const active = records.filter(r => r.status === 'Active').length;
  const expired = records.filter(r => r.status === 'Expired').length;
  const lastSubmission = records.length > 0
    ? records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].created_at
    : null;

  return { total: records.length, active, expired, lastSubmission };
}

/**
 * Convert DB snake_case row to camelCase for API responses
 */
function formatRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    selectedPlan: row.selected_plan,
    utrId: row.utr_id,
    submissionTimestamp: row.submission_timestamp,
    subscriptionStart: row.subscription_start,
    subscriptionEnd: row.subscription_end,
    status: row.status,
    meetLink: row.meet_link,
    meetScheduled: row.meet_scheduled,
    notes: row.notes,
    createdAt: row.created_at
  };
}

// Cache the detection at module load so callers don't re-decode
// every time. SUPABASE_KEY is read at module init; if you rotate it
// you have to restart the server anyway.
const DETECTED_KEY_ROLE = detectKeyRole(SUPABASE_KEY);

/**
 * Returns 'service_role' | 'anon' | 'unknown'. Used by the admin
 * diagnostic endpoint and by the notifications error handler to
 * pinpoint permission-denied causes without a DB round-trip.
 */
function getKeyRole() {
  return DETECTED_KEY_ROLE;
}

module.exports = {
  initDB,
  addSubmission,
  getAllSubmissions,
  getSubmissionById,
  getSubmissionByUTR,
  updateSubmissionStatus,
  getStats,
  getClient,
  getKeyRole,
  detectKeyRole,  // exported for unit tests only
};
