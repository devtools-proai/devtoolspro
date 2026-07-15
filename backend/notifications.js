/**
 * Notifications Module
 *
 * Admin → user notification channel. The dashboard reads these via
 * GET /api/notifications; admins create them via POST /admin/users/:id/notifications.
 *
 * All operations funnel through the service-role Supabase client so
 * RLS never blocks us. Route-level auth is the single source of truth
 * for who can call what.
 *
 * Notification lifecycle:
 *   created → (user opens dashboard) → read_at set → (user clicks ×) → dismissed_at set
 *
 * The dashboard hides dismissed notifications by default; admins see
 * the full trail via GET /admin/users/:id/notifications.
 */

const { getClient } = require('./db');

const ALLOWED_KINDS = new Set(['info', 'warn', 'urgent', 'success']);

// Hard caps on lengths so a rogue admin (or a buggy client) can't
// paste an entire novel into a notification. Titles fit in a
// single-line dashboard heading; bodies fit in a compact card.
const TITLE_MAX = 120;
const BODY_MAX = 800;
const ACTION_LABEL_MAX = 40;
const ACTION_URL_MAX = 500;

/**
 * Validate + normalise a create payload. Returns
 *   { valid: true, data }  — sanitised, ready to insert
 *   { valid: false, message }
 */
function validateNotification({ title, body, kind, actionUrl, actionLabel }) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t) return { valid: false, message: 'Title is required' };
  if (!b) return { valid: false, message: 'Body is required' };
  if (t.length > TITLE_MAX) return { valid: false, message: `Title must be ≤ ${TITLE_MAX} chars` };
  if (b.length > BODY_MAX) return { valid: false, message: `Body must be ≤ ${BODY_MAX} chars` };

  const k = String(kind || 'info').toLowerCase();
  if (!ALLOWED_KINDS.has(k)) {
    return { valid: false, message: `kind must be one of ${[...ALLOWED_KINDS].join(', ')}` };
  }

  let cleanedUrl = null;
  let cleanedLabel = null;
  if (actionUrl || actionLabel) {
    const url = String(actionUrl || '').trim();
    const label = String(actionLabel || '').trim();
    // If either is set, both must be set — half-configured CTAs
    // render weirdly on the dashboard.
    if (!url || !label) {
      return { valid: false, message: 'action_url and action_label must both be set (or both empty)' };
    }
    if (url.length > ACTION_URL_MAX) return { valid: false, message: 'action_url is too long' };
    if (label.length > ACTION_LABEL_MAX) return { valid: false, message: 'action_label is too long' };
    // Only http(s) and mailto are safe. javascript:/data: are rejected.
    if (!/^(https?:|mailto:)/i.test(url)) {
      return { valid: false, message: 'action_url must start with http(s):// or mailto:' };
    }
    cleanedUrl = url;
    cleanedLabel = label;
  }

  return {
    valid: true,
    data: {
      title: t,
      body: b,
      kind: k,
      action_url: cleanedUrl,
      action_label: cleanedLabel,
    },
  };
}

/**
 * Insert a notification for a single user. Returns
 *   { success: true, notification }
 *   { success: false, status, message }
 * `status` is a suggested HTTP status for the route handler to echo.
 */
async function createForUser(userId, payload, createdBy = 'admin') {
  if (!userId) return { success: false, status: 400, message: 'user_id is required' };
  const check = validateNotification(payload);
  if (!check.valid) return { success: false, status: 400, message: check.message };

  const client = getClient();

  // Verify the user exists before inserting so we don't strand rows
  // (the FK is CASCADE-on-delete, so orphans aren't a long-term risk,
  // but returning a clear 404 helps the admin UX).
  const { data: userRow, error: userErr } = await client
    .from('users')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) {
    console.error('notifications.createForUser user lookup error:', userErr.message || userErr);
    return { success: false, status: 500, message: 'User lookup failed' };
  }
  if (!userRow) return { success: false, status: 404, message: 'User not found' };

  const { data, error } = await client
    .from('notifications')
    .insert({
      user_id: userId,
      title: check.data.title,
      body: check.data.body,
      kind: check.data.kind,
      action_url: check.data.action_url,
      action_label: check.data.action_label,
      created_by: String(createdBy || 'admin').slice(0, 60),
    })
    .select()
    .single();

  if (error) {
    console.error('notifications.createForUser insert error:', error.message || error);
    // Surface a specific message per known failure mode so admins
    // can self-diagnose without having to open Render logs. This is
    // safe because /admin/* is JWT-gated; the caller is authorised.
    const msg = String(error.message || '');
    const code = String(error.code || '');
    let userFacing = msg || 'Failed to create notification';
    // 42P01 = undefined_table — the `notifications` table hasn't
    // been created yet. This is the #1 cause of the "Failed to send
    // notification" error immediately after the v1.3 rollout.
    if (code === '42P01' || /relation .*notifications.* does not exist/i.test(msg)) {
      userFacing = 'The notifications table does not exist yet. Please run backend/setup-notifications.sql in the Supabase SQL editor, then try again.';
    } else if (code === '23503') {
      userFacing = 'Could not send — the user may have been deleted. Refresh the page and try again.';
    } else if (code === '42501' || /permission denied/i.test(msg)) {
      userFacing = 'Database permission denied. The backend needs the SERVICE_ROLE key (not the anon key) — check SUPABASE_KEY in your environment.';
    }
    return { success: false, status: 500, message: userFacing };
  }
  return { success: true, notification: data };
}

