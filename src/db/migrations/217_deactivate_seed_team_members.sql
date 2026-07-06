-- 217_deactivate_seed_team_members.sql
--
-- Deactivate demo / seed team members whose email is on a known-undeliverable
-- domain (wolfpack.dev — parked / for-sale on Afternic, publishes a Null MX
-- "0 ." and SPF "-all", i.e. it refuses all mail and is not Wolfpack-owned).
--
-- Why: these seed rows (cto@, ceo@, dev@, sales@, ops@, …) were selected by the
-- release-gate / digest crons (WHERE is_active = true) and triggered real
-- outbound mail that bounced off ppe-hosted.com — 6 DSNs on 2026-07-04 for
-- cto@wolfpack.dev — and leaked message metadata toward a domain a stranger
-- controls. This codifies the ad-hoc 2026-05-02 DB edit that a later reseed
-- undid (see demo/release-report-2026-05-02.md) so it cannot regress silently.
--
-- Idempotent: the WHERE is_active = true guard means a re-run is a no-op once
-- the rows are already deactivated. Data-corrective only — no schema change,
-- nothing destructive (no DROP / DELETE / TRUNCATE); the rows stay for audit.
-- The runtime guards in lib/mail/undeliverable-recipients.ts are the primary
-- defense; this migration removes the seeds from the candidate pool entirely.

UPDATE instinct_team_members
   SET is_active = false
 WHERE is_active = true
   AND lower(email) LIKE '%@wolfpack.dev';
