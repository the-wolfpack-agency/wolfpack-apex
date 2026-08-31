-- 235_routine_schedules
--
-- A routine that meets you, rather than one you have to remember to type.
--
-- "The day before, generate a meeting brief to go over" was the request this
-- serves. A chain that only runs when somebody types its name still needs them
-- to remember it exists on the morning they are busiest.
--
-- WHAT A SCHEDULED RUN MAY AND MAY NOT DO
--
-- It runs the chain and stops at the first step that needs a person, exactly as
-- a typed run does. It cannot send, file, or tell anybody anything, because
-- every write tool still requires confirmation and there is nobody present to
-- give it. That is the property that makes running unattended safe to offer at
-- all: the worst case is a brief nobody reads.
--
-- THE LOCAL HOUR IS STORED, NOT A UTC ONE
--
-- "Eight in the morning" is a promise about the person's morning. Stored as UTC
-- it is correct until the clocks change and then quietly an hour out for
-- everybody, in the direction nobody notices until a briefing arrives after the
-- meeting it was for. The zone is stored and the next occurrence is computed
-- against it every time. See src/lib/assistant/routines/schedule.ts.
--
-- Idempotent. Paired rollback in 235_routine_schedules.down.sql.

CREATE TABLE IF NOT EXISTS assistant_routine_schedules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  -- What to run, by the command the person types. Not a routine id: a saved
  -- routine and a built-in one are both reachable this way, and the command is
  -- the thing they will recognize in a list of their own schedules.
  command       TEXT        NOT NULL,
  cadence       TEXT        NOT NULL,
  -- 0 to 23 in the person's own zone.
  hour          INTEGER     NOT NULL,
  -- 0 is Sunday, matching Date.getDay. Null unless cadence is 'weekly'.
  weekday       INTEGER,
  time_zone     TEXT        NOT NULL,
  -- Computed on write and after every run. Indexed, because the sweep's only
  -- query is "what is due", and a scan of every schedule in the estate every
  -- fifteen minutes is a bill that grows with the customer list.
  next_run_at   TIMESTAMPTZ NOT NULL,
  last_run_at   TIMESTAMPTZ,
  -- Consecutive failures. A schedule whose routine breaks should stop trying
  -- rather than notify somebody hourly about the same broken thing.
  failures      INTEGER     NOT NULL DEFAULT 0,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_routine_schedules_cadence_chk
    CHECK (cadence IN ('daily', 'weekdays', 'weekly')),
  CONSTRAINT assistant_routine_schedules_hour_chk
    CHECK (hour BETWEEN 0 AND 23),
  CONSTRAINT assistant_routine_schedules_weekday_chk
    CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  CONSTRAINT assistant_routine_schedules_weekly_needs_day_chk
    CHECK (cadence <> 'weekly' OR weekday IS NOT NULL)
);

-- One schedule per command per person. Asking twice changes the time rather
-- than producing two runs somebody then has to work out how to stop.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_routine_schedules_one_idx
  ON assistant_routine_schedules (workspace_id, user_id, command)
  WHERE active;

-- The sweep's only read.
CREATE INDEX IF NOT EXISTS assistant_routine_schedules_due_idx
  ON assistant_routine_schedules (next_run_at)
  WHERE active;

ALTER TABLE assistant_routine_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_routine_schedules_all ON assistant_routine_schedules;
CREATE POLICY assistant_routine_schedules_all ON assistant_routine_schedules
  FOR ALL USING (true) WITH CHECK (true);
