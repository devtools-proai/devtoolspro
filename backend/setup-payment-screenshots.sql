-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Payment Screenshots Table
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- Purpose: reduce fake-payment fraud. When a user submits their UTR
-- we require them to also upload the actual UPI payment screenshot.
-- The image + sha256 hash live here (kept off the payments table so
-- that heavy blob doesn't slow every admin-list scan of payments).
--
-- The `screenshot_*` metadata columns (extraction, timestamps,
-- confidence) still live ON payments in setup-payments.sql — those
-- are small and get queried alongside the payment row.
--
-- IMPORTANT: this script is RLS-restrictive. Service-role only.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_screenshots (
  -- 1-to-1 with payments — a single screenshot per payment row.
  -- ON DELETE CASCADE mirrors the "row lifetime = payment lifetime"
  -- invariant; deleting a payment cleans its screenshot too.
  payment_id UUID PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- base64 data URL of the JPEG (or PNG). The client compresses to
  -- <= ~250KB JPEG before upload, so the row stays under 350KB after
  -- base64 overhead. Keeping the blob in a dedicated table means the
  -- admin's "list pending payments" query never has to load it.
  image_data TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg'
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  -- SHA-256 of the raw image bytes (before base64). Used to reject
  -- duplicate uploads — a repeat of the same screenshot means the
  -- user is trying to reuse a previously-approved payment proof.
  sha256 TEXT NOT NULL,
  byte_length INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique on sha256 so the very first re-upload of a duplicate image
-- fails at the DB layer, not just at the application layer. Belt-and-
-- braces against races between two near-simultaneous uploads of the
-- same file.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_screenshots_sha256
  ON payment_screenshots (sha256);

CREATE INDEX IF NOT EXISTS idx_payment_screenshots_user
  ON payment_screenshots (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- ─── Table-level privileges ────────────────────────────────
-- Same pattern as setup-notifications.sql — see the extended
-- comment there for why we grant explicitly rather than rely on
-- ALTER DEFAULT PRIVILEGES.
GRANT ALL PRIVILEGES ON TABLE payment_screenshots TO postgres, service_role;
GRANT ALL PRIVILEGES ON TABLE payment_screenshots TO anon, authenticated;

-- ─── Row Level Security ────────────────────────────────────
ALTER TABLE payment_screenshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_screenshots_deny_anon" ON payment_screenshots;

CREATE POLICY "payment_screenshots_deny_anon" ON payment_screenshots
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Force PostgREST to pick up the fresh table without a restart.
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- DONE! Payment screenshots table ready.
-- ═══════════════════════════════════════════════════════════
