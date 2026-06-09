-- Down for 163 seed: intentionally a no-op.
-- Down files run FORWARD in this repo's migrate runner, so a DELETE here
-- would race the seed. The seed is idempotent (ON CONFLICT DO NOTHING);
-- removing it is a manual, deliberate op, never an automatic migration.
SELECT 1;
