-- Down for migration 145 — reverts to the original 5-role CHECK.
-- DANGEROUS: will FAIL if any row has a role outside the legacy set.

BEGIN;

ALTER TABLE instinct_team_members
  DROP CONSTRAINT IF EXISTS instinct_team_members_role_check;

ALTER TABLE instinct_team_members
  ADD CONSTRAINT apex_team_members_role_check
  CHECK (role IN ('ceo', 'cto', 'dev', 'sales', 'ops'));

COMMIT;
