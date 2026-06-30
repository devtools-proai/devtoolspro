/**
 * DevTools Pro Backend Server
 *
 * Replaces Google Sheets with Supabase PostgreSQL.
 * Automatically attaches Google Meet links and setup notes.
 *
 * Deploy to: Render.com (free), Railway, or any Node.js host
 */

require('dotenv').config();

// Render's Node 18 needs fetch polyfill for DNS resolution
globalThis.fetch = require('cross-fetch');
globalThis.Headers = require('cross-fetch').Headers;
globalThis.Request = require('cross-fetch').Request;
globalThis.Response = require('cross-fetch').Response;

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { initDB, addSubmission, getAllSubmissions, getSubmissionByUTR, getStats, getClient } = require('./db');
const { generateSetupMessage, generateQuickReply } = require('./meet-service');
const {
  createPaymentRecord, findOpenPaymentForUser, getPaymentOwner,
  submitUTR, getPaymentStatus, verifyPayment,
  getPendingPayments, getUTRConfidence,
} = require('./payment-verify');
const { isValidMeetUrl } = require('./meet-service');
const {
  verifyGoogleToken, findOrCreateUser, generateSessionToken, requireAuth,
  GOOGLE_CLIENT_ID, adminCredsConfigured, verifyAdminCreds,
  generateAdminToken, requireAdminAuth,
} = require('./auth');
const slack = require('./slack-notify');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Trust the first reverse proxy (Render, Railway etc.) — required so that
// express-rate-limit fingerprints the real client IP from X-Forwarded-For
// instead of the proxy's IP.
app.set('trust proxy', 1);

// ─── Security headers (helmet) ───
// We disable a few defaults that interfere with the static-CDN frontend
// (Tailwind / qrcodejs / Google Sign-In). CSP is intentionally off for now;
// it deserves its own pass with a curated allow-list once the CDN deps are
// vendored into a build step.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ─── CORS ───
// FRONTEND_URL may be a comma-separated list of allowed origins. Production
// fails closed (must be configured); development falls back to "permissive
// when unconfigured" so contributors aren't blocked.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                      // server-to-server / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (!IS_PROD && allowedOrigins.length === 0) return cb(null, true); // dev convenience
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  // DELETE is required by the admin registry's soft-delete action; without
  // it the browser's CORS preflight blocks the request and the network
  // call surfaces as a generic "Failed to fetch" with no useful error.
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}));

// Hard cap on request body so badly-formed clients can't memory-pressure the
// server. 32KB is generous for anything we accept (JWT round-trips peak ~3KB).
app.use(express.json({ limit: '32kb' }));

// ─── Rate limiting ───
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { status: 'error', message: 'Too many requests, try again later' },
  standardHeaders: true, legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { status: 'error', message: 'Too many sign-in attempts, try again later' },
  standardHeaders: true, legacyHeaders: false,
});
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { status: 'error', message: 'Too many submissions, try again later' },
});
const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { status: 'error', message: 'Too many reviews, try again later' },
});
app.use('/api/', generalLimiter);
app.use('/auth/', authLimiter);

// Initialize database on startup
initDB().catch(err => {
  console.error('Failed to connect to Supabase:', err.message);
  process.exit(1);
});

// ─── Health Check ───
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DevTools Pro Backend',
    version: '1.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════
// AUTHENTICATION ENDPOINTS
// ═══════════════════════════════════════════

// Plans accepted across the system. Keep this in sync with the frontend
// pricing display and plan-hierarchy.js.
const ALLOWED_PLANS = new Set(['Pro', 'Pro+', 'Pro Max', 'Power']);
const ALLOWED_PLAN_STATUSES = new Set(['none', 'processing', 'active', 'cancelled', 'expired']);
// Ordered tier ladder — used by the deferred-downgrade endpoint to
// reject "downgrades" that are actually upgrades or no-ops.
const PLAN_TIERS = ['Pro', 'Pro+', 'Pro Max', 'Power'];
// INR price ceiling per plan — the maximum legitimate /api/payment/create
// amount. Prorated, diff, and full-month amounts all fall at or below
// this number, so anything above is rejected as malformed. Mirrors
// backend/plan-hierarchy.js so a single source of truth never drifts.
const PLAN_INR_LIMITS = { 'Pro': 946, 'Pro+': 1892, 'Pro Max': 4731, 'Power': 9461 };

// Convert a raw Supabase users row into the camelCase DTO every
// auth response returns. Keeps the shape consistent across
// /auth/google, /auth/me, /auth/update-plan, /auth/cancel-plan, and
// the new /auth/schedule-downgrade endpoint.
function userRowToDto(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    currentPlan: u.current_plan,
    planStatus: u.plan_status,
    planStartDate: u.plan_start_date,
    planEndDate: u.plan_end_date,
    phone: u.phone,
    username: u.username,
    registrationComplete: u.registration_complete,
    utrId: u.utr_id,
    meetLink: u.meet_link,
    pendingPlan: u.pending_plan,
    pendingPlanEffective: u.pending_plan_effective,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

// ─── POST /auth/google ───
app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ status: 'error', message: 'ID token required' });
    }

    const result = await verifyGoogleToken(idToken);
    if (!result.valid) {
      return res.status(401).json({ status: 'error', message: result.message });
    }

    const client = getClient();
    let { user, isNew } = await findOrCreateUser(client, result.user);
    if (!user) {
      return res.status(500).json({ status: 'error', message: 'Failed to create user' });
    }
    // Auto-restore on sign-in. Admin "delete" is now an organisational
    // move into the recovery panel, not a hard suspension — the user
    // signing back in is the explicit signal that they want back into
    // the active list. We clear deleted_at and emit the same Slack
    // event as a manual restore so the audit trail stays complete.
    let wasArchived = false;
    if (user.deleted_at) {
      const { data: restored, error: restoreErr } = await client
        .from('users')
        .update({ deleted_at: null })
        .eq('id', user.id)
        .select()
        .single();
      if (!restoreErr && restored) {
        user = restored;
        wasArchived = true;
        console.log(`auth: auto-restored uid=${user.id} on sign-in`);
      } else if (restoreErr) {
        console.warn('auto-restore on sign-in warning:', restoreErr.message || restoreErr);
      }
    }

    const sessionToken = generateSessionToken(user);

    res.json({
      status: 'success',
      token: sessionToken,
      user: userRowToDto(user),
    });

    // Log identifier, not PII payload.
    console.log(`auth: login uid=${user.id}`);

    // Fire a Slack alert only for first-time signups — returning logins
    // would flood the channel and aren't actionable. An auto-restore is
    // a separate, audit-worthy event (an archived user returned on
    // their own) and rides the same channel as manual restores.
    if (isNew) {
      slack.notifyNewUser(userRowToDto(user));
    } else if (wasArchived) {
      slack.notifyUserRestored({ user: userRowToDto(user) });
    }
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).json({ status: 'error', message: 'Authentication failed' });
  }
});

