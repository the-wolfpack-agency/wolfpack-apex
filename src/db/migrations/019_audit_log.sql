-- Migration 019: Compliance-grade audit log (append-only, hash-chained)
--
-- Separate from analytics events. Analytics is observability; this is audit:
-- who did what, when, from where, prior vs new state, tamper-evident.
--
-- Requirements satisfied:
--   - Append-only (UPDATE + DELETE blocked at DB layer via trigger)
--   - Monotonic sequence (BIGSERIAL) for hash-chain ordering
--   - Hash chain: entry_hash = sha256(prev_hash || canonical_json(row))
--   - PII redaction enforced in application code before insert
--   - Indexes for actor/resource/time queries
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS instinct_audit_log (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            BIGSERIAL    NOT NULL,
  ts             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_user_id  TEXT         NOT NULL,
  actor_role     TEXT         NOT NULL,
  action         TEXT         NOT NULL,
  resource_type  TEXT         NOT NULL,
  resource_id    TEXT,
  before_state   JSONB,
  after_state    JSONB,
  ip_address     INET,
  user_agent     TEXT,
  request_id     TEXT,
  prev_hash      TEXT,
  entry_hash     TEXT         NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq
  ON instinct_audit_log (seq);

CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON instinct_audit_log (actor_user_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_resource
  ON instinct_audit_log (resource_type, resource_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_ts
  ON instinct_audit_log (ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_action
  ON instinct_audit_log (action, ts DESC);

-- Append-only enforcement: raise exception on any UPDATE or DELETE.
-- Enforced at DB layer, not just policy. Superuser can disable trigger for
-- emergency ops, but the enforcement survives code-level bypass attempts.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'instinct_audit_log is append-only — % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON instinct_audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON instinct_audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
