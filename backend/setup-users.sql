-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Users Table (Google SSO)
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- Name: "Create Users Table"
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  phone TEXT,
  source TEXT,
  registration_complete BOOLEAN DEFAULT FALSE,
  current_plan TEXT,
  plan_status TEXT DEFAULT 'none' CHECK (plan_status IN ('none', 'active', 'cancelled', 'expired')),
  plan_start_date TIMESTAMPTZ,
  plan_end_date TIMESTAMPTZ,
  utr_id TEXT,
  meet_link TEXT,
  last_login TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on users" ON users
  FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════
-- DONE! Users table ready for Google SSO.
-- ═══════════════════════════════════════════════════════════
