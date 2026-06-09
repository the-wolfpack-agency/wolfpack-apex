-- Down: remove the QR campaign deletion-lock. Idempotent.
DROP INDEX IF EXISTS idx_qr_codes_locked;
ALTER TABLE instinct_qr_codes DROP COLUMN IF EXISTS locked;
