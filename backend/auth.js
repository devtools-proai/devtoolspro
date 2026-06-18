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
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!response.ok) {
      return { valid: false, message: 'Invalid Google token' };
    }
    const payload = await response.json();

    // Verify the token is for our app
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      return { valid: false, message: 'Token not issued for this app' };
    }

    return {
      valid: true,
      user: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        emailVerified: payload.email_verified === 'true'
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
  // Check if user exists
  const { data: existing } = await client
    .from('users')
    .select('*')
    .eq('google_id', googleUser.googleId)
    .single();

  if (existing) {
    // Update last login
    await client
      .from('users')
      .update({ last_login: new Date().toISOString(), picture: googleUser.picture })
      .eq('id', existing.id);
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
    console.error('Create user error:', error.message);
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

module.exports = {
  verifyGoogleToken,
  findOrCreateUser,
  generateSessionToken,
  verifySessionToken,
  requireAuth,
  GOOGLE_CLIENT_ID
};
