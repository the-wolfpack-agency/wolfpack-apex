-- What AI cost BEFORE the router, so the saving is a subtraction and not a claim.
--
-- The router already records what every call actually cost and what the same
-- call would have cost at the tier the call site used to send unconditionally.
-- That answers "is the router cheaper than not routing", which is a question
-- about two ways of using the router.
--
-- The question somebody actually asks is different: I was paying X a month
-- before any of this existed, what am I paying now. Nothing in this system
-- knows X, because X is an invoice from a vendor, so it has to be recorded
-- rather than derived.
--
-- ONE ROW PER MONTH PER WORKSPACE. Amounts are in USD cents to avoid the
-- rounding that makes two reports of the same figure disagree.
CREATE TABLE IF NOT EXISTS ai_spend_baseline (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT        NOT NULL,
  -- First day of the month the amount covers. A date rather than a string so
  -- ordering and range queries are the database's problem, not a parser's.
  period_month  DATE        NOT NULL,
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents >= 0),
  -- What the figure IS. An invoiced amount and an assumed recurring rate are
  -- different kinds of fact, and a report that presents an assumption as an
  -- invoice is the reason to keep them apart in the column rather than in
  -- somebody's memory of how the row got there.
  kind          TEXT        NOT NULL CHECK (kind IN ('invoiced', 'recurring_estimate')),
  -- Free text: which vendor, which plan, what it covered. Shown next to the
  -- number, because a total with no provenance gets argued with.
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One figure per workspace per month. Re-recording a month corrects it rather
-- than adding a second, quietly doubling the baseline.
CREATE UNIQUE INDEX IF NOT EXISTS ai_spend_baseline_workspace_month
  ON ai_spend_baseline (workspace_id, period_month);

CREATE INDEX IF NOT EXISTS ai_spend_baseline_month
  ON ai_spend_baseline (period_month DESC);
