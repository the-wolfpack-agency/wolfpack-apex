-- 038_client_assets.down.sql — reversible teardown of 038.
--
-- Drop order matches dependency graph: blobs (FK on assets) → assets.
-- IF EXISTS everywhere so partial applies are safe to re-run.
--
-- WARNING: this drops ALL uploaded client assets. There is no recovery
-- short of a DB restore. Run only when you have confirmed the assets
-- library is no longer needed.

DROP TABLE IF EXISTS instinct_client_asset_blobs;

DROP INDEX IF EXISTS instinct_client_assets_last_used_idx;
DROP INDEX IF EXISTS instinct_client_assets_kind_idx;
DROP INDEX IF EXISTS instinct_client_assets_client_idx;
DROP TABLE IF EXISTS instinct_client_assets;
