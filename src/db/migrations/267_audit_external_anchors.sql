-- External audit anchoring (gap #7). The hash chain is tamper-EVIDENT but lives
-- in the same Postgres: a DB-admin compromise could rewrite rows and recompute
-- the chain. This records each chain HEAD we published to an EXTERNAL witness
-- (a notary / transparency log / customer endpoint). The security comes from the
-- external copy; this table lets us verify the live DB against what we published
-- and show the anchor trail. A mismatch at an anchored seq means the DB was
-- rewritten after we published it - detectable even with DB admin access.
CREATE TABLE IF NOT EXISTS instinct_audit_external_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGINT NOT NULL,
  entry_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  receipt TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_anchor_seq ON instinct_audit_external_anchors (seq DESC);
