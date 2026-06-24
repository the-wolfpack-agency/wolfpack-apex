-- 177_ogiam_immutability_triggers.sql
--
-- Tamper-evidence at the DATABASE layer for the OGIAM governance ledger.
--
-- ogiam_decisions (169) and ogiam_action_outcomes (176) are append-only by
-- design: recordDecision()/recordActionOutcome() only ever INSERT, the seq is
-- hash-chained, and (workspace_id, seq) is unique. But until now that was an
-- application-layer promise only. instinct_audit_log (019) is additionally
-- defended by a BEFORE UPDATE OR DELETE trigger that raises; the OGIAM tables
-- had no equivalent, so a direct client (or compromised connection) could
-- silently rewrite or delete a decision and break the audit trail.
--
-- This migration installs the same immutability guard on both OGIAM tables, so
-- the governance record an agent is judged against cannot be altered after the
-- fact. Idempotent: CREATE OR REPLACE the function, DROP TRIGGER IF EXISTS then
-- CREATE. Safe to re-run.

CREATE OR REPLACE FUNCTION ogiam_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % denied', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ogiam_decisions_no_update ON ogiam_decisions;
CREATE TRIGGER ogiam_decisions_no_update
  BEFORE UPDATE OR DELETE ON ogiam_decisions
  FOR EACH ROW EXECUTE FUNCTION ogiam_ledger_immutable();

DROP TRIGGER IF EXISTS ogiam_action_outcomes_no_update ON ogiam_action_outcomes;
CREATE TRIGGER ogiam_action_outcomes_no_update
  BEFORE UPDATE OR DELETE ON ogiam_action_outcomes
  FOR EACH ROW EXECUTE FUNCTION ogiam_ledger_immutable();
