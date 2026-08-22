-- 234_saved_routines
--
-- A chain somebody kept.
--
-- The product could describe a person's day and offer to chain it, and then
-- the offer went nowhere: the draft was built, rendered, and dropped. This is
-- where it lands when they say yes.
--
-- OWNED BY A PERSON, NOT BY A WORKSPACE
--
-- A routine is somebody's own morning. Two people on the same team have
-- different Mondays, and a shared list would fill with chains that belong to
-- somebody else. workspace_id is carried for tenancy, user_id for ownership,
-- and the lookup keys on both.
--
-- THE STEPS ARE JSON ON PURPOSE
--
-- A step is a small closed shape defined in TypeScript (tool, model, human)
-- and validated before it runs. Normalising it into tables would spread one
-- definition across two places that then drift, and would make a routine
-- unreadable without a join. The shape is validated on the way IN and again
-- on the way OUT, because a row written by an older deploy is a real case.
--
-- Idempotent. Paired rollback in 234_saved_routines.down.sql.

CREATE TABLE IF NOT EXISTS assistant_saved_routines (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT        NOT NULL,
  user_id      TEXT        NOT NULL,
  -- What they type to run it, lowercased. Unique per person so "run my day"
  -- means one thing for them and something else for a colleague.
  command      TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  steps        JSONB       NOT NULL,
  -- Where it came from. A chain the product proposed and a chain somebody
  -- wrote are worth telling apart when asking whether the proposals are any
  -- good.
  origin       TEXT        NOT NULL DEFAULT 'proposed',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete. A routine somebody removes is evidence about which proposals
  -- did not survive contact with a real week, and dropping the row throws that
  -- away.
  active       BOOLEAN     NOT NULL DEFAULT true,
  CONSTRAINT assistant_saved_routines_origin_chk
    CHECK (origin IN ('proposed', 'authored'))
);

-- One command per person. A second save of the same command replaces the
-- first rather than creating a silent duplicate that shadows it forever.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_saved_routines_command_idx
  ON assistant_saved_routines (workspace_id, user_id, command)
  WHERE active;

CREATE INDEX IF NOT EXISTS assistant_saved_routines_owner_idx
  ON assistant_saved_routines (workspace_id, user_id, created_at DESC);

ALTER TABLE assistant_saved_routines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_saved_routines_all ON assistant_saved_routines;
CREATE POLICY assistant_saved_routines_all ON assistant_saved_routines
  FOR ALL USING (true) WITH CHECK (true);