/**
 * List notifications for a user (dashboard view).
 *
 * Options:
 *   { includeDismissed: false }  — dashboard's primary panel
 *   { includeDismissed: true }   — full history (admin trail)
 *
 * Defaults to the last 30 rows, newest first.
 */
async function listForUser(userId, { includeDismissed = false, limit = 30 } = {}) {
  if (!userId) return { success: false, message: 'user_id required', notifications: [] };
  const client = getClient();
  let query = client
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, limit), 200));
  if (!includeDismissed) {
    query = query.is('dismissed_at', null);
  }
  const { data, error } = await query;
  if (error) {
    console.error('notifications.listForUser error:', error.message || error);
    return { success: false, message: error.message, notifications: [] };
  }
  return { success: true, notifications: data || [] };
}

/**
 * Count unread + non-dismissed notifications for a user. Used for the
 * bell badge on the dashboard header.
 */
async function unreadCountForUser(userId) {
  if (!userId) return 0;
  const client = getClient();
  const { count, error } = await client
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null)
    .is('dismissed_at', null);
  if (error) {
    console.warn('notifications.unreadCountForUser warning:', error.message || error);
    return 0;
  }
  return count || 0;
}

/**
 * Mark a single notification as read. Idempotent — re-marking is a no-op.
 * Ownership check: only the notification's owner (or admin, checked at
 * route level) can mark it read.
 */
async function markRead(notificationId, userId) {
  const client = getClient();
  const { data, error } = await client
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('user_id', userId)
    .is('read_at', null)
    .select()
    .maybeSingle();
  if (error) {
    console.error('notifications.markRead error:', error.message || error);
    return { success: false, message: 'Failed to mark read' };
  }
  return { success: true, notification: data || null };
}

/**
 * Mark all a user's unread notifications as read. Used by the dashboard's
 * "Mark all read" button.
 */
async function markAllReadForUser(userId) {
  const client = getClient();
  const { error, count } = await client
    .from('notifications')
    .update({ read_at: new Date().toISOString() }, { count: 'exact' })
    .eq('user_id', userId)
    .is('read_at', null)
    .is('dismissed_at', null);
  if (error) {
    console.error('notifications.markAllReadForUser error:', error.message || error);
    return { success: false, updated: 0 };
  }
  return { success: true, updated: count || 0 };
}

/**
 * Dismiss (hide) a notification from the primary dashboard panel.
 * Row stays in the DB so the admin trail is preserved.
 */
async function dismiss(notificationId, userId) {
  const client = getClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await client
    .from('notifications')
    .update({
      dismissed_at: nowIso,
      // Auto-mark as read on dismiss — a dismissal implies awareness.
      read_at: nowIso,
    })
    .eq('id', notificationId)
    .eq('user_id', userId)
    .is('dismissed_at', null)
    .select()
    .maybeSingle();
  if (error) {
    console.error('notifications.dismiss error:', error.message || error);
    return { success: false, message: 'Failed to dismiss' };
  }
  return { success: true, notification: data || null };
}

/**
 * Delete a notification outright. Admin-only, exposed via
 * DELETE /admin/notifications/:id. Used when an admin sent the wrong
 * message and wants it gone from the trail too.
 */
async function adminDelete(notificationId) {
  const client = getClient();
  const { data, error } = await client
    .from('notifications')
    .delete()
    .eq('id', notificationId)
    .select()
    .maybeSingle();
  if (error) {
    console.error('notifications.adminDelete error:', error.message || error);
    return { success: false, message: error.message };
  }
  return { success: true, notification: data || null };
}

// Serialise a DB row to the camelCase DTO the frontends expect.
function toDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    actionUrl: row.action_url,
    actionLabel: row.action_label,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

module.exports = {
  ALLOWED_KINDS,
  validateNotification,
  createForUser,
  listForUser,
  unreadCountForUser,
  markRead,
  markAllReadForUser,
  dismiss,
  adminDelete,
  toDto,
};