// ─── GET /auth/me ───
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const client = getClient();
    const { data: userRow, error } = await client
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    if (error || !userRow) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    // Reassignable handle — auto-restore below may swap in a fresh row.
    let user = userRow;

    // Auto-restore on any signed-in activity. Soft-delete is no longer a
    // hard suspension; it's purely an admin-side organisational move
    // into the recovery panel. As soon as the user is active again
    // (sign-in, /auth/me poll on dashboard load, etc.) we pull them
    // back into the main list. Idempotent — only fires while
    // deleted_at is non-null.
    if (user.deleted_at) {
      const { data: restored, error: restoreErr } = await client
        .from('users')
        .update({ deleted_at: null })
        .eq('id', user.id)
        .select()
        .single();
      if (!restoreErr && restored) {
        user = restored;
        console.log(`auth: auto-restored uid=${user.id} on /auth/me`);
        slack.notifyUserRestored({ user: userRowToDto(user) });
      } else if (restoreErr) {
        console.warn('auto-restore on /auth/me warning:', restoreErr.message || restoreErr);
      }
    }

    // Lazy backfill: if this row predates the username column, stamp
    // a default handle now (same formula the dashboard's deriveHandle
    // would use) so the membership card on screen and the admin's
    // username field are always the same string. Idempotent — every
    // subsequent /auth/me skips this branch.
    if (!user.username) {
      const derived = computeUsernameFromIdEmail(user.id, user.email);
      const { error: bfErr } = await client
        .from('users')
        .update({ username: derived })
        .eq('id', user.id);
      if (!bfErr) user.username = derived;
    }

    res.json({ status: 'success', user: userRowToDto(user) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// Tiny mirror of auth.js's computeDefaultUsername — duplicated here only
// to avoid a circular require between server.js and auth.js. Both copies
// MUST stay in sync; the dashboard's deriveHandle() in dashboard.html
// is the third source of truth and is the reference implementation.
function computeUsernameFromIdEmail(userId, email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '');
  const idStr = String(userId || '').replace(/-/g, '');
  const suffix = idStr.slice(0, 4).toLowerCase() || 'pro';
  const maxLocal = 64 - suffix.length - 1;
  return local.slice(0, Math.max(2, maxLocal)) + '_' + suffix;
}

// ─── POST /auth/update-plan ───
// Record the plan a user has chosen and is paying for. The frontend invokes
// this after the /api/submit + UTR step has succeeded.
//
// Security posture: we treat the body as user-controlled and DO NOT honor a
// client-supplied meet_link. The Meet link is server-assigned at /api/submit
// time and stored on the matching submissions row; here we look it up and
// copy it onto the users row. The chosen plan must match what the user
// declared on the submission, preventing tier-jumping by replaying the call.
app.post('/auth/update-plan', requireAuth, async (req, res) => {
  try {
    const { plan, utrId } = req.body || {};

    if (!plan || !ALLOWED_PLANS.has(plan)) {
      return res.status(400).json({ status: 'error', message: 'Invalid plan' });
    }
    if (!utrId || typeof utrId !== 'string' || utrId.trim().length < 6) {
      return res.status(400).json({ status: 'error', message: 'Invalid UTR' });
    }

    const cleanedUtr = utrId.trim();
    const client = getClient();

    // Get the canonical email on the users row — we never trust the JWT
    // payload's email as the lookup key for the submission. We also
    // capture the previous plan up front so we can label the Slack alert
    // as new / renew / upgrade / downgrade once the write succeeds.
    const { data: userRow, error: userErr } = await client
      .from('users')
      .select('id, email, current_plan')
      .eq('id', req.user.userId)
      .single();

    if (userErr || !userRow) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    // Pull the most recent submissions row for this user so we can recover
    // the server-assigned meet_link. We also use it to validate plan choice.
    const { data: subs } = await client
      .from('submissions')
      .select('meet_link, utr_id, selected_plan, submission_timestamp')
      .ilike('email', userRow.email)
      .order('created_at', { ascending: false })
      .limit(5);

    const matchingSub = (subs || []).find(
      s => s.utr_id && s.utr_id.toLowerCase() === cleanedUtr.toLowerCase()
    );

    if (matchingSub && matchingSub.selected_plan) {
      // The submission row is the source of truth for the requested plan.
      const submittedPlan = String(matchingSub.selected_plan).split(' —')[0].trim();
      if (submittedPlan && submittedPlan !== plan) {
        return res.status(400).json({
          status: 'error',
          message: 'Plan does not match the submitted UTR',
        });
      }
    }

    // Server-controlled meet_link: from the matching submission if we have it,
    // else from the latest submission for this user, else null.
    const serverMeetLink = (matchingSub && matchingSub.meet_link)
      || (subs && subs[0] && subs[0].meet_link)
      || null;

    // Next renewal = first UTC day of the next calendar month. Storing UTC
    // keeps the boundary stable regardless of where the server runs.
    const now = new Date();
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

    const { data, error } = await client
      .from('users')
      .update({
        current_plan: plan,
        plan_status: 'processing',
        plan_start_date: now.toISOString(),
        plan_end_date: endDate.toISOString(),
        utr_id: cleanedUtr,
        meet_link: serverMeetLink,
      })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error) {
      console.error('update-plan db error:', error.message);
      return res.status(500).json({ status: 'error', message: 'Failed to update plan' });
    }

    res.json({
      status: 'success',
      message: 'Plan recorded',
      user: userRowToDto(data),
    });

    // Slack: route by transition direction. The slack module figures
    // out new/renew/upgrade/downgrade from the previous-vs-new plan
    // comparison and dispatches to the right channel automatically.
    slack.notifyPlanActivated({
      user: userRowToDto(data),
      previousPlan: userRow.current_plan || null,
      newPlan: plan,
      payment: { utrId: cleanedUtr, plan, amount: matchingSub ? null : null },
    });
  } catch (error) {
    console.error('update-plan exception:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /auth/schedule-downgrade ───
// Records a deferred plan change. The user keeps their current (higher)
// plan benefits until pending_plan_effective passes; on or after that
// date, an admin (or a future cron) flips current_plan to pending_plan
// via POST /admin/users/:id/apply-pending.
//
// Security model: same as /auth/update-plan — the body is treated as
// hostile. We validate the target plan against ALLOWED_PLANS and refuse
// anything that isn't strictly lower than the user's current tier. That
// makes it impossible to "schedule an upgrade for free" by lying about
// the direction.
app.post('/auth/schedule-downgrade', requireAuth, async (req, res) => {
  try {
    const { plan, utrId } = req.body || {};

    if (!plan || !ALLOWED_PLANS.has(plan)) {
      return res.status(400).json({ status: 'error', message: 'Invalid plan' });
    }
    if (!utrId || typeof utrId !== 'string' || utrId.trim().length < 6) {
      return res.status(400).json({ status: 'error', message: 'Invalid UTR' });
    }

    const client = getClient();
    const { data: userRow, error: userErr } = await client
      .from('users')
      .select('id, current_plan, plan_status')
      .eq('id', req.user.userId)
      .single();
    if (userErr || !userRow) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    if (!userRow.current_plan) {
      return res.status(400).json({
        status: 'error',
        message: 'No active plan to downgrade from. Use Change Plan instead.',
      });
    }

    const currentIdx = PLAN_TIERS.indexOf(userRow.current_plan);
    const newIdx = PLAN_TIERS.indexOf(plan);
    if (currentIdx < 0 || newIdx < 0) {
      return res.status(400).json({ status: 'error', message: 'Unknown plan' });
    }
    if (newIdx >= currentIdx) {
      return res.status(400).json({
        status: 'error',
        message: 'Scheduled downgrade must be to a strictly lower tier than your current plan.',
      });
    }

    // The change takes effect on the 1st of next month (UTC). That's
    // when the next billing cycle starts and the user's current plan
    // would have renewed anyway — so the downgrade simply replaces the
    // renewal without any mid-cycle service change.
    const now = new Date();
    const effective = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

    const { data, error } = await client
      .from('users')
      .update({
        pending_plan: plan,
        pending_plan_effective: effective.toISOString(),
        // current_plan / plan_status / plan_end_date intentionally NOT
        // touched — the user keeps their higher tier benefits until
        // the effective date passes.
      })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error) {
      console.error('schedule-downgrade db error:', error.message);
      return res.status(500).json({ status: 'error', message: 'Failed to schedule downgrade' });
    }

    res.json({ status: 'success', message: 'Downgrade scheduled', user: userRowToDto(data) });
    console.log(`auth: scheduled downgrade uid=${data.id} -> ${plan} eff=${effective.toISOString()}`);

    // Slack: pending plan + effective date go to #change_plan.
    slack.notifyDowngradeScheduled({
      user: userRowToDto(data),
      pendingPlan: plan,
      effectiveAt: effective.toISOString(),
    });
  } catch (error) {
    console.error('schedule-downgrade exception:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /auth/register ───
app.post('/auth/register', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, source, phone } = req.body || {};
    if (!firstName || !lastName || !source) {
      return res.status(400).json({ status: 'error', message: 'Name and source are required' });
    }

    // WhatsApp number is now MANDATORY. The entire fulfilment flow
    // (payment verification, Meet link delivery, renewal reminders)
    // happens over WhatsApp, so a missing/invalid number means we
    // literally cannot deliver the subscription. We normalise to
    // digits-only and validate the length so the click-to-chat URL
    // on the admin side just works (no re-parsing of stray hyphens /
    // spaces / country prefixes there).
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp number is required — we deliver your subscription and updates there.' });
    }
    const phoneNormalised = String(phone).replace(/\D+/g, '');
    if (phoneNormalised.length < 8 || phoneNormalised.length > 15) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp number must be 8-15 digits — include the country code.' });
    }

    const client = getClient();
    const fullName = `${String(firstName).trim()} ${String(lastName).trim()}`;

    const updatePayload = {
      name: fullName,
      source: String(source).trim().slice(0, 60),
      phone: phoneNormalised,
      registration_complete: true,
    };

    const { error } = await client
      .from('users')
      .update(updatePayload)
      .eq('id', req.user.userId);

    if (error) {
      console.error('Register error:', error.message);
      return res.status(500).json({ status: 'error', message: error.message });
    }

    const { data } = await client
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    res.json({
      status: 'success',
      user: data ? userRowToDto(data) : {
        id: req.user.userId,
        email: req.user.email,
        name: fullName,
        phone: phoneNormalised,
        registrationComplete: true,
      },
    });
    console.log(`auth: registration uid=${req.user.userId} phone=${phoneNormalised ? 'set' : 'none'}`);

    // Slack: registration completed (phone + source supplied). Always
    // includes the DTO so the alert has the latest avatar/source row.
    if (data) slack.notifyRegistrationComplete(userRowToDto(data));
  } catch (error) {
    console.error('Register exception:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /auth/cancel-plan ───
app.post('/auth/cancel-plan', requireAuth, async (req, res) => {
  try {
    const client = getClient();
    const { data, error } = await client
      .from('users')
      .update({ plan_status: 'cancelled' })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ status: 'error', message: 'Failed to cancel' });
    }

    res.json({
      status: 'success',
      message: 'Plan cancelled — active until end of billing cycle',
      user: userRowToDto(data),
    });

    // Slack: cancellation event + the precise active-until timestamp.
    slack.notifyPlanCancelled({ user: userRowToDto(data), byAdmin: false });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /auth/google-client-id ───
app.get('/auth/google-client-id', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID || '' });
});

// ═══════════════════════════════════════════
// ADMIN ENDPOINTS — username + password -> JWT
// Requires env: ADMIN_USERNAME + ADMIN_PASSWORD (or ADMIN_KEY as fallback)
// ═══════════════════════════════════════════

// Tighter rate limit on admin login to slow down brute-force.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── POST /admin/login ───
app.post('/admin/login', adminLoginLimiter, async (req, res) => {
  if (!adminCredsConfigured()) {
    return res.status(503).json({ status: 'error', message: 'Admin access not configured on this server.' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Username and password are required' });
  }
  const ok = verifyAdminCreds(username, password);
  // Add a small delay on failure so timing differences don't leak validity.
  await new Promise(r => setTimeout(r, ok ? 0 : 350));
  if (!ok) {
    return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
  }
  const token = generateAdminToken();
  res.json({ status: 'success', token, expiresIn: 8 * 60 * 60 });
  console.log(`admin: login user=${username}`);
});

// ─── GET /admin/me ───
app.get('/admin/me', requireAdminAuth, (req, res) => {
  res.json({ status: 'success', role: req.admin.role });
});

// ─── GET /admin/stats ───
app.get('/admin/stats', requireAdminAuth, async (req, res) => {
  try {
    const client = getClient();
    // Fetch users + payments in parallel — both feed the stats tiles on the
    // admin home and we want a single round-trip cost. Soft-deleted users
    // are excluded from every count (they're not "real" any more).
    const [usersRes, paymentsRes] = await Promise.all([
      client.from('users').select('plan_status,current_plan,registration_complete,created_at,deleted_at').is('deleted_at', null),
      client.from('payments').select('amount,status,verified_at'),
    ]);
    if (usersRes.error) {
      console.error('admin/stats users error:', usersRes.error);
      return res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
    }
    if (paymentsRes.error) {
      // Non-fatal — we still return user counts even if payments lookup hiccups.
      console.warn('admin/stats payments warning:', paymentsRes.error.message || paymentsRes.error);
    }
    const list = usersRes.data || [];
    const payments = paymentsRes.data || [];
    const by = (k, v) => list.filter(u => u[k] === v).length;

    // Revenue = sum of payments.amount for rows the admin has verified.
    // Stays in INR because that's what we charge — the admin UI prefixes
    // the symbol on render.
    const revenue = payments
      .filter(p => p && p.status === 'verified')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    // "Visitors" = every user who has signed in at least once. That's the
    // most defensible interpretation of website traffic we can support
    // without bolting on analytics — anonymous landing-page hits live in
    // GitHub Pages / CloudFront logs, not here.
    res.json({
      status: 'success',
      stats: {
        totalUsers: list.length,
        totalVisitors: list.length,
        totalRevenue: revenue,
        verifiedPayments: payments.filter(p => p && p.status === 'verified').length,
        active: by('plan_status', 'active'),
        processing: by('plan_status', 'processing'),
        cancelled: by('plan_status', 'cancelled'),
        none: list.filter(u => !u.plan_status || u.plan_status === 'none').length,
        registered: by('registration_complete', true),
        byPlan: {
          'Pro': by('current_plan', 'Pro'),
          'Pro+': by('current_plan', 'Pro+'),
          'Pro Max': by('current_plan', 'Pro Max'),
          'Power': by('current_plan', 'Power'),
        },
      },
    });
  } catch (e) {
    console.error('admin/stats exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// Map Supabase row -> camelCase user dto used by the admin UI
function rowToAdminUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    phone: u.phone,
    source: u.source,
    googleId: u.google_id,
    username: u.username,
    currentPlan: u.current_plan,
    planStatus: u.plan_status,
    planStartDate: u.plan_start_date,
    planEndDate: u.plan_end_date,
    utrId: u.utr_id,
    meetLink: u.meet_link,
    pendingPlan: u.pending_plan,
    pendingPlanEffective: u.pending_plan_effective,
    registrationComplete: u.registration_complete,
    createdAt: u.created_at,
    // Server-maintained "last business event" timestamp — bumped only
    // when plan / status / UTR / meet / name / phone / username /
    // pending fields change. last_login + picture refreshes intentionally
    // don't move it (see the users_bump_updated_at trigger in
    // setup-users.sql).
    updatedAt: u.updated_at,
    lastLogin: u.last_login,
    // WhatsApp reminder bookkeeping — surfaced by the admin's WA popover
    // so the admin knows when they last nudged this user and via which
    // template (so they don't hammer the same person every day).
    lastRemindedAt: u.last_reminded_at,
    lastRemindedTemplate: u.last_reminded_template,
    // Soft-delete marker. NULL for active users; ISO timestamp when an
    // admin has deleted them via DELETE /admin/users/:id. Rows still
    // exist in the table — restore by POST /admin/users/:id/restore.
    deletedAt: u.deleted_at,
  };
}

// ─── GET /admin/users ───
app.get('/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim().slice(0, 100);
    const status = (req.query.status || '').toString().trim();
    const plan = (req.query.plan || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    // ?deleted= controls visibility of soft-deleted rows:
    //   (omitted | 'no')   → only live users  [default]
    //   'only'             → only soft-deleted users (recovery view)
    //   'all'              → both, with deletedAt surfaced per row
    const deletedFilter = (req.query.deleted || '').toString().trim().toLowerCase();

    const client = getClient();
    let query = client.from('users').select('*').order('created_at', { ascending: false }).limit(limit);
    if (deletedFilter === 'only') {
      query = query.not('deleted_at', 'is', null);
    } else if (deletedFilter !== 'all') {
      query = query.is('deleted_at', null);
    }
    if (status && ALLOWED_PLAN_STATUSES.has(status)) query = query.eq('plan_status', status);
    if (plan && ALLOWED_PLANS.has(plan))             query = query.eq('current_plan', plan);
    if (search) {
      // Escape PostgREST OR-clause special chars + ilike wildcards. Without
      // this, a comma or parenthesis would break the parser and a `%` would
      // turn the query into a free-text fuzzer.
      const safe = search.replace(/[%_,()*\\]/g, '\\$&');
      query = query.or(`email.ilike.%${safe}%,name.ilike.%${safe}%,utr_id.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('admin/users error:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to fetch users' });
    }
    res.json({ status: 'success', users: (data || []).map(rowToAdminUser), count: (data || []).length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── PATCH /admin/users/:id ───
app.patch('/admin/users/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const updates = {};

    if ('currentPlan' in body) {
      const v = body.currentPlan === '' ? null : body.currentPlan;
      if (v !== null && !ALLOWED_PLANS.has(v)) {
        return res.status(400).json({ status: 'error', message: 'Invalid plan' });
      }
      updates.current_plan = v;
    }
    if ('planStatus' in body) {
      const v = body.planStatus || 'none';
      if (!ALLOWED_PLAN_STATUSES.has(v)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status' });
      }
      updates.plan_status = v;
    }
    if ('planStartDate' in body) updates.plan_start_date = body.planStartDate || null;
    if ('planEndDate'   in body) updates.plan_end_date   = body.planEndDate   || null;
    if ('utrId'         in body) updates.utr_id          = body.utrId         || null;
    if ('meetLink'      in body) {
      // Same strict validation as the assignment pool — even an admin's
      // manual edit can't introduce a Meet URL that doesn't match the
      // canonical `https://meet.google.com/xxx-xxxx-xxx` format. Empty
      // string clears the column (legitimate when an admin un-assigns).
      const raw = body.meetLink ? String(body.meetLink).trim() : '';
      if (raw && !isValidMeetUrl(raw)) {
        return res.status(400).json({
          status: 'error',
          message: 'Meet link must look like https://meet.google.com/xxx-xxxx-xxx (lowercase 3-4-3 dashed format).',
        });
      }
      updates.meet_link = raw || null;
    }
    if ('phone'         in body) {
      // Normalise to digits-only so the WhatsApp click-to-chat URL on
      // every row just works without re-parsing. Empty string clears.
      const cleaned = body.phone ? String(body.phone).replace(/\D+/g, '') : '';
      if (cleaned && (cleaned.length < 8 || cleaned.length > 15)) {
        return res.status(400).json({ status: 'error', message: 'Phone must be 8-15 digits' });
      }
      updates.phone = cleaned || null;
    }
    if ('source'        in body) updates.source          = body.source        || null;
    if ('username'      in body) {
      // Admin-editable handle. We strip to a conservative alphanumeric +
      // dot / underscore / hyphen set so it stays URL-safe and matches
      // what users would expect from a "username" slot. Empty clears.
      // Ceiling matches the column's auto-derived limit (long emails
      // can produce 30–40 char defaults; 64 leaves headroom).
      const raw = body.username == null ? '' : String(body.username).trim();
      if (raw) {
        const safe = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
        if (safe.length < 2) {
          return res.status(400).json({ status: 'error', message: 'Username must be 2-64 chars (letters, digits, . _ - only)' });
        }
        updates.username = safe;
      } else {
        updates.username = null;
      }
    }
    if ('name'          in body && typeof body.name === 'string' && body.name.trim()) {
      updates.name = body.name.trim().slice(0, 120);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ status: 'error', message: 'No valid fields to update' });
    }

    const client = getClient();
    const { data, error } = await client
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.error('admin patch error:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to update user' });
    }
    res.json({ status: 'success', user: rowToAdminUser(data) });
    console.log(`admin: patched uid=${data.id} fields=${Object.keys(updates).join(',')}`);

    // Slack: if the admin flipped status to cancelled, route as a
    // cancellation event (the dedicated channel cares about who and
    // when). Everything else lands in the audit channel with the
    // changed fields surfaced.
    if (updates.plan_status === 'cancelled') {
      slack.notifyPlanCancelled({ user: rowToAdminUser(data), byAdmin: true });
    } else {
      slack.notifyAdminPatched({
        user: rowToAdminUser(data),
        changedFields: Object.keys(updates),
      });
    }
  } catch (e) {
    console.error('admin patch exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── DELETE /admin/users/:id ───
// Soft-delete (archive): sets users.deleted_at to NOW(). Row stays in
// the database (payment audit trail, history, restorability) and is
// moved out of default admin views into the "Deleted only" panel.
// This is an organisational move only — sign-in is NOT blocked.
// /auth/google and /auth/me auto-clear deleted_at the next time the
// user is active, restoring them into the main list. Admin can also
// restore manually via POST /admin/users/:id/restore.
app.delete('/admin/users/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const client = getClient();

    // Make the operation idempotent — re-deleting an already-deleted
    // user is a no-op rather than a 404 (admin toast can race a
    // refresh in either direction).
    const { data, error } = await client
      .from('users')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.error('admin delete error:', error);
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({ status: 'success', user: rowToAdminUser(data) });
    console.log(`admin: soft-deleted uid=${data.id}`);
    slack.notifyUserSuspended({ user: rowToAdminUser(data) });
  } catch (e) {
    console.error('admin delete exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /admin/users/:id/restore ───
// Reverses a soft-delete by clearing deleted_at. Idempotent for users
// who are already active. Used by the toast "Undo" affordance and the
// recovery view's per-row restore button.
app.post('/admin/users/:id/restore', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const client = getClient();
    const { data, error } = await client
      .from('users')
      .update({ deleted_at: null })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.error('admin restore error:', error);
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({ status: 'success', user: rowToAdminUser(data) });
    console.log(`admin: restored uid=${data.id}`);
    slack.notifyUserRestored({ user: rowToAdminUser(data) });
  } catch (e) {
    console.error('admin restore exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /admin/users/:id/apply-pending ───
// Flips current_plan -> pending_plan and recomputes the billing dates.
// Called by an admin when the user's scheduled downgrade is due (or
// when they want to apply it early). The pending_* columns are
// cleared in the same write so the dashboard stops showing the banner.
app.post('/admin/users/:id/apply-pending', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const client = getClient();

    const { data: userRow, error: userErr } = await client
      .from('users')
      .select('id, pending_plan, pending_plan_effective')
      .eq('id', id)
      .single();
    if (userErr || !userRow) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    if (!userRow.pending_plan) {
      return res.status(400).json({ status: 'error', message: 'No pending plan to apply' });
    }
    if (!ALLOWED_PLANS.has(userRow.pending_plan)) {
      return res.status(400).json({ status: 'error', message: 'Pending plan is invalid' });
    }

    // The new billing cycle anchors at pending_plan_effective if it's
    // set, else "now". plan_end_date is the 1st of the next month after
    // that — same convention as /auth/update-plan.
    const effective = userRow.pending_plan_effective
      ? new Date(userRow.pending_plan_effective)
      : new Date();
    const planEndDate = new Date(Date.UTC(
      effective.getUTCFullYear(),
      effective.getUTCMonth() + 1,
      1, 0, 0, 0
    ));

    const { data, error } = await client
      .from('users')
      .update({
        current_plan: userRow.pending_plan,
        plan_status: 'active',
        plan_start_date: effective.toISOString(),
        plan_end_date: planEndDate.toISOString(),
        pending_plan: null,
        pending_plan_effective: null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.error('apply-pending error:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to apply pending plan' });
    }
    res.json({ status: 'success', user: rowToAdminUser(data) });
    console.log(`admin: applied pending uid=${data.id} plan=${data.current_plan}`);
    slack.notifyPendingApplied({ user: rowToAdminUser(data) });
  } catch (e) {
    console.error('apply-pending exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /admin/users/:id/mark-reminded ───
// Bookkeeping endpoint for the per-row WhatsApp template picker. The
// admin calls this just before opening the wa.me URL so we know who
// was nudged, when, and with which template — surfaced back to the
// admin UI as "Last nudged 2 days ago · Renewal reminder" so they
// don't accidentally hammer the same person every day.
//
// Note: last_reminded_at is deliberately NOT included in the
// users_bump_updated_at trigger's change set, so frequent reminder
// activity doesn't drown out actual plan changes in the "Updated"
// column. This endpoint is the only writer of these two fields.
app.post('/admin/users/:id/mark-reminded', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { template } = req.body || {};
    if (!template) {
      return res.status(400).json({ status: 'error', message: 'Template is required' });
    }
    const cleanedTemplate = String(template).trim().slice(0, 60);
    if (!cleanedTemplate) {
      return res.status(400).json({ status: 'error', message: 'Template cannot be empty' });
    }

    const client = getClient();
    const { data, error } = await client
      .from('users')
      .update({
        last_reminded_at: new Date().toISOString(),
        last_reminded_template: cleanedTemplate,
      })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.error('mark-reminded error:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to record reminder' });
    }
    res.json({ status: 'success', user: rowToAdminUser(data) });
    console.log(`admin: reminder logged uid=${data.id} tpl=${cleanedTemplate}`);
  } catch (e) {
    console.error('mark-reminded exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ═══════════════════════════════════════════
// SUBMISSION + REVIEW + PAYMENT ENDPOINTS
// ═══════════════════════════════════════════

// ─── POST /api/submit ───
app.post('/api/submit', submitLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, selectedPlan, utrId, submissionTimestamp } = req.body || {};

    const requiredFields = { firstName, lastName, email, selectedPlan, utrId };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value || !value.toString().trim()) {
        return res.status(400).json({ status: 'error', message: `Missing required field: ${field}` });
      }
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ status: 'error', message: 'Invalid email format' });
    }

    // Plan must be one we recognise, ignoring any trailing " — extra" suffix
    // that older variants of the form may have appended.
    const planClean = String(selectedPlan).split(' —')[0].trim();
    if (!ALLOWED_PLANS.has(planClean)) {
      return res.status(400).json({ status: 'error', message: 'Invalid plan' });
    }

    const userData = { firstName, lastName, email, selectedPlan, utrId };
    const setupInfo = generateSetupMessage(userData);

    const submission = {
      id: uuidv4(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim().toLowerCase(),
      selectedPlan: planClean,
      utrId: utrId.trim(),
      submissionTimestamp: submissionTimestamp || new Date().toISOString(),
      meetLink: setupInfo.meetLink,
      notes: setupInfo.autoReplyNote,
    };

    const result = await addSubmission(submission);

    if (!result.success) {
      if (result.error === 'duplicate') {
        return res.status(409).json({
          status: 'duplicate',
          message: 'This UTR/Transaction ID has already been submitted',
        });
      }
      return res.status(500).json({ status: 'error', message: result.message });
    }

    const whatsappNumber = process.env.WHATSAPP_NUMBER || '919019879108';
    const quickReply = generateQuickReply(userData, setupInfo.meetLink);
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${whatsappNumber}&text=${encodeURIComponent(setupInfo.whatsappMessage)}`;

    res.status(201).json({
      status: 'success',
      message: 'Submission saved successfully',
      data: {
        id: submission.id,
        meetLink: setupInfo.meetLink,
        setupNote: setupInfo.autoReplyNote,
        whatsappUrl,
        whatsappMessage: setupInfo.whatsappMessage,
        quickReply,
      },
    });

    console.log(`submit: id=${submission.id} plan=${planClean}`);
  } catch (error) {
    console.error('submit error:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// ─── GET /api/submissions ───
app.get('/api/submissions', requireAdminAuth, async (req, res) => {
  try {
    const submissions = await getAllSubmissions();
    res.json({ status: 'success', count: submissions.length, data: submissions });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/submissions/me ───
// Returns every submission row for the authenticated user's email, in
// reverse-chronological order. Used by the dashboard's Payment History
// page so users see every transaction (not just the most recent plan).
//
// Each submission row records: plan, UTR, meet link, submission time.
// We don't store the *amount* on submissions (legacy schema reason) so
// we best-effort enrich each row with the matching payments.amount via
// a single second query keyed on utr_id. Rows without a payment match
// (rare: payment row deleted or never created) come back with amount=null
// and the client falls back to the plan's full monthly price.
app.get('/api/submissions/me', requireAuth, async (req, res) => {
  try {
    const client = getClient();

    // Resolve the canonical email from the users table — don't trust
    // the JWT payload's email field as the join key.
    const { data: userRow, error: userErr } = await client
      .from('users')
      .select('email')
      .eq('id', req.user.userId)
      .single();
    if (userErr || !userRow) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    const email = userRow.email;

    const { data: subs, error: subErr } = await client
      .from('submissions')
      .select('id, email, selected_plan, utr_id, submission_timestamp, subscription_start, subscription_end, status, meet_link, created_at')
      .ilike('email', email)
      .order('created_at', { ascending: false })
      .limit(50);
    if (subErr) {
      console.error('submissions/me read error:', subErr.message || subErr);
      return res.status(500).json({ status: 'error', message: 'Failed to fetch history' });
    }

    // Best-effort enrichment with the actual paid amount + verification
    // status. Failure is non-fatal — we still return the submission rows.
    const utrIds = (subs || []).map(s => s.utr_id).filter(Boolean);
    let paymentsByUtr = {};
    if (utrIds.length > 0) {
      const { data: pays } = await client
        .from('payments')
        .select('utr_id, amount, status, verified_at, created_at')
        .in('utr_id', utrIds);
      paymentsByUtr = Object.fromEntries(
        (pays || []).map(p => [String(p.utr_id || '').toLowerCase(), p])
      );
    }

    const history = (subs || []).map(s => {
      const matched = s.utr_id ? paymentsByUtr[String(s.utr_id).toLowerCase()] : null;
      return {
        id: s.id,
        date: s.submission_timestamp || s.created_at,
        plan: s.selected_plan,
        utrId: s.utr_id,
        submissionStatus: s.status,
        meetLink: s.meet_link,
        // The actual charged amount lives on payments.amount — pulled
        // through the UTR join above. null means "no payment row found";
        // the client substitutes the full plan price as a fallback.
        amount: matched ? Number(matched.amount) : null,
        paymentStatus: matched ? matched.status : null,
        verifiedAt: matched ? matched.verified_at : null,
      };
    });

    res.json({ status: 'success', count: history.length, history });
  } catch (e) {
    console.error('submissions/me exception:', e.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/check-utr/:utrId ───
app.get('/api/check-utr/:utrId', async (req, res) => {
  try {
    const existing = await getSubmissionByUTR(req.params.utrId);
    res.json({ exists: !!existing, status: existing ? existing.status : null });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/stats ───
app.get('/api/stats', requireAdminAuth, async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ status: 'success', data: stats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ═══════════════════════════════════════════
// PAYMENT VERIFICATION ENDPOINTS
// ═══════════════════════════════════════════

// ─── POST /api/payment/create ───
// Authenticated. Stamps the payment row with the user's id and blocks
// duplicate sessions: if the caller already has an awaiting_verification
// row we reject (admin still needs to confirm the previous one) and if
// they have a not-yet-expired pending row we return THAT instead of
// inserting a second, so an accidental double-click can never produce
// two payment ids for the same flow.
app.post('/api/payment/create', requireAuth, async (req, res) => {
  try {
    const { amount, plan } = req.body || {};
    if (!amount || !plan) {
      return res.status(400).json({ status: 'error', message: 'Amount and plan are required' });
    }
    // Plan must be a known tier so users can't insert "Custom Free" rows.
    const planClean = String(plan).split(' —')[0].trim();
    if (!ALLOWED_PLANS.has(planClean)) {
      return res.status(400).json({ status: 'error', message: 'Invalid plan' });
    }
    const numericAmount = Number(amount);
    const planCeiling = PLAN_INR_LIMITS[planClean];
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > planCeiling) {
      // Floor at ₹1 so dust-amount fraud is blocked; ceiling is the
      // plan's listed monthly price (prorated and upgrade-diff amounts
      // are always below the ceiling, so this still passes every
      // legitimate flow). Anyone trying to "pay ₹1 for Power" gets a
      // 400 here even if they bypass the dashboard UI entirely.
      return res.status(400).json({
        status: 'error',
        message: `Invalid amount for ${planClean}. Must be between ₹1 and ₹${planCeiling.toLocaleString('en-IN')}.`,
      });
    }

    const userId = req.user.userId;

    // Duplicate-session guard — checks the user's payments rows
    // directly so a second click on Continue can't race past the UI
    // disabled state introduced for the Processing pill.
    const open = await findOpenPaymentForUser(userId);
    if (open && open.row.status === 'awaiting_verification') {
      return res.status(409).json({
        status: 'error',
        code: 'AWAITING_VERIFICATION',
        message: "You already have a payment awaiting our team's verification. Please wait for it to be confirmed before submitting another.",
        existingPaymentId: open.row.id,
      });
    }
    if (open && open.row.status === 'pending' && !open.isStale) {
      // Resume the same session instead of creating a duplicate row —
      // gives the user idempotent behaviour on double-clicks / refreshes.
      return res.status(200).json({
        status: 'success',
        paymentId: open.row.id,
        upiId: 'devtoolpro@ybl',
        amount: Number(open.row.amount),
        plan: open.row.plan,
        resumed: true,
      });
    }

    const result = await createPaymentRecord({
      amount: numericAmount,
      plan: planClean,
      upiId: 'devtoolpro@ybl',
      userId,
    });
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.message });
    }
    res.status(201).json({
      status: 'success',
      paymentId: result.paymentId,
      upiId: 'devtoolpro@ybl',
      amount: numericAmount,
      plan: planClean,
    });
    console.log(`payment: created id=${result.paymentId} uid=${userId} plan=${planClean} amt=${numericAmount}`);
  } catch (error) {
    console.error('payment/create exception:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/payment/submit-utr ───
// Auto-verify threshold raised from 70 → 95. A clean 12-digit UTR still
// scores 100 and auto-verifies; anything with repeating digits or obvious
// test prefixes now waits for human review.
const AUTO_VERIFY_THRESHOLD = 95;

// ─── POST /api/payment/submit-utr ───
// Authenticated. Verifies the caller owns the payment row before
// letting them attach a UTR — prevents one user from binding their
// UTR to a different user's pending payment (which would let an
// attacker piggy-back on someone else's verification).
app.post('/api/payment/submit-utr', requireAuth, async (req, res) => {
  try {
    const { paymentId, utrId } = req.body || {};
    if (!paymentId || !utrId) {
      return res.status(400).json({ status: 'error', message: 'Payment ID and UTR are required' });
    }

    // Ownership: legacy rows (created before user_id was added) have
    // user_id = NULL — we allow those through for backwards compat,
    // since admins can clean up the binding manually. Newly created
    // rows always carry user_id and must match the caller.
    const owner = await getPaymentOwner(paymentId);
    if (!owner) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    if (owner.userId && owner.userId !== req.user.userId) {
      return res.status(403).json({ status: 'error', message: 'Payment is not yours' });
    }

    const result = await submitUTR(paymentId, utrId);
    if (!result.success) {
      // Slack: surface duplicate-UTR rejections as a possible fraud signal.
      if (/already been used/i.test(result.message || '')) {
        slack.notifyDuplicateUtr({
          utrId: utrId.trim(),
          attemptedBy: `uid: ${req.user.userId}`,
        });
      }
      return res.status(400).json({ status: 'error', message: result.message });
    }

    const confidence = getUTRConfidence(utrId.trim());

    let autoVerified = false;
    if (confidence >= AUTO_VERIFY_THRESHOLD) {
      try {
        await verifyPayment(paymentId);
        autoVerified = true;
        console.log(`payment: auto-verified id=${paymentId} confidence=${confidence}`);
      } catch (e) {
        console.error('auto-verify failed:', e.message);
      }
    }

    res.json({
      status: 'success',
      message: 'UTR submitted — verifying payment',
      paymentStatus: 'awaiting_verification',
      confidence,
    });

    console.log(`payment: utr submitted id=${paymentId} uid=${req.user.userId} confidence=${confidence}`);

    // Slack: pending → #payments_pending; auto-verified → #payments_verified.
    // Resolve the user row so the alert can carry name / phone / avatar.
    try {
      const client = getClient();
      const { data: userRow } = await client
        .from('users')
        .select('id, email, name, picture, phone')
        .eq('id', req.user.userId)
        .single();
      const paymentPayload = {
        id: paymentId,
        utrId: utrId.trim(),
        plan: result.record && result.record.plan,
        amount: result.record && result.record.amount,
      };
      slack.notifyUtrSubmitted({
        user: userRow || { id: req.user.userId, email: req.user.email },
        payment: paymentPayload,
        confidence,
        autoVerified,
      });
    } catch (e) {
      console.warn('slack utr-submit enrichment failed:', e.message);
    }
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/payment/status/:paymentId ───
app.get('/api/payment/status/:paymentId', async (req, res) => {
  try {
    const result = await getPaymentStatus(req.params.paymentId);
    if (!result.found) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    res.json({ status: 'success', data: result });

    // Slack: one-shot expiry alert exactly when the polling endpoint
    // flips the row to expired. No cron required — the user's polling
    // is what triggers it. If the user never polls (closes the tab),
    // the row stays "pending" in the DB, but admin-side queries still
    // see it; that's an acceptable tradeoff vs adding a background job.
    if (result.justExpired) {
      try {
        let userRow = null;
        if (result.userId) {
          const client = getClient();
          const { data } = await client
            .from('users')
            .select('id, email, name, picture, phone')
            .eq('id', result.userId)
            .single();
          userRow = data || null;
        }
        slack.notifyPaymentExpired({
          payment: { id: result.paymentId, plan: result.plan, amount: result.amount },
          user: userRow,
        });
      } catch (e) {
        console.warn('slack payment-expired enrichment failed:', e.message);
      }
    }
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/payment/verify/:paymentId ───
// Admin-only. Authentication is enforced via the requireAdminAuth middleware
// (JWT issued by /admin/login). We no longer accept a body/header admin key.
app.post('/api/payment/verify/:paymentId', requireAdminAuth, async (req, res) => {
  try {
    const result = await verifyPayment(req.params.paymentId);
    if (!result.success) {
      return res.status(400).json({ status: 'error', message: result.message });
    }
    res.json({ status: 'success', message: 'Payment verified', data: result.record });

    // Slack: post to #payments_verified. Enrich with the user row so the
    // alert has a name + avatar; failure to enrich never blocks the response.
    try {
      const userId = result.record && result.record.user_id;
      let userRow = null;
      if (userId) {
        const client = getClient();
        const { data } = await client
          .from('users')
          .select('id, email, name, picture, phone')
          .eq('id', userId)
          .single();
        userRow = data || null;
      }
      slack.notifyPaymentVerified({
        user: userRow || { id: userId, email: '—' },
        payment: {
          id: result.record.id,
          utrId: result.record.utr_id,
          plan: result.record.plan,
          amount: result.record.amount,
        },
        autoVerified: false,
        verifiedBy: 'admin',
      });
    } catch (e) {
      console.warn('slack verify enrichment failed:', e.message);
    }
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/payment/pending ───
app.get('/api/payment/pending', requireAdminAuth, async (req, res) => {
  try {
    const result = await getPendingPayments();
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.message });
    }
    res.json({ status: 'success', count: result.payments.length, data: result.payments });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ═══════════════════════════════════════════
// REVIEWS ENDPOINTS
// ═══════════════════════════════════════════

// ─── POST /api/reviews ───
app.post('/api/reviews', reviewLimiter, async (req, res) => {
  try {
    const { name, city, role, reviewText, rating } = req.body || {};
    if (!name || !city || !reviewText) {
      return res.status(400).json({ status: 'error', message: 'Name, city, and review text are required' });
    }
    const r = parseInt(rating, 10);
    if (!Number.isFinite(r) || r < 1 || r > 5) {
      return res.status(400).json({ status: 'error', message: 'Rating must be 1-5' });
    }
    if (String(reviewText).length > 200) {
      return res.status(400).json({ status: 'error', message: 'Review must be under 200 characters' });
    }

    const client = getClient();
    const { data, error } = await client
      .from('reviews')
      .insert({
        name: String(name).trim().slice(0, 60),
        city: String(city).trim().slice(0, 60),
        role: String(role || 'Developer').trim().slice(0, 40),
        review_text: String(reviewText).trim(),
        rating: r,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ status: 'error', message: 'Failed to save review' });
    }

    res.status(201).json({ status: 'success', review: data });
    console.log(`reviews: new id=${data.id} rating=${r}`);
    slack.notifyNewReview({ review: data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/reviews ───
app.get('/api/reviews', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const client = getClient();

    const { data, error } = await client
      .from('reviews')
      .select('*')
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }

    res.json({ status: 'success', count: (data || []).length, reviews: data || [] });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── Start Server ───
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   DevTools Pro Backend                       ║
║   Running on port ${PORT}                        ║
║   Env: ${NODE_ENV.padEnd(38, ' ')}║
║   Database: Supabase PostgreSQL              ║
╚══════════════════════════════════════════════╝
  `);
  if (!IS_PROD && allowedOrigins.length === 0) {
    console.warn('⚠️  CORS: FRONTEND_URL not set — accepting any origin (dev mode).');
  }
});

module.exports = app;
