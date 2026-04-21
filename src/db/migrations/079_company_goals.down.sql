-- 079_company_goals.down.sql — reversible teardown of 079.
--
-- Drop order matches the FK graph:
--   instinct_contributions (FK → instinct_company_krs)
--   instinct_company_krs   (FK → instinct_company_okrs)
--   instinct_company_okrs
--   instinct_north_star_snapshots (independent)
--
-- IF EXISTS everywhere so partial / re-run applies stay safe.
--
-- WARNING: this drops ALL company OKR + KR + contribution + north-star
-- history. There is no recovery short of a DB restore. Run only when
-- you have confirmed the feature is fully retired.

BEGIN;

DROP INDEX IF EXISTS uq_instinct_contributions_external_kr;
DROP INDEX IF EXISTS idx_instinct_contributions_user_week;
DROP INDEX IF EXISTS idx_instinct_contributions_kr_committed;
DROP TABLE IF EXISTS instinct_contributions;

DROP INDEX IF EXISTS idx_instinct_company_krs_okr;
DROP TABLE IF EXISTS instinct_company_krs;

DROP INDEX IF EXISTS idx_instinct_company_okrs_status_quarter;
DROP INDEX IF EXISTS idx_instinct_company_okrs_quarter;
DROP TABLE IF EXISTS instinct_company_okrs;

DROP INDEX IF EXISTS idx_instinct_north_star_snapshots_captured;
DROP TABLE IF EXISTS instinct_north_star_snapshots;

COMMIT;
