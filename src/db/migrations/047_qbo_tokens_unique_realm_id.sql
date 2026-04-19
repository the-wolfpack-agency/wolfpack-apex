-- 047_qbo_tokens_unique_realm_id.sql — Tier 4 batch 3, stream T4
--
-- LATENT BUG FIX (surfaced by the S2 migration 042 rename audit):
--
-- `src/lib/quickbooks.ts::storeTokens` has always issued:
--   INSERT INTO instinct_qbo_tokens (realm_id, ...)
--   VALUES (...)
--   ON CONFLICT (realm_id) DO UPDATE SET ...
--
-- But the base table — originally created by migration 004 as
-- `apex_qbo_tokens`, renamed by migration 042 to `instinct_qbo_tokens` —
-- declares `realm_id TEXT NOT NULL` with only a plain index, NOT a
-- UNIQUE constraint. Postgres's `ON CONFLICT (col)` requires a unique
-- index / unique constraint / primary key on `col` to identify the
-- conflict target; without one it raises:
--
--   ERROR: there is no unique or exclusion constraint matching the
--   ON CONFLICT specification
--
-- No prod incident has fired yet because every QBO connection has only
-- ever inserted its first token row (re-auth paths take a different
-- code path, or there is only one connected account in practice).
-- The next second-INSERT for the same realm would fail at runtime.
--
-- This migration adds the missing UNIQUE CONSTRAINT so ON CONFLICT
-- resolves correctly. We use ADD CONSTRAINT (not just CREATE UNIQUE
-- INDEX) because a named constraint is what pg_constraint exposes
-- cleanly for idempotent existence checks and for ON CONFLICT's
-- constraint-name form.
--
-- Semantics chosen: ONE ROW PER realm_id.
--
--   Rationale — the lib's read path (`getValidToken`, `getConnectionStatus`)
--   already does `ORDER BY updated_at DESC LIMIT 1` and never filters
--   by user, so in practice the system already behaves as one active
--   QBO token per realm. The ON CONFLICT (realm_id) DO UPDATE path
--   upserts the newest access_token / refresh_token onto the existing
--   row for that realm. Enforcing that invariant at the DB layer
--   matches the lib's observed intent.
--
--   If future product direction needs one-row-per-(realm, user),
--   swap this for UNIQUE (realm_id, connected_by). But until then,
--   one-per-realm is what the library expects.
--
-- Defensive pattern per feedback_migration_safety.md:
--   - Pre-check pg_constraint for idempotency.
--   - Pre-check for duplicate realm_id rows; RAISE EXCEPTION with an
--     actionable message instead of letting ALTER TABLE fail mid-deploy.
--   - BEGIN/COMMIT wrapped; fully reversible via the paired .down.sql.

BEGIN;

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  -- Idempotent: only add the constraint if it doesn't already exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_qbo_tokens_realm_id_unique'
      AND conrelid = 'instinct_qbo_tokens'::regclass
  ) THEN
    -- Defensive: if any prior rows share a realm_id (possible if a
    -- second connect attempt snuck through via raw INSERT somewhere,
    -- or via a backfill), ALTER TABLE ADD UNIQUE would error out
    -- mid-transaction with a cryptic message. Detect + surface a
    -- clear operator-facing error so they can dedupe (keep newest
    -- updated_at, drop older rows) before re-running this migration.
    SELECT COUNT(*) INTO dup_count FROM (
      SELECT realm_id
        FROM instinct_qbo_tokens
        GROUP BY realm_id
        HAVING COUNT(*) > 1
    ) AS d;

    IF dup_count > 0 THEN
      RAISE EXCEPTION
        'Cannot add UNIQUE on instinct_qbo_tokens.realm_id: % realm_id value(s) have duplicate rows. Dedupe (keep MAX(updated_at) per realm_id, DELETE the rest) before re-running migration 047.',
        dup_count;
    END IF;

    ALTER TABLE instinct_qbo_tokens
      ADD CONSTRAINT instinct_qbo_tokens_realm_id_unique UNIQUE (realm_id);

    RAISE NOTICE 'Added UNIQUE constraint instinct_qbo_tokens_realm_id_unique on instinct_qbo_tokens(realm_id).';
  ELSE
    RAISE NOTICE 'Constraint instinct_qbo_tokens_realm_id_unique already exists; skipping.';
  END IF;
END $$;

-- =========================================================================
-- Post-condition assertion: ON CONFLICT (realm_id) must now resolve.
--
-- This doesn't execute an INSERT — it just verifies pg_constraint
-- sees a UNIQUE or PRIMARY KEY on (realm_id) for instinct_qbo_tokens,
-- which is what Postgres's ON CONFLICT inference actually consults.
-- If this assertion passes, src/lib/quickbooks.ts::storeTokens will
-- no longer raise "there is no unique or exclusion constraint matching
-- the ON CONFLICT specification" on a second upsert.
-- =========================================================================
DO $$
DECLARE
  unique_on_realm_id_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'instinct_qbo_tokens'::regclass
        AND c.contype IN ('u', 'p')   -- UNIQUE or PRIMARY KEY
        AND a.attname = 'realm_id'
        AND array_length(c.conkey, 1) = 1  -- single-column, not composite
  ) INTO unique_on_realm_id_exists;

  IF NOT unique_on_realm_id_exists THEN
    RAISE EXCEPTION
      'Post-condition failed: instinct_qbo_tokens has no single-column UNIQUE/PRIMARY KEY on realm_id. ON CONFLICT (realm_id) in src/lib/quickbooks.ts will still fail at runtime. Aborting.';
  END IF;

  RAISE NOTICE 'Post-condition OK: single-column UNIQUE on instinct_qbo_tokens.realm_id is in place; ON CONFLICT (realm_id) will resolve.';
END $$;

COMMIT;
