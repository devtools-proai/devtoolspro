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
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { initDB, addSubmission, getAllSubmissions, getSubmissionByUTR, getStats, getClient } = require('./db');
const { generateSetupMessage, generateQuickReply } = require('./meet-service');
const { createPaymentRecord, submitUTR, getPaymentStatus, verifyPayment, getPendingPayments, getUTRConfidence } = require('./payment-verify');
const { verifyGoogleToken, findOrCreateUser, generateSessionToken, requireAuth, GOOGLE_CLIENT_ID, adminCredsConfigured, verifyAdminCreds, generateAdminToken, requireAdminAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (Render, Railway, etc. put a reverse proxy in front)
app.set('trust proxy', 1);

// ─── Middleware ───
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-admin-key', 'Authorization']
}));

// Rate limiting
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { status: 'error', message: 'Too many requests, try again later' } });
const submitLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { status: 'error', message: 'Too many submissions, try again later' } });
const reviewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { status: 'error', message: 'Too many reviews, try again later' } });
app.use('/api/', generalLimiter);

// Admin auth middleware
function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
}

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
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════
// AUTHENTICATION ENDPOINTS
// ═══════════════════════════════════════════

// ─── POST /auth/google ───
// Verify Google ID token and return session JWT
app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ status: 'error', message: 'ID token required' });
    }

    // Verify with Google
    const result = await verifyGoogleToken(idToken);
    if (!result.valid) {
      return res.status(401).json({ status: 'error', message: result.message });
    }

    // Find or create user in DB
    const client = getClient();
    const user = await findOrCreateUser(client, result.user);
    if (!user) {
      return res.status(500).json({ status: 'error', message: 'Failed to create user' });
    }

    // Generate session token
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
        planEndDate: user.plan_end_date
      }
    });

    console.log(`🔐 User logged in: ${user.email}`);
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ status: 'error', message: 'Authentication failed' });
  }
});

// ─── GET /auth/me ───
// Get current user profile (requires auth)
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
        createdAt: user.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /auth/update-plan ───
// Update user's plan after successful payment (requires auth)
app.post('/auth/update-plan', requireAuth, async (req, res) => {
  try {
    const { plan, utrId, meetLink } = req.body;
    const client = getClient();

    const now = new Date();
    // Next renewal = first day of the *next* calendar month. The user paid a
    // prorated amount covering today through the last day of this month; from
    // the 1st onwards, full monthly billing applies on the same calendar date.
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const { data, error } = await client
      .from('users')
      .update({
        current_plan: plan,
        plan_status: 'processing',
        plan_start_date: now.toISOString(),
        plan_end_date: endDate.toISOString(),
        utr_id: utrId || null,
        meet_link: meetLink || null
      })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ status: 'error', message: 'Failed to update plan' });
    }

    // Return the same camelCase shape /auth/me uses, so the frontend can
    // merge in the authoritative dates without translating column names.
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
        meetLink: data.meet_link
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /auth/register ───
// Complete user registration with additional details (requires auth)
app.post('/auth/register', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, source } = req.body;
    if (!firstName || !lastName || !source) {
      return res.status(400).json({ status: 'error', message: 'All fields are required' });
    }

    const client = getClient();
    const fullName = `${firstName.trim()} ${lastName.trim()}`;

    // Update without returning data (avoids Premature close with cross-fetch)
    const { error } = await client
      .from('users')
      .update({
        name: fullName,
        source: source,
        registration_complete: true
      })
      .eq('id', req.user.userId);

    if (error) {
      console.error('Register error:', JSON.stringify(error));
      return res.status(500).json({ status: 'error', message: error.message });
    }

    // Fetch user data separately
    const { data } = await client
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    res.json({
      status: 'success',
      user: {
        id: data?.id || req.user.userId, email: data?.email || req.user.email, name: data?.name || fullName,
        picture: data?.picture, currentPlan: data?.current_plan, planStatus: data?.plan_status || 'none',
        planStartDate: data?.plan_start_date, planEndDate: data?.plan_end_date, meetLink: data?.meet_link,
        registrationComplete: true
      }
    });
    console.log(`📝 Registration: ${fullName}`);
  } catch (error) {
    console.error('Register exception:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── POST /auth/cancel-plan ───
// Cancel user's plan (requires auth)
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
// Return the Google Client ID for frontend
app.get('/auth/google-client-id', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID });
});

