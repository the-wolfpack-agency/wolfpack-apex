-- Down: remove the survey builder. Idempotent.
DROP TABLE IF EXISTS instinct_survey_responses;
DROP TABLE IF EXISTS instinct_surveys;
