-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Submissions Table Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- IMPORTANT: this script is RLS-restrictive. The backend MUST connect with
-- the SERVICE_ROLE key (which bypasses RLS). The anon key cannot read or
-- write this table — that is intentional, submissions contain PII + UTRs.
-- ═══════════════════════════════════════════════════════════

-- Create the submissions table
CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  selected_plan TEXT NOT NULL,
  utr_id TEXT NOT NULL UNIQUE,
  submission_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subscription_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subscription_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Expired', 'Cancelled')),
  meet_link TEXT,
  meet_scheduled BOOLEAN DEFAULT FALSE,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_submissions_utr_id ON submissions (LOWER(utr_id));
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status);
CREATE INDEX IF NOT EXISTS idx_submissions_email  ON submissions (LOWER(email));

-- Enable Row Level Security
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Wipe legacy open policies if they exist.
DROP POLICY IF EXISTS "Allow inserts" ON submissions;
DROP POLICY IF EXISTS "Allow reads" ON submissions;
DROP POLICY IF EXISTS "Allow updates" ON submissions;
DROP POLICY IF EXISTS "Allow all on submissions" ON submissions;
-- Drop the new policy too if it exists, so re-running this script
-- after the lockdown has already been applied is a safe no-op.
DROP POLICY IF EXISTS "submissions_deny_anon" ON submissions;

-- Default-deny.
CREATE POLICY "submissions_deny_anon" ON submissions
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ═══════════════════════════════════════════════════════════
-- DONE! Your table is ready.
-- Now go to Settings → API and copy:
--   1. Project URL → SUPABASE_URL
--   2. service_role secret → SUPABASE_KEY   (NOT the anon key!)
-- ═══════════════════════════════════════════════════════════
