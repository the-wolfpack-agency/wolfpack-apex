-- Tier 4 DB rename batch 5 / stream U3 (hr family, part 1): apex_employees → instinct_employees
--
-- Sibling migrations in this batch (parallel streams, disjoint scope):
--   055 — (other stream)
--   056 — apex_employees       → instinct_employees       (U3, this file, part 1)
--   057 — apex_hr_documents    → instinct_hr_documents    (U3, part 2, follows 056)
--   058 — (other stream)
--
-- This is the HR family — renamed together because apex_hr_documents has a
-- FOREIGN KEY on apex_hr_documents.employee_id → apex_employees(id). Postgres
-- tracks FKs by OID (not relation name), so ALTER TABLE RENAME on the parent
-- preserves the FK automatically — the constraint in the child table
-- continues to point at the (renamed) parent. No FK maintenance is required
-- here; the same applies to the FK from apex_onboarding_instances.employee_id
-- (renamed to instinct_onboarding_instances in migration 048).
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql,
-- 048_rename_onboarding_instances.sql, and 051_rename_user_memory.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_employees` becomes
--      an auto-updatable passthrough view to the renamed table. Any
--      missed code reference (SELECT, INSERT, UPDATE, DELETE) still
--      works against the OLD name so data flow never silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_employees` is the real table (migration 010). Stores the
--     master employee record (name/email/role/department/start_date/etc.).
--
--   • `instinct_employees` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_employees AS SELECT * FROM
--      apex_employees`). That alias view MUST be dropped before the
--     ALTER TABLE RENAME — otherwise `relation already exists` (42P07).
--
--   • Migration 010 defined:
--       - PRIMARY KEY on (id) — auto-renamed by ALTER TABLE RENAME.
--       - UNIQUE (email) — auto-named by Postgres as
--         `apex_employees_email_key`. Constraint names persist across
--         ALTER TABLE RENAME. We rename it explicitly for hygiene.
--       - `idx_apex_employees_status` ON (status)
--
--   • FOREIGN KEY parents: two child tables reference apex_employees(id):
--       - apex_hr_documents.employee_id (migration 011, renamed in 057
--         following this migration)
--       - apex_onboarding_instances.employee_id (migration 013, renamed
--         to instinct_onboarding_instances in migration 048)
--     Postgres FKs are tracked by OID, so renaming the parent preserves
--     both child FKs automatically — no action required.
--
--   • No aggregate views (materialized or regular) depend on apex_employees
--     beyond the migration-014 alias view. Verified by:
--       grep -rnE "FROM apex_employees|JOIN apex_employees" src/db/migrations/

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_employees still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_employees'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_employees right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_employees'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_employees' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_employees' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_employees AS SELECT * FROM instinct_employees';
    RAISE NOTICE 'Already renamed; ensured compat view apex_employees exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is the
  --         migration-014 alias view. Drop the alias, rename, create
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_employees';
    EXECUTE 'ALTER TABLE apex_employees RENAME TO instinct_employees';
    EXECUTE 'CREATE OR REPLACE VIEW apex_employees AS SELECT * FROM instinct_employees';
    RAISE NOTICE 'Renamed apex_employees → instinct_employees; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_employees RENAME TO instinct_employees';
    EXECUTE 'CREATE OR REPLACE VIEW apex_employees AS SELECT * FROM instinct_employees';
    RAISE NOTICE 'Renamed apex_employees → instinct_employees (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_employees exists as something
  --         other than a view or table. Abort.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_employees exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_employees gone AND instinct_employees is a view.
  --         Orphan-view cleanup.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_employees';
    RAISE NOTICE 'Dropped orphan view instinct_employees; apex_employees table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op.
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_employees nor instinct_employees exists; nothing to rename.';
  END IF;

  -- Row-count assertion.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_employees' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Rename secondary indexes (idempotent, guarded with IF EXISTS).
-- Migration 010 created: idx_apex_employees_status ON apex_employees(status)
ALTER INDEX IF EXISTS idx_apex_employees_status RENAME TO idx_instinct_employees_status;

-- Rename the auto-named UNIQUE constraint on email (and its backing index).
-- Postgres auto-named `UNIQUE (email)` as `apex_employees_email_key`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'apex_employees_email_key'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_employees '
         || 'RENAME CONSTRAINT apex_employees_email_key '
         || 'TO instinct_employees_email_key';
    RAISE NOTICE 'Renamed UNIQUE constraint apex_employees_email_key.';
  END IF;
END $$;

-- Fallback index rename for any state where the index lingered without the constraint.
ALTER INDEX IF EXISTS apex_employees_email_key
  RENAME TO instinct_employees_email_key;

-- Rename the auto-named PRIMARY KEY constraint for hygiene
-- (`apex_employees_pkey` → `instinct_employees_pkey`).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'apex_employees_pkey'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_employees '
         || 'RENAME CONSTRAINT apex_employees_pkey '
         || 'TO instinct_employees_pkey';
    RAISE NOTICE 'Renamed PRIMARY KEY constraint apex_employees_pkey.';
  END IF;
END $$;

ALTER INDEX IF EXISTS apex_employees_pkey
  RENAME TO instinct_employees_pkey;

-- =========================================================================
-- Compat-view updatability assertion.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_employees'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_employees';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_employees is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_employees is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_employees is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
