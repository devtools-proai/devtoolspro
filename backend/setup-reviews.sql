-- ═══════════════════════════════════════════════════════════
-- DevTools Pro — Reviews Table Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Developer',
  review_text TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5 CHECK (rating >= 1 AND rating <= 5),
  -- Default approved=TRUE preserves the existing flow (user reviews appear
  -- live in the scrolling carousel). To moderate, flip the default to FALSE
  -- and add an admin endpoint for approval.
  approved BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews (approved, created_at DESC);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on reviews" ON reviews;

-- Default-deny. The backend (service_role) bypasses RLS for both inserts
-- (POST /api/reviews) and reads (GET /api/reviews) so behavior is unchanged
-- for users, while a leaked anon key cannot exfiltrate or spam this table
-- directly.
CREATE POLICY "reviews_deny_anon" ON reviews
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ═══════════════════════════════════════════════════════════
-- DONE! Reviews table ready.
-- ═══════════════════════════════════════════════════════════
