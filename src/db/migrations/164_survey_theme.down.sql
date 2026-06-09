-- Down for 164_survey_theme.
-- NOTE: this repo's migrate runner globs ALL *.sql (incl. .down.sql) and
-- runs them forward, sorted; ".down.sql" sorts BEFORE ".sql", so this runs
-- first and the up immediately re-adds the column. Keep it idempotent and
-- scoped to its own column only.
ALTER TABLE instinct_surveys DROP COLUMN IF EXISTS theme;
