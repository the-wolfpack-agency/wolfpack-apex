-- Down for 162_survey_analytics. Idempotent; touches only its own objects.
DROP TABLE IF EXISTS instinct_survey_views;
ALTER TABLE instinct_survey_responses DROP COLUMN IF EXISTS duration_ms;
ALTER TABLE instinct_survey_responses DROP COLUMN IF EXISTS device;
ALTER TABLE instinct_survey_responses DROP COLUMN IF EXISTS country;
ALTER TABLE instinct_survey_responses DROP COLUMN IF EXISTS referrer;
