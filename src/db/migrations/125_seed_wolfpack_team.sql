-- 125_seed_wolfpack_team.sql — provision the Wolfpack team in
-- instinct_team_members so they can sign in via Microsoft.
--
-- Microsoft sign-in (the unified login flow shipped in this commit)
-- upserts on email, so technically these rows could lazy-create on
-- first OAuth callback. Seeding ahead of time gives us:
--   1. Team scoreboard "X of Y connected" coverage from day one
--      (we can list "not yet connected" for each role).
--   2. Capability assignment / ownership badges on principles before
--      anyone has logged in.
--
-- password_hash is NULL — these accounts are MS-sign-in primary.
-- The existing /api/auth/login (password) path stays online as a
-- fallback for the transition window per the leadership decision.
-- Once everyone has signed in via MS at least once, the password
-- column can be dropped or kept for break-glass.
--
-- Idempotent — re-running this migration is safe (ON CONFLICT (email)
-- DO NOTHING preserves any prior rows that may have been created
-- via the existing password flow).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active, created_at)
VALUES
  (gen_random_uuid(), 'nick@thewolfpack.agency',     'Nick Hoxsie',    'ceo',   NULL, TRUE, NOW()),
  (gen_random_uuid(), 'jorge@thewolfpack.agency',    'Jorge Colon',    'ops',   NULL, TRUE, NOW()),
  (gen_random_uuid(), 'max@thewolfpack.agency',      'Max Fuerst',     'ops',   NULL, TRUE, NOW()),
  (gen_random_uuid(), 'meghan@thewolfpack.agency',   'Meghan',         'ops',   NULL, TRUE, NOW()),
  (gen_random_uuid(), 'alicia@thewolfpack.agency',   'Alicia Zulker',  'ops',   NULL, TRUE, NOW()),
  (gen_random_uuid(), 'ashley@thewolfpack.agency',   'Ashley',         'ops',   NULL, TRUE, NOW()),
  (gen_random_uuid(), 'david@thewolfpack.agency',    'David',          'ops',   NULL, TRUE, NOW())
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  expected TEXT[] := ARRAY[
    'nick@thewolfpack.agency',
    'jorge@thewolfpack.agency',
    'max@thewolfpack.agency',
    'meghan@thewolfpack.agency',
    'alicia@thewolfpack.agency',
    'ashley@thewolfpack.agency',
    'david@thewolfpack.agency'
  ];
  missing TEXT[];
BEGIN
  SELECT ARRAY_AGG(e)
    INTO missing
    FROM unnest(expected) e
   WHERE NOT EXISTS (
     SELECT 1 FROM instinct_team_members m WHERE m.email = e
   );
  ASSERT missing IS NULL OR array_length(missing, 1) = 0,
    format('seed missing rows: %s', missing);
END $$;

COMMIT;
