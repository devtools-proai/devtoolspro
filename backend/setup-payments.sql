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

-- Indices: status (polling), UTR (dedup), expiry (cleanup).
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_utr     ON payments (LOWER(utr_id)) WHERE utr_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments (expires_at) WHERE status = 'pending';

-- Enable Row Level Security
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on payments" ON payments;
DROP POLICY IF EXISTS "Allow inserts" ON payments;
DROP POLICY IF EXISTS "Allow reads" ON payments;
DROP POLICY IF EXISTS "Allow updates" ON payments;

-- Default-deny.
CREATE POLICY "payments_deny_anon" ON payments
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ═══════════════════════════════════════════════════════════
-- DONE! Payments table ready for real-time verification.
-- ═══════════════════════════════════════════════════════════
