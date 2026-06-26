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
  createPaymentRecord, submitUTR, getPaymentStatus, verifyPayment,
  getPendingPayments, getUTRConfidence,
} = require('./payment-verify');
const {
  verifyGoogleToken, findOrCreateUser, generateSessionToken, requireAuth,
  GOOGLE_CLIENT_ID, adminCredsConfigured, verifyAdminCreds,
  generateAdminToken, requireAdminAuth,
} = require('./auth');

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
  methods: ['GET', 'POST', 'PATCH'],
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
    const user = await findOrCreateUser(client, result.user);
    if (!user) {
      return res.status(500).json({ status: 'error', message: 'Failed to create user' });
    }

    const sessionToken = generateSessionToken(user);

    res.json({
      status: 'success',
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        currentPlan: user.current_plan,
        planStatus: user.plan_status,
        planEndDate: user.plan_end_date,
      },
    });

    // Log identifier, not PII payload.
    console.log(`auth: login uid=${user.id}`);
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).json({ status: 'error', message: 'Authentication failed' });
  }
});

// ─── GET /auth/me ───
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const client = getClient();
    const { data: user, error } = await client
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    res.json({
      status: 'success',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        currentPlan: user.current_plan,
        planStatus: user.plan_status,
        planStartDate: user.plan_start_date,
        planEndDate: user.plan_end_date,
        phone: user.phone,
        registrationComplete: user.registration_complete,
        utrId: user.utr_id,
        meetLink: user.meet_link,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

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
    // payload's email as the lookup key for the submission.
    const { data: userRow, error: userErr } = await client
      .from('users')
      .select('id, email')
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
      user: {
        id: data.id,
        email: data.email,
        name: data.name,
        picture: data.picture,
        currentPlan: data.current_plan,
        planStatus: data.plan_status,
        planStartDate: data.plan_start_date,
        planEndDate: data.plan_end_date,
        phone: data.phone,
        registrationComplete: data.registration_complete,
        utrId: data.utr_id,
        meetLink: data.meet_link,
      },
    });
  } catch (error) {
    console.error('update-plan exception:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /auth/register ───
app.post('/auth/register', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, source } = req.body || {};
    if (!firstName || !lastName || !source) {
      return res.status(400).json({ status: 'error', message: 'All fields are required' });
    }

    const client = getClient();
    const fullName = `${String(firstName).trim()} ${String(lastName).trim()}`;

    const { error } = await client
      .from('users')
      .update({
        name: fullName,
        source: String(source).trim().slice(0, 60),
        registration_complete: true,
      })
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
      user: {
        id: data?.id || req.user.userId,
        email: data?.email || req.user.email,
        name: data?.name || fullName,
        picture: data?.picture,
        currentPlan: data?.current_plan,
        planStatus: data?.plan_status || 'none',
        planStartDate: data?.plan_start_date,
        planEndDate: data?.plan_end_date,
        meetLink: data?.meet_link,
        registrationComplete: true,
      },
    });
    console.log(`auth: registration uid=${req.user.userId}`);
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

    res.json({ status: 'success', message: 'Plan cancelled — active until end of billing cycle', user: data });
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
    // admin home and we want a single round-trip cost.
    const [usersRes, paymentsRes] = await Promise.all([
      client.from('users').select('plan_status,current_plan,registration_complete,created_at'),
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
    currentPlan: u.current_plan,
    planStatus: u.plan_status,
    planStartDate: u.plan_start_date,
    planEndDate: u.plan_end_date,
    utrId: u.utr_id,
    meetLink: u.meet_link,
    registrationComplete: u.registration_complete,
    createdAt: u.created_at,
    lastLogin: u.last_login,
  };
}

// ─── GET /admin/users ───
app.get('/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim().slice(0, 100);
    const status = (req.query.status || '').toString().trim();
    const plan = (req.query.plan || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    const client = getClient();
    let query = client.from('users').select('*').order('created_at', { ascending: false }).limit(limit);
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
    if ('meetLink'      in body) updates.meet_link       = body.meetLink      || null;
    if ('phone'         in body) updates.phone           = body.phone         || null;
    if ('source'        in body) updates.source          = body.source        || null;
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
  } catch (e) {
    console.error('admin patch exception:', e.message);
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
app.post('/api/payment/create', async (req, res) => {
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
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 100000) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }
    const result = await createPaymentRecord({ amount: numericAmount, plan: planClean, upiId: 'devtoolpro@ybl' });
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
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/payment/submit-utr ───
// Auto-verify threshold raised from 70 → 95. A clean 12-digit UTR still
// scores 100 and auto-verifies; anything with repeating digits or obvious
// test prefixes now waits for human review.
const AUTO_VERIFY_THRESHOLD = 95;

app.post('/api/payment/submit-utr', async (req, res) => {
  try {
    const { paymentId, utrId } = req.body || {};
    if (!paymentId || !utrId) {
      return res.status(400).json({ status: 'error', message: 'Payment ID and UTR are required' });
    }

    const result = await submitUTR(paymentId, utrId);
    if (!result.success) {
      return res.status(400).json({ status: 'error', message: result.message });
    }

    const confidence = getUTRConfidence(utrId.trim());

    if (confidence >= AUTO_VERIFY_THRESHOLD) {
      try {
        await verifyPayment(paymentId);
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

    console.log(`payment: utr submitted id=${paymentId} confidence=${confidence}`);
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
