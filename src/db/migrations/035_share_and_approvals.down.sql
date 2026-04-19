-- 035_share_and_approvals.down.sql — reversible teardown of 035.
--
-- Drop order matches dependency graph: views → approvals (depends on
-- tokens via FK) → tokens. IF EXISTS everywhere so partial applies
-- are safe to re-run.
--
-- WARNING: this drops rows in both tables. Run only when you have
-- confirmed the approvals history is no longer needed for AR/dispute
-- avoidance. The apex_events stream retains `site.approval_recorded`
-- history so the event trail survives teardown.

DROP VIEW IF EXISTS instinct_site_approvals;
DROP VIEW IF EXISTS instinct_share_tokens;

DROP INDEX IF EXISTS apex_site_approvals_state_idx;
DROP INDEX IF EXISTS apex_site_approvals_site_idx;
DROP TABLE IF EXISTS apex_site_approvals;

DROP INDEX IF EXISTS apex_share_tokens_expires_idx;
DROP INDEX IF EXISTS apex_share_tokens_site_idx;
DROP TABLE IF EXISTS apex_share_tokens;
