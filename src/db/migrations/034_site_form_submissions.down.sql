-- 034_site_form_submissions.down.sql — reversible teardown of migration 034.
--
-- Drops the Instinct view first (it depends on the table), then indexes,
-- then the table itself. Safe to run partially (IF EXISTS everywhere).
-- Audit log rows written via trackEvent('site.form_*') persist in
-- apex_events independent of this teardown, so the learning loop does
-- not lose the lifecycle of rejected vs accepted submissions.

DROP VIEW IF EXISTS instinct_site_form_submissions;

DROP INDEX IF EXISTS apex_site_form_submissions_email_status_idx;
DROP INDEX IF EXISTS apex_site_form_submissions_created_idx;
DROP INDEX IF EXISTS apex_site_form_submissions_site_idx;

DROP TABLE IF EXISTS apex_site_form_submissions;
