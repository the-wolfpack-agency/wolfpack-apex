-- Migration 152 — audit log for every Azure Cognitive Services call.
--
-- Tied to the "no data lost / tie into learning mechanism" directive:
-- every Form Recognizer / Computer Vision call records who triggered
-- it, what service + endpoint, the latency, byte-cost-estimate, and
-- the outcome. The free-tier quota is per-month per-meter; this table
-- lets us forecast spend BEFORE the meter rolls into paid territory.
--
-- Two consumers:
--   - vision-ocr.ts (kind=image extraction in brain pipeline)
--   - form-recognizer.ts (receipt scanning in /job-codes UI)
-- Both write through `recordAzureCall` in lib/azure/audit.ts so the
-- schema stays a single source of truth.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_azure_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  /* service column distinguishes free-tier meters; we forecast spend
     per service so we can warn before any one meter exhausts. */
  service         TEXT NOT NULL CHECK (service IN ('computer_vision', 'form_recognizer')),
  /* operation = the specific API surface within the service so the
     monthly free-tier transaction counts stay accurate. Reasonable
     values today: 'read', 'prebuilt-receipt', 'prebuilt-invoice'. */
  operation       TEXT NOT NULL,
  /* triggered_by = the Instinct user who caused the call. NULL for
     background reconciler runs (e.g. backfilling kind=image rows). */
  triggered_by    UUID,
  /* document_id = optional FK to brain_documents when the call was
     OCRing a brain image. Lets us join calls back to the documents
     they enriched without an extra lookup. */
  document_id     UUID,
  status          TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'rate_limited', 'not_configured')),
  http_status     INT,
  latency_ms      INT,
  /* request_bytes / response_chars are the inputs to a forward-
     looking cost forecast. Cognitive Services pricing is per-
     transaction not per-byte, but bigger requests correlate with
     higher likelihood of hitting the 4 MB limit. */
  request_bytes   INT,
  response_chars  INT,
  error_code      TEXT,
  error_detail    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Index on (service, created_at) covers the per-service-per-month
   spend-forecast query — date_trunc isn't immutable so we can't index
   on it directly; the planner uses this index for range scans. */
CREATE INDEX IF NOT EXISTS ix_instinct_azure_calls_service_created
  ON instinct_azure_calls (service, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_instinct_azure_calls_doc
  ON instinct_azure_calls (document_id) WHERE document_id IS NOT NULL;

COMMIT;