// ═══════════════════════════════════════════
// ADMIN ENDPOINTS — username + password -> JWT
// Requires env: ADMIN_USERNAME + ADMIN_PASSWORD (or ADMIN_KEY as the password)
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
  // Constant-time-ish delay so failed attempts don't leak via timing
  await new Promise(r => setTimeout(r, ok ? 0 : 350));
  if (!ok) {
    return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
  }
  const token = generateAdminToken();
  res.json({ status: 'success', token, expiresIn: 8 * 60 * 60 });
  console.log(`🔐 Admin login: ${username}`);
});

// ─── GET /admin/me ───
// Lightweight token check — frontend uses this on load to decide login vs shell
app.get('/admin/me', requireAdminAuth, (req, res) => {
  res.json({ status: 'success', role: req.admin.role });
});

// ─── GET /admin/stats ───
app.get('/admin/stats', requireAdminAuth, async (req, res) => {
  try {
    const client = getClient();
    const { data, error } = await client.from('users').select('plan_status,current_plan,registration_complete,created_at');
    if (error) {
      console.error('admin/stats error:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
    }
    const list = data || [];
    const by = (k, v) => list.filter(u => u[k] === v).length;
    res.json({
      status: 'success',
      stats: {
        totalUsers: list.length,
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
        }
      }
    });
  } catch (e) {
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
// Optional query params: search (email/name/utr), status, limit (default 200, max 1000)
app.get('/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const status = (req.query.status || '').toString().trim();
    const plan = (req.query.plan || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);

    const client = getClient();
    let query = client.from('users').select('*').order('created_at', { ascending: false }).limit(limit);
    if (status) query = query.eq('plan_status', status);
    if (plan)   query = query.eq('current_plan', plan);
    if (search) {
      // Escape any % to prevent injection-like fuzzing in ilike
      const safe = search.replace(/[%_]/g, '\\$&');
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
// Update any subset of plan / status / dates / meet link / utr / phone / source / name
const ALLOWED_PLANS = new Set(['Pro', 'Pro+', 'Pro Max', 'Power', null]);
const ALLOWED_STATUSES = new Set(['none', 'processing', 'active', 'cancelled', 'expired']);

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
      if (!ALLOWED_STATUSES.has(v)) {
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
      updates.name = body.name.trim();
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
    console.log(`🛠️ Admin updated user ${data.email}: ${JSON.stringify(updates)}`);
  } catch (e) {
    console.error('admin patch exception:', e);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/submit ───
// Main endpoint: receives user form data, stores in DB, returns Meet link + message
app.post('/api/submit', submitLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, selectedPlan, utrId, submissionTimestamp } = req.body;

    // Validate required fields
    const requiredFields = { firstName, lastName, email, selectedPlan, utrId };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value || !value.toString().trim()) {
        return res.status(400).json({
          status: 'error',
          message: `Missing required field: ${field}`
        });
      }
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid email format'
      });
    }

    // Generate Meet link and setup message
    const userData = { firstName, lastName, email, selectedPlan, utrId };
    const setupInfo = generateSetupMessage(userData);

    // Prepare submission record
    const submission = {
      id: uuidv4(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      selectedPlan,
      utrId: utrId.trim(),
      submissionTimestamp: submissionTimestamp || new Date().toISOString(),
      meetLink: setupInfo.meetLink,
      notes: setupInfo.autoReplyNote
    };

    // Save to database
    const result = await addSubmission(submission);

    if (!result.success) {
      if (result.error === 'duplicate') {
        return res.status(409).json({
          status: 'duplicate',
          message: 'This UTR/Transaction ID has already been submitted'
        });
      }
      return res.status(500).json({
        status: 'error',
        message: result.message
      });
    }

    // Build the WhatsApp redirect URL with Meet link included
    const whatsappNumber = process.env.WHATSAPP_NUMBER || '919019879108';
    const quickReply = generateQuickReply(userData, setupInfo.meetLink);
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${whatsappNumber}&text=${encodeURIComponent(setupInfo.whatsappMessage)}`;

    // Return success with Meet link and WhatsApp URL
    res.status(201).json({
      status: 'success',
      message: 'Submission saved successfully',
      data: {
        id: submission.id,
        meetLink: setupInfo.meetLink,
        setupNote: setupInfo.autoReplyNote,
        whatsappUrl,
        whatsappMessage: setupInfo.whatsappMessage,
        quickReply
      }
    });

    console.log(`✅ New submission: ${firstName} ${lastName} | Plan: ${selectedPlan} | Meet: ${setupInfo.meetLink}`);

  } catch (error) {
    console.error('❌ Submit error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

// ─── GET /api/submissions ───
// Admin endpoint: get all submissions
app.get('/api/submissions', requireAdmin, async (req, res) => {
  try {
    const submissions = await getAllSubmissions();
    res.json({
      status: 'success',
      count: submissions.length,
      data: submissions
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/check-utr/:utrId ───
// Check if a UTR already exists
app.get('/api/check-utr/:utrId', async (req, res) => {
  try {
    const existing = await getSubmissionByUTR(req.params.utrId);
    res.json({
      exists: !!existing,
      status: existing ? existing.status : null
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/stats ───
// Get submission statistics
app.get('/api/stats', requireAdmin, async (req, res) => {
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
// Create a payment session when user selects a plan
app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, plan } = req.body;
    if (!amount || !plan) {
      return res.status(400).json({ status: 'error', message: 'Amount and plan are required' });
    }
    const result = await createPaymentRecord({ amount, plan, upiId: 'devtoolpro@ybl' });
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.message });
    }
    res.status(201).json({
      status: 'success',
      paymentId: result.paymentId,
      upiId: 'devtoolpro@ybl',
      amount,
      plan
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/payment/submit-utr ───
// User submits UTR after making payment
app.post('/api/payment/submit-utr', async (req, res) => {
  try {
    const { paymentId, utrId } = req.body;
    if (!paymentId || !utrId) {
      return res.status(400).json({ status: 'error', message: 'Payment ID and UTR are required' });
    }

    const result = await submitUTR(paymentId, utrId);
    if (!result.success) {
      return res.status(400).json({ status: 'error', message: result.message });
    }

    // Calculate UTR confidence score
    const confidence = getUTRConfidence(utrId.trim());

    // Auto-verify high-confidence UTRs immediately (standard 12-digit format)
    if (confidence >= 70) {
      try {
        await verifyPayment(paymentId, process.env.ADMIN_KEY);
        console.log(`✅ Auto-verified payment ${paymentId} (UTR: ${utrId}, confidence: ${confidence})`);
      } catch (e) {
        console.error('Auto-verify failed:', e.message);
      }
    }

    res.json({
      status: 'success',
      message: 'UTR submitted — verifying payment',
      paymentStatus: 'awaiting_verification',
      confidence
    });

    console.log(`💰 UTR submitted: ${utrId} | Payment: ${paymentId} | Confidence: ${confidence}`);
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/payment/status/:paymentId ───
// Frontend polls this to check if payment is verified
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
// Admin: manually verify a payment
app.post('/api/payment/verify/:paymentId', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const result = await verifyPayment(req.params.paymentId, adminKey);
    if (!result.success) {
      return res.status(result.message === 'Unauthorized' ? 401 : 400).json({
        status: 'error',
        message: result.message
      });
    }
    res.json({ status: 'success', message: 'Payment verified', data: result.record });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/payment/pending ───
// Admin: get all payments waiting for verification
app.get('/api/payment/pending', requireAdmin, async (req, res) => {
  try {
    const result = await getPendingPayments(process.env.ADMIN_KEY);
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
// Submit a new review
app.post('/api/reviews', reviewLimiter, async (req, res) => {
  try {
    const { name, city, role, reviewText, rating } = req.body;
    if (!name || !city || !reviewText) {
      return res.status(400).json({ status: 'error', message: 'Name, city, and review text are required' });
    }
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ status: 'error', message: 'Rating must be 1-5' });
    }
    if (reviewText.length > 200) {
      return res.status(400).json({ status: 'error', message: 'Review must be under 200 characters' });
    }

    const client = getClient();
    const { data, error } = await client
      .from('reviews')
      .insert({ name: name.trim(), city: city.trim(), role: role || 'Developer', review_text: reviewText.trim(), rating: parseInt(rating) })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ status: 'error', message: 'Failed to save review' });
    }

    res.status(201).json({ status: 'success', review: data });
    console.log(`⭐ New review from ${name} (${city}) — ${rating}★`);
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/reviews ───
// Get latest approved reviews (for dynamic rendering)
app.get('/api/reviews', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
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
║   Database: Supabase PostgreSQL              ║
║   Meet links: Configured ✓                   ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
