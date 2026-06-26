-- Migration 185 — audit-chain re-anchor points.
--
-- The audit log (migration 019) is append-only and hash-chained: each row's
-- entry_hash chains off the previous row's entry_hash. A legitimate break in
-- that chain can occur for a KNOWN, NON-TAMPER reason — most notably the
-- READ-COMMITTED write-path race fixed in this same change set, which forked
-- the chain at seq 509 (two concurrent appends both read seq 508 as latest).
--
-- We MUST NOT rewrite history to "fix" such a break: rewriting rows would
-- destroy the tamper-evidence the whole table exists to provide (and is blocked
-- by the append-only trigger anyway). Instead we RE-ANCHOR: an admin records an
-- acknowledged break at a specific seq. verifyChain then treats a
-- prev_hash_mismatch AT an anchored seq as an expected new-segment genesis, not
-- a tamper signal. Any UNanchored mismatch (or any content / entry_hash
-- mismatch) still fails verification — real tampering is still caught.
--
-- This table is itself append-only-ish (we only INSERT acknowledged breaks) but
-- is deliberately a plain table, NOT under the immutability trigger: an operator
-- may need to correct a mistaken acknowledgement, and the re-anchor action is
-- ITSELF audited in instinct_audit_log (hash-chained) for tamper evidence.
--
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_audit_chain_anchors (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             BIGINT       NOT NULL,
  reason          TEXT         NOT NULL,
  acknowledged_by TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_audit_chain_anchor_seq UNIQUE (seq)
);

-- verifyChain loads the anchored seqs on every run; index the lookup.
CREATE INDEX IF NOT EXISTS idx_audit_chain_anchors_seq
  ON instinct_audit_chain_anchors (seq);

COMMIT;
