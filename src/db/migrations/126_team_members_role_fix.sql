-- 126_team_members_role_fix.sql — fix Nick Homyk's row + add him to
-- the seed.
--
-- Migration 125 seeded the team but missed Nick Homyk (CTO,
-- homyk@thewolfpack.agency). When he signed in via Microsoft
-- afterwards, the upsert in /api/microsoft/callback created his row
-- with the default role='ops'. This migration adds the row if it
-- doesn't exist with the correct role, and corrects any pre-existing
-- row that landed with role='ops' from a Microsoft sign-in.
--
-- Idempotent — safe to re-run.

BEGIN;

-- Insert if missing.
INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active, created_at)
VALUES (gen_random_uuid(), 'homyk@thewolfpack.agency', 'Nick Homyk', 'cto', NULL, TRUE, NOW())
ON CONFLICT (email) DO NOTHING;

-- Correct role for an existing row that may have landed as 'ops' via
-- the MS sign-in upsert before this migration.
UPDATE instinct_team_members
   SET role = 'cto'
 WHERE email = 'homyk@thewolfpack.agency'
   AND role <> 'cto';

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM instinct_team_members
     WHERE email = 'homyk@thewolfpack.agency' AND role = 'cto'
  ), 'homyk@thewolfpack.agency not present with role cto';
END $$;

COMMIT;
