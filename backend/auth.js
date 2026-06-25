/**
 * Google OAuth + JWT Session Management
 * 
 * Flow:
 * 1. Frontend loads Google Sign-In button (GSI library)
 * 2. User clicks → Google popup → returns ID token
 * 3. Frontend sends ID token to POST /auth/google
 * 4. Backend verifies token with Google, creates/finds user in DB
 * 5. Backend returns a JWT session token
 * 6. Frontend stores JWT in localStorage, sends with API requests
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'devtools-pro-jwt-secret-change-me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';

/**
 * Verify Google ID token by calling Google's tokeninfo endpoint
 */
async function verifyGoogleToken(idToken) {
  try {
    // Use native https to avoid cross-fetch issues on Render
    const https = require('https');
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;

    const payload = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error('Failed to parse Google response')); }
        });
      }).on('error', reject);
    });

    if (payload.status !== 200) {
      console.error('Google tokeninfo error:', payload.body);
      return { valid: false, message: 'Invalid Google token: ' + (payload.body.error_description || payload.body.error || 'unknown') };
    }

    const data = payload.body;

    // Verify the token is for our app
    if (data.aud !== GOOGLE_CLIENT_ID) {
      console.error('Client ID mismatch! Token aud:', data.aud, '| Expected:', GOOGLE_CLIENT_ID);
      return { valid: false, message: 'Token not issued for this app' };
    }

    return {
      valid: true,
      user: {
        googleId: data.sub,
        email: data.email,
        name: data.name || data.email.split('@')[0],
        picture: data.picture || '',
        emailVerified: data.email_verified === 'true'
      }
    };
  } catch (err) {
    console.error('Google token verification error:', err.message);
    return { valid: false, message: 'Token verification failed' };
  }
}

/**
 * Create or update user in Supabase and return user record
 */
async function findOrCreateUser(client, googleUser) {
  // Check if user exists. Use maybeSingle() so "no rows" is data:null (not an error),
  // and any other error surfaces so we can fail loudly instead of double-inserting.
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
    // Update last login (best-effort — don't fail login if this update hiccups)
    const { error: updateError } = await client
      .from('users')
      .update({ last_login: new Date().toISOString(), picture: googleUser.picture })
      .eq('id', existing.id);
    if (updateError) {
      console.warn('Update last_login warning:', updateError.message || updateError);
    }
    return existing;
  }

  // Create new user
  const { data: newUser, error } = await client
    .from('users')
    .insert({
      google_id: googleUser.googleId,
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
      current_plan: null,
      plan_status: 'none',
      last_login: new Date().toISOString()
    })
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
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Verify JWT session token (middleware helper)
 */
function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
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
const crypto = require('crypto');

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
  return jwt.sign({ role: 'admin', iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: '8h' });
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Admin auth required' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
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
