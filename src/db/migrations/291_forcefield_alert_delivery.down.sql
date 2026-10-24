-- Rollback for 291_forcefield_alert_delivery.sql (ops-only; never run by deploy).
DROP INDEX IF EXISTS idx_ff_web_alerts_delivered;
ALTER TABLE instinct_forcefield_web_alerts
  DROP COLUMN IF EXISTS site,
  DROP COLUMN IF EXISTS attack_class,
  DROP COLUMN IF EXISTS window_start,
  DROP COLUMN IF EXISTS delivery_status,
  DROP COLUMN IF EXISTS delivery_detail,
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS dispatched_at;
