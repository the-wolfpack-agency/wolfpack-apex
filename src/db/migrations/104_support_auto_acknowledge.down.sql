-- 104_support_auto_acknowledge.down.sql — reversible teardown of 104.
--
-- Drops the FK then the five auto-ack columns.
-- IF EXISTS everywhere so the down migration is safe to re-run.
--
-- WARNING: this drops the per-ticket auto-ack audit trail (when, by which
-- pattern, what Graph message id). After a down + up cycle the auto-ack
-- learning signal is gone for already-acknowledged tickets. The original
-- inbound ticket + sent draft is preserved.

BEGIN;

ALTER TABLE instinct_support_tickets
  DROP CONSTRAINT IF EXISTS instinct_support_tickets_auto_ack_pattern_fk;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS auto_acknowledge_pattern_id;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS auto_acknowledge_message_id;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS auto_acknowledged_at;

ALTER TABLE instinct_support_patterns
  DROP COLUMN IF EXISTS auto_acknowledge_template;

ALTER TABLE instinct_support_patterns
  DROP COLUMN IF EXISTS auto_acknowledge_enabled;

COMMIT;
