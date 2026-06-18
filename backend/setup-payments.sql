-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Payments Table Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- Create the payments table for real-time verification
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC NOT NULL,
  plan TEXT NOT NULL,
  upi_id TEXT NOT NULL DEFAULT 'devtoolpro@ybl',
  utr_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_verification', 'verified', 'expired', 'failed')),
  utr_submitted_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast status checks (polling)
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

-- Index for UTR duplicate checking
CREATE INDEX IF NOT EXISTS idx_payments_utr ON payments (LOWER(utr_id)) WHERE utr_id IS NOT NULL;

-- Index for expiry checks
CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments (expires_at) WHERE status = 'pending';

-- Enable Row Level Security
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Allow all operations from API (anon key)
CREATE POLICY "Allow all on payments" ON payments
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════
-- DONE! Payments table ready for real-time verification.
-- ═══════════════════════════════════════════════════════════
