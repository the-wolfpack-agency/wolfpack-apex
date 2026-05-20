-- Migration 145 — expand instinct_team_members.role CHECK to cover
-- the full TeamRole union.
--
-- The original constraint from migration 001 only allowed:
--   ceo, cto, dev, sales, ops
-- but the TS type and capability map cover:
--   ceo, cto, evp, vp, cco, hr, dev, sales, ops, designer
--
-- Jorge (VP) tried to accept his invite at the 2026-05-20 kickoff
-- and got "Could not create your account" — the team_members INSERT
-- hit the CHECK violation and bubbled as our generic 500. Same
-- failure mode awaits any future VP / CCO / EVP / HR / designer
-- accept until this lands.
--
-- Idempotent: DROP IF EXISTS + ADD with NOT VALID-safe identifier
-- (we accept existing rows; new inserts get the new rule).

BEGIN;

ALTER TABLE instinct_team_members
  DROP CONSTRAINT IF EXISTS apex_team_members_role_check;

ALTER TABLE instinct_team_members
  DROP CONSTRAINT IF EXISTS instinct_team_members_role_check;

ALTER TABLE instinct_team_members
  ADD CONSTRAINT instinct_team_members_role_check
  CHECK (role IN ('ceo', 'cto', 'evp', 'vp', 'cco', 'hr', 'dev', 'sales', 'ops', 'designer'));

COMMIT;
