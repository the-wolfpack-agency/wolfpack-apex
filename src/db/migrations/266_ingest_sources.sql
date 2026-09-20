-- Signed telemetry ingest (gap #1). The ingest endpoint is otherwise guarded by
-- a single shared token: leak it and an attacker can inject forged events that
-- poison every downstream verdict. This registers the FORWARDERS we trust by
-- their asymmetric public key (ES256 JWK); when signing is enforced, each ingest
-- request must carry a signature we verify against the source's key, so a leaked
-- shared token alone is not enough.
CREATE TABLE IF NOT EXISTS instinct_ingest_sources (
  source_id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL DEFAULT 'es256',
  public_key JSONB NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ingest_source_algo_chk CHECK (algorithm IN ('es256'))
);
