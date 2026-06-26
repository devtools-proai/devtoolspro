-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Users Table (Google SSO)
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- IMPORTANT: this script is RLS-restrictive. The backend MUST connect with
-- the SERVICE_ROLE key (which bypasses RLS). The anon key cannot read or
-- write this table — that is intentional.
--
-- This script is idempotent: re-running it on an existing production
-- database is safe. New columns are added via ALTER TABLE IF NOT EXISTS,
-- the plan_status CHECK is reattached, and the RLS policies are reset.
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
  -- ─── Scheduled-change columns ─────────────────────────────────────
  -- pending_plan / pending_plan_effective are used by the downgrade
  -- flow: the user pays for the lower tier now, keeps their current
  -- (higher) plan benefits until the end of this billing cycle, and the
  -- admin / a cron flips current_plan -> pending_plan when the
  -- effective date passes. NULL means no change is scheduled.
  pending_plan TEXT,
  pending_plan_effective TIMESTAMPTZ,
  last_login TIMESTAMPTZ DEFAULT NOW(),
  -- updated_at is auto-maintained by the trg_users_bump_updated_at trigger
  -- below; it only changes when business-relevant fields change (plan,
  -- status, UTR, meet link, name, etc.) so passive logins / avatar
  -- refreshes don't pollute the "last activity" timestamp shown in admin.
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── In-place migration of an existing prod table ────────────────────
-- Add the new pending-change columns if they're missing. Safe to re-run
-- — IF NOT EXISTS makes this a no-op once applied.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_plan TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_plan_effective TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Backfill updated_at on existing rows: prefer plan_start_date (last
-- known business event) and fall back to created_at. Without this the
-- column would be NULL on every existing row and the admin "Updated"
-- column would show '—' for everyone until they next interact.
UPDATE users
  SET updated_at = COALESCE(plan_start_date, created_at, NOW())
  WHERE updated_at IS NULL;

-- Lock down the column once backfilled.
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE users ALTER COLUMN updated_at SET NOT NULL;

-- Trigger function: bump updated_at only when business-significant
-- fields change. last_login and picture explicitly excluded so the
-- avatar refresh on every login doesn't masquerade as activity.
CREATE OR REPLACE FUNCTION users_bump_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_plan            IS DISTINCT FROM OLD.current_plan
     OR NEW.plan_status          IS DISTINCT FROM OLD.plan_status
     OR NEW.plan_start_date      IS DISTINCT FROM OLD.plan_start_date
     OR NEW.plan_end_date        IS DISTINCT FROM OLD.plan_end_date
     OR NEW.utr_id               IS DISTINCT FROM OLD.utr_id
     OR NEW.meet_link            IS DISTINCT FROM OLD.meet_link
     OR NEW.pending_plan         IS DISTINCT FROM OLD.pending_plan
     OR NEW.pending_plan_effective IS DISTINCT FROM OLD.pending_plan_effective
     OR NEW.name                 IS DISTINCT FROM OLD.name
     OR NEW.phone                IS DISTINCT FROM OLD.phone
     OR NEW.source               IS DISTINCT FROM OLD.source
     OR NEW.registration_complete IS DISTINCT FROM OLD.registration_complete THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_bump_updated_at ON users;
CREATE TRIGGER trg_users_bump_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION users_bump_updated_at();

-- Index the effective-date column so the "apply due downgrades" admin
-- query stays fast as the table grows. Partial index keeps it tiny —
-- rows with no pending change don't pay for an index entry.
CREATE INDEX IF NOT EXISTS idx_users_pending_plan_effective
  ON users (pending_plan_effective)
  WHERE pending_plan IS NOT NULL;

-- If the table existed already with the old CHECK, swap the constraint
-- in place so 'processing' is accepted without dropping the table.
DO $$
BEGIN
  EXECUTE (
    SELECT 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(conname)
    FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan_status%'
    LIMIT 1
  );
EXCEPTION WHEN OTHERS THEN
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
-- DONE!
-- ═══════════════════════════════════════════════════════════
