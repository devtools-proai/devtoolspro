-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Users Table (Google SSO)
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- IMPORTANT: this script is RLS-restrictive. The backend MUST connect with
-- the SERVICE_ROLE key (which bypasses RLS). The anon key cannot read or
-- write this table — that is intentional.
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
  plan_status TEXT DEFAULT 'none'
    CHECK (plan_status IN ('none', 'processing', 'active', 'cancelled', 'expired')),
  plan_start_date TIMESTAMPTZ,
  plan_end_date TIMESTAMPTZ,
  utr_id TEXT,
  meet_link TEXT,
  last_login TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- If the table existed already with the old CHECK, swap the constraint in
-- place so 'processing' is accepted without dropping the table.
DO $$
BEGIN
  -- Drop the legacy CHECK (whatever Postgres named it) if it doesn't allow 'processing'.
  EXECUTE (
    SELECT 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(conname)
    FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan_status%'
    LIMIT 1
  );
EXCEPTION WHEN OTHERS THEN
  -- No legacy constraint to drop; ignore.
  NULL;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_plan_status_check
  CHECK (plan_status IN ('none', 'processing', 'active', 'cancelled', 'expired'));

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Wipe any open policies left from prior setup scripts.
DROP POLICY IF EXISTS "Allow all on users" ON users;
DROP POLICY IF EXISTS "Allow inserts" ON users;
DROP POLICY IF EXISTS "Allow reads" ON users;
DROP POLICY IF EXISTS "Allow updates" ON users;

-- Default-deny. The backend uses the service_role key which bypasses RLS,
-- so it can still read/write freely. The anon key — which a browser-side
-- attacker is most likely to discover — gets nothing.
CREATE POLICY "users_deny_anon" ON users
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ═══════════════════════════════════════════════════════════
-- DONE! Users table ready for Google SSO.
-- ═══════════════════════════════════════════════════════════
