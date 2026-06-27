-- Reverse of 192_scan_intake_user_ids_to_text.sql. Narrows TEXT back to UUID.
-- WARNING: the USING ::uuid cast REJECTS rows whose values aren't valid
-- UUID literals (e.g. "demo-cto" / "tm_..." / "default"). If real
-- non-UUID data has been written this rollback fails by design - that is
-- exactly the data the widening protected.

BEGIN;

-- Drop the workspace defaults this migration set so the column reverts
-- cleanly to its pre-192 (no-default) UUID shape.
DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'instinct_receipt_scans',
    'instinct_invoices',
    'instinct_hr_scanned_documents'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = tbl
          AND column_name = 'workspace_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id DROP DEFAULT', tbl);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  pairs   TEXT[][] := ARRAY[
    ARRAY['instinct_user_feedback',          'workflow_id'],
    ARRAY['instinct_receipt_scans',          'workspace_id'],
    ARRAY['instinct_receipt_scans',          'uploaded_by'],
    ARRAY['instinct_invoices',               'workspace_id'],
    ARRAY['instinct_invoices',               'uploaded_by'],
    ARRAY['instinct_invoices',               'approved_by'],
    ARRAY['instinct_hr_scanned_documents',   'workspace_id'],
    ARRAY['instinct_hr_scanned_documents',   'uploaded_by'],
    ARRAY['instinct_hr_scanned_documents',   'team_member_id'],
    ARRAY['instinct_hr_scanned_documents',   'verified_by'],
    ARRAY['instinct_document_recognitions',  'uploaded_by']
  ];
  tbl       TEXT;
  col       TEXT;
  col_type  TEXT;
  i         INT;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    tbl := pairs[i][1];
    col := pairs[i][2];

    SELECT data_type INTO col_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = tbl
        AND column_name = col;

    IF col_type = 'text' THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE UUID USING %I::uuid',
        tbl, col, col
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
