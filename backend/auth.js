/**
 * Google OAuth + JWT Session Management
 *
 * Flow:
 * 1. Frontend loads Google Sign-In button (GSI library)
 * 2. User clicks → Google popup → returns ID token
 * 3. Frontend sends ID token to POST /auth/google
 * 4. Backend verifies token with Google (signature + audience + issuer + email_verified)
 * 5. Backend creates/updates user via Postgres upsert (race-safe)
 * 6. Backend returns a JWT session token
 * 7. Frontend stores JWT in localStorage, sends with API requests
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// ─── Required-secret validation ───
// In production we refuse to boot if a critical secret is missing or weak.
// In development we still allow startup so contributors can run the server,
// but we emit prominent warnings.
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (isProd) {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET must be set and at least 32 characters in production.');
    process.exit(1);
  }
  if (!GOOGLE_CLIENT_ID) {
    console.error('FATAL: GOOGLE_CLIENT_ID must be set in production.');
    process.exit(1);
  }
} else {
  if (!JWT_SECRET) {
    console.warn('⚠️  WARN: JWT_SECRET is not set. Using an ephemeral dev secret — sessions will not survive a restart.');
  } else if (JWT_SECRET.length < 32) {
    console.warn('⚠️  WARN: JWT_SECRET is shorter than 32 characters. Rotate to a stronger one.');
  }
  if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠️  WARN: GOOGLE_CLIENT_ID is not set — Google Sign-In will fail until you configure it.');
  }
}

// Resolved at module load — never re-read after this point.
const ACTIVE_JWT_SECRET = JWT_SECRET || crypto.randomBytes(48).toString('hex');

// google-auth-library handles JWKs caching + signature + expiry checks for us.
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);

const VALID_GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Verify a Google ID token. Returns { valid, user, message }.
 *
 * Properties we check:
 *   - cryptographic signature (delegated to google-auth-library)
 *   - audience == our GOOGLE_CLIENT_ID
 *   - issuer is one of Google's two canonical issuers
 *   - email_verified is the boolean true
 *   - expiry (delegated)
 */
async function verifyGoogleToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    return { valid: false, message: 'ID token required' };
  }
  if (!GOOGLE_CLIENT_ID) {
    return { valid: false, message: 'Google sign-in is not configured on this server' };
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      return { valid: false, message: 'Token payload missing required fields' };
    }
    if (!VALID_GOOGLE_ISSUERS.has(payload.iss)) {
      return { valid: false, message: 'Invalid token issuer' };
    }
    if (payload.email_verified !== true) {
      return { valid: false, message: 'Google email is not verified' };
    }
    return {
      valid: true,
      user: {
        googleId: payload.sub,
        email: payload.email.toLowerCase().trim(),
        name: payload.name || payload.email.split('@')[0],
        picture: payload.picture || '',
        emailVerified: true,
      },
    };
  } catch (err) {
    // Library throws on any signature / aud / expiry mismatch. Avoid leaking
    // the inner error message back to the client.
    console.warn('Google token verification failed:', err.message);
    return { valid: false, message: 'Invalid or expired Google token' };
  }
}

/**
 * Create or update a user record from a verified Google profile.
 *
 * Implementation uses an atomic upsert keyed on `google_id`, which makes the
 * function safe against two near-simultaneous first-time logins (the older
 * select-then-insert pattern would race and one insert would fail on the
 * unique constraint).
 */
async function findOrCreateUser(client, googleUser) {
  // Fast path: user already exists. We still issue an UPDATE for last_login
  // (and refresh the avatar URL, which Google rotates periodically).
  const { data: existing, error: lookupError } = await client
    .from('users')
    .select('*')
    .eq('google_id', googleUser.googleId)
    .maybeSingle();

  if (lookupError) {
    console.error('Lookup user error:', lookupError.message || lookupError);
    return null;
  }

  if (existing) {
    const { error: updateError } = await client
      .from('users')
      .update({ last_login: new Date().toISOString(), picture: googleUser.picture })
      .eq('id', existing.id);
    if (updateError) {
      console.warn('Update last_login warning:', updateError.message || updateError);
    }
    return existing;
  }

  // Slow path: insert via upsert so concurrent logins don't both try a raw INSERT.
  const { data: newUser, error } = await client
    .from('users')
    .upsert(
      {
        google_id: googleUser.googleId,
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
        current_plan: null,
        plan_status: 'none',
        last_login: new Date().toISOString(),
      },
      { onConflict: 'google_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) {
    console.error('Create user error:', error.message || error);
    return null;
  }

  return newUser;
}

/**
 * Generate a JWT session token for the user
 */
function generateSessionToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, name: user.name },
    ACTIVE_JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Verify JWT session token (middleware helper)
 */
function verifySessionToken(token) {
  try {
    return jwt.verify(token, ACTIVE_JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Express middleware: require authenticated user
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const decoded = verifySessionToken(token);
  if (!decoded) {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired session' });
  }

  req.user = decoded;
  next();
}

/* ─────────────────────────── Admin auth ───────────────────────────
 * Username + password (env-backed) -> short-lived JWT with role: 'admin'.
 * Used by /admin/* endpoints so the registry UI can manage every user
 * without exposing the raw ADMIN_KEY in browser code.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function adminCredsConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && (process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY));
}

function verifyAdminCreds(username, password) {
  const expectedUser = process.env.ADMIN_USERNAME || '';
  const expectedPass = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY || '';
  if (!expectedUser || !expectedPass) return false;
  return safeEqual(username || '', expectedUser) && safeEqual(password || '', expectedPass);
}

function generateAdminToken() {
  return jwt.sign(
    { role: 'admin', iat: Math.floor(Date.now() / 1000) },
    ACTIVE_JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Admin auth required' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, ACTIVE_JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired admin session' });
  }
}

module.exports = {
  verifyGoogleToken,
  findOrCreateUser,
  generateSessionToken,
  verifySessionToken,
  requireAuth,
  GOOGLE_CLIENT_ID,
  // Admin
  adminCredsConfigured,
  verifyAdminCreds,
  generateAdminToken,
  requireAdminAuth,
};
