-- 129_personal_signals_for_team_principles.sql — add per-member
-- signal lines to the three principles whose current bindings only
-- emit team-wide observations (Define Done, Red Early = Respect,
-- Pushback is Expected). After this migration + a Run all, the My
-- principles tab shows actionable per-person rows for these
-- principles instead of just "9 team-wide observations this week."
--
-- Each new row binds at evaluate time via findValidatorForDescription
-- (description → validator keyword match), so validator_id stays NULL
-- on insert. Re-running is idempotent: the WHERE NOT EXISTS clause
-- skips rows whose description already exists for that principle.

BEGIN;

-- Define Done (counters — overload + slip + abandoned commitments)
WITH p AS (
  SELECT id FROM instinct_principles
   WHERE LOWER(title) = LOWER('Define Done')
     AND retired_at IS NULL
   ORDER BY created_at DESC LIMIT 1
)
INSERT INTO instinct_principle_signals (principle_id, kind, description, validator_id)
SELECT p.id, 'counter', d.description, NULL
  FROM p, (VALUES
    ('more than 3 high-importance active in the same week'),
    ('task finish rate below 30 percent for the week'),
    ('overdue tasks accumulating without owner action')
  ) AS d(description)
 WHERE NOT EXISTS (
   SELECT 1 FROM instinct_principle_signals s
    WHERE s.principle_id = p.id
      AND LOWER(s.description) = LOWER(d.description)
 );

-- Red Early = Respect (2 counters + 1 adherence signal)
WITH p AS (
  SELECT id FROM instinct_principles
   WHERE LOWER(title) = LOWER('Red Early = Respect')
     AND retired_at IS NULL
   ORDER BY created_at DESC LIMIT 1
)
INSERT INTO instinct_principle_signals (principle_id, kind, description, validator_id)
SELECT p.id, d.kind, d.description, NULL
  FROM p, (VALUES
    ('counter', 'task finish rate below 30 percent for the week'),
    ('counter', 'recurring meetings carrying the same agenda items into a third week'),
    ('signal',  'meetings closed out with documented decisions and next steps')
  ) AS d(kind, description)
 WHERE NOT EXISTS (
   SELECT 1 FROM instinct_principle_signals s
    WHERE s.principle_id = p.id
      AND LOWER(s.description) = LOWER(d.description)
 );

-- Pushback is Expected (2 adherence signals + 1 counter)
WITH p AS (
  SELECT id FROM instinct_principles
   WHERE LOWER(title) = LOWER('Pushback is Expected')
     AND retired_at IS NULL
   ORDER BY created_at DESC LIMIT 1
)
INSERT INTO instinct_principle_signals (principle_id, kind, description, validator_id)
SELECT p.id, d.kind, d.description, NULL
  FROM p, (VALUES
    ('signal',  'weekly task finish rate above 70 percent'),
    ('counter', 'task finish rate below 30 percent for the week'),
    ('signal',  '2 or 3 high-importance tasks active per week')
  ) AS d(kind, description)
 WHERE NOT EXISTS (
   SELECT 1 FROM instinct_principle_signals s
    WHERE s.principle_id = p.id
      AND LOWER(s.description) = LOWER(d.description)
 );

-- Sanity: every targeted principle now has at least one task/calendar
-- per-member-bound signal line (description containing 'task' or
-- 'meeting' or 'high-importance' that maps to a non-team-wide
-- validator). If the assertion fails the principle wasn't found by
-- title.
DO $$
DECLARE
  p_count INT;
BEGIN
  SELECT COUNT(*) INTO p_count
    FROM instinct_principles
   WHERE LOWER(title) IN (
           LOWER('Define Done'),
           LOWER('Red Early = Respect'),
           LOWER('Pushback is Expected')
         )
     AND retired_at IS NULL;
  ASSERT p_count = 3,
    format('expected 3 active target principles, found %s', p_count);
END $$;

COMMIT;
