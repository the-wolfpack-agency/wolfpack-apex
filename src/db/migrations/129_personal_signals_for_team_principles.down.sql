-- 129 down: remove the signal rows added by the up migration.
BEGIN;

DELETE FROM instinct_principle_signals s
 USING instinct_principles p
 WHERE s.principle_id = p.id
   AND p.retired_at IS NULL
   AND (
     (LOWER(p.title) = LOWER('Define Done')
       AND LOWER(s.description) IN (
         LOWER('more than 3 high-importance active in the same week'),
         LOWER('task finish rate below 30 percent for the week'),
         LOWER('overdue tasks accumulating without owner action')
       ))
     OR (LOWER(p.title) = LOWER('Red Early = Respect')
       AND LOWER(s.description) IN (
         LOWER('task finish rate below 30 percent for the week'),
         LOWER('recurring meetings carrying the same agenda items into a third week'),
         LOWER('meetings closed out with documented decisions and next steps')
       ))
     OR (LOWER(p.title) = LOWER('Pushback is Expected')
       AND LOWER(s.description) IN (
         LOWER('weekly task finish rate above 70 percent'),
         LOWER('task finish rate below 30 percent for the week'),
         LOWER('2 or 3 high-importance tasks active per week')
       ))
   );

COMMIT;
