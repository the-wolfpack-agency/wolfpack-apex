-- Migration 021: Per-user capability overrides (module-level RBAC)
--
-- Adds a single JSONB column to apex_team_members. Shape:
--   {
--     "grants":  ["finance.reports.view"],
--     "revokes": ["docs.edit"],
--     "expires": { "finance.reports.view": "2026-05-01T00:00:00Z" }
--   }
--
-- Resolver: effective = (role_defaults ∪ grants) \ revokes, excluding
-- grants whose expiry is in the past.
--
-- Idempotent. Safe to re-run. Does not touch any other column or table.

ALTER TABLE apex_team_members
  ADD COLUMN IF NOT EXISTS capability_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
