-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Payments Table Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- IMPORTANT: this script is RLS-restrictive. The backend MUST connect with
-- the SERVICE_ROLE key (which bypasses RLS). The anon key cannot read or
-- write this table — that is intentional, payments contain UTR/amount/plan.
-- ═══════════════════════════════════════════════════════════

-- Create the payments table for real-time verification
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  plan TEXT NOT NULL,
  upi_id TEXT NOT NULL DEFAULT 'devtoolpro@ybl',
  utr_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_verification', 'verified', 'expired', 'failed')),
  utr_submitted_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- In-place migration for existing prod tables. user_id was added in v1.2
-- to bind every payment to the user who created it — needed for the
-- duplicate-session guard on /api/payment/create and the ownership
-- check on /api/payment/submit-utr. Legacy rows stay NULL (admin can
-- backfill from the linked submission rows if needed).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'payments_user_id_fkey' AND table_name = 'payments'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Indices: status (polling), UTR (dedup), expiry (cleanup),
-- user_id (duplicate-session check on /api/payment/create).
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_utr     ON payments (LOWER(utr_id)) WHERE utr_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_payments_user_open
  ON payments (user_id, status)
  WHERE user_id IS NOT NULL AND status IN ('pending', 'awaiting_verification');

-- Enable Row Level Security
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on payments" ON payments;
DROP POLICY IF EXISTS "Allow inserts" ON payments;
DROP POLICY IF EXISTS "Allow reads" ON payments;
DROP POLICY IF EXISTS "Allow updates" ON payments;
-- Drop the new policy too if it exists, so re-running this script
-- after the lockdown has already been applied is a safe no-op.
DROP POLICY IF EXISTS "payments_deny_anon" ON payments;

-- Default-deny.
CREATE POLICY "payments_deny_anon" ON payments
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ═══════════════════════════════════════════════════════════
-- DONE! Payments table ready for real-time verification.
-- ═══════════════════════════════════════════════════════════
