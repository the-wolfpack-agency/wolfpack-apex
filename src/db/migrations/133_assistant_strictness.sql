-- Migration 133 — Per-workspace assistant strictness
--
-- Enterprise tenants want "strict" answer-quality mode: any warn-level
-- flag (unknown name, stale source, missing citation) becomes a reject
-- and the assistant returns the deterministic low-confidence message
-- instead of letting the LLM speak with a caveat.
--
-- Self-serve / internal tenants stay on "permissive" (the default): warn
-- flags pre-pend a notice but the LLM answer is still returned. Faster
-- to iterate, more useful while the team is teaching the assistant.
--
-- Default is 'permissive' so existing deployments stay unchanged on
-- migrate. Flip to 'strict' per-client at provisioning time.

BEGIN;

ALTER TABLE instinct_workspace
  ADD COLUMN IF NOT EXISTS assistant_strictness TEXT
    NOT NULL DEFAULT 'permissive'
    CHECK (assistant_strictness IN ('permissive', 'strict'));

COMMENT ON COLUMN instinct_workspace.assistant_strictness IS
  'permissive: warn flags pre-pend a notice; strict: warn flags become reject.';

COMMIT;
