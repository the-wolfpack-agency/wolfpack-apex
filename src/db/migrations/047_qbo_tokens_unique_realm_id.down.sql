-- 047_qbo_tokens_unique_realm_id.down.sql — reverse of 047
--
-- Drops the UNIQUE constraint added in 047. Idempotent.
--
-- Post-rollback, src/lib/quickbooks.ts::storeTokens's
-- `ON CONFLICT (realm_id) DO UPDATE` will fail at runtime on any
-- second upsert for the same realm (this is the latent bug 047 fixes;
-- rolling back intentionally re-exposes it). Operators applying this
-- down migration are responsible for freezing any code path that
-- calls storeTokens a second time for a realm, or for rolling the
-- lib back alongside.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_qbo_tokens_realm_id_unique'
      AND conrelid = 'instinct_qbo_tokens'::regclass
  ) THEN
    ALTER TABLE instinct_qbo_tokens
      DROP CONSTRAINT instinct_qbo_tokens_realm_id_unique;
    RAISE NOTICE 'Dropped UNIQUE constraint instinct_qbo_tokens_realm_id_unique.';
  ELSE
    RAISE NOTICE 'Constraint instinct_qbo_tokens_realm_id_unique not present; nothing to drop.';
  END IF;
END $$;

COMMIT;
