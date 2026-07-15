-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Notifications Table
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- Powers the admin → user notification channel surfaced in the user's
-- dashboard. Common use cases:
--   • "The UTR you submitted doesn't look right — please recheck."
--   • "Your WhatsApp number seems unreachable — please DM us the
--      correct number so we can send your Meet link."
--   • Ad-hoc account messages the admin needs the user to see in-app
--      when WhatsApp isn't reaching them.
--
-- IMPORTANT: this script is RLS-restrictive. The backend MUST connect
-- with the SERVICE_ROLE key (which bypasses RLS). The anon key cannot
-- read or write this table — that is intentional.
--
-- Idempotent: re-running this on an existing database is safe. Every
-- object is guarded with IF NOT EXISTS / DROP IF EXISTS.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- kind drives the pill colour + icon on the dashboard card.
  -- 'urgent' pops a shake animation the first time it's seen.
  kind TEXT NOT NULL DEFAULT 'info'
    CHECK (kind IN ('info', 'warn', 'urgent', 'success')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Optional in-app call-to-action. The dashboard renders these as a
  -- pair of primary + secondary link chips beneath the body. Both
  -- can be NULL for pure-informational notes.
  action_url TEXT,
  action_label TEXT,
  -- Populated when the user opens the notifications panel and the
  -- entry is visible for more than 500ms, or when they explicitly
  -- click "Mark as read". NULL for unread. NEVER cleared once set.
  read_at TIMESTAMPTZ,
  -- Populated when the user dismisses the entry via the × affordance.
  -- Dismissed notifications are hidden from the primary panel view
  -- but stay in the database so admins can see the full trail.
  dismissed_at TIMESTAMPTZ,
  -- Who created the row. 'admin' for now; kept as free-form text so
  -- we can plumb through per-admin usernames later without a
  -- migration when the admin table stops being a single-user shim.
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ────────────────────────────────────────────────
-- The dashboard's "give me the last 20 for this user, newest first"
-- query hits this composite index directly.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- Fast unread-count badge — partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL AND dismissed_at IS NULL;

-- ─── Table-level privileges ────────────────────────────────
-- RLS bypass via service_role is ONE layer. Table-level GRANTs
-- are the OTHER. On newer Supabase projects `ALTER DEFAULT
-- PRIVILEGES` auto-grants service_role on every table in `public`,
-- but older projects don't have this default and would 42501 on any
-- INSERT / SELECT even though RLS would allow it. Being explicit
-- here means the same setup script works on both.
--
-- Postgres role is the owner and always has full access anyway;
-- listing it is defensive against unusual Supabase configurations
-- where the SQL editor runs as `supabase_admin` and the postgres
-- role otherwise lacks a direct grant.
GRANT ALL PRIVILEGES ON TABLE notifications TO postgres, service_role;
-- anon + authenticated are LATER blocked by the deny-all RLS policy
-- below, but we still grant so PostgREST recognises the table on
-- its own inspection queries. Belt-and-braces.
GRANT ALL PRIVILEGES ON TABLE notifications TO anon, authenticated;

-- ─── Row Level Security ────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_deny_anon" ON notifications;

-- Default-deny. Backend uses service_role (bypasses RLS) so it can
-- still read/write freely. Anon / authenticated keys get nothing.
CREATE POLICY "notifications_deny_anon" ON notifications
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Force PostgREST to pick up the fresh table + policies without a
-- restart. Without this, brand-new tables sometimes return 42501
-- until the schema cache refreshes on its own timer (~10 min).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- DONE! Notifications table ready.
-- ═══════════════════════════════════════════════════════════
