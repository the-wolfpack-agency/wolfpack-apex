-- 164_survey_theme.sql
--
-- Adds a first-class `theme` column to instinct_surveys: the visual skin
-- the public responder (/s/<slug>) renders for client branding
-- (null/"default" = the standard Instinct look; "porsche" = the seeded
-- Weekend-with-Porsche skin). Persisted so the responder reads it instead
-- of inferring branding from the slug.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Additive only. The seed UPDATE is
-- guarded by `AND theme IS NULL` so re-running never overwrites a theme a
-- user later changed in the builder.

ALTER TABLE instinct_surveys ADD COLUMN IF NOT EXISTS theme TEXT;

UPDATE instinct_surveys
   SET theme = 'porsche'
 WHERE slug = 'weekend-porsche' AND theme IS NULL;
