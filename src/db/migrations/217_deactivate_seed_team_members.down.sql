-- 217_deactivate_seed_team_members.down.sql
--
-- Intentionally a no-op. Reactivating the demo / seed accounts would re-arm the
-- undeliverable-recipient bounce class that migration 217 exists to stop. The
-- forward migration is data-corrective (not schema), so there is nothing safe
-- to reverse — a blind UPDATE ... SET is_active = true would also revive rows
-- that were legitimately deactivated for other reasons. Present only to satisfy
-- the paired-.down.sql convention.
SELECT 1;
