-- Migration 170: OGIAM chain notarization.
--
-- Two additions that turn the tamper-evident decision chain into a
-- non-repudiable one:
--
--   1. ogiam_decisions.hash_payload: the exact canonical bytes the entry_hash
--      was computed over, stored verbatim. Verification recomputes the hash from
--      this rather than reconstructing it from typed columns (a timestamptz, for
--      example, would not round-trip to the identical string that was hashed).
--      Additive and nullable, so rows written before this migration simply read
--      back as "not independently verifiable" rather than breaking.
--
--   2. ogiam_checkpoints: a signed chain head, like a Certificate Transparency
--      signed tree head. A scheduled job signs the latest entry_hash per
--      workspace, so one signature anchors every decision up to through_seq
--      instead of a signature per action. The signature is produced by an Azure
--      Key Vault asymmetric key the application cannot exfiltrate, so a database
--      rewrite cannot reproduce a valid checkpoint. The signature column is
--      nullable: when Key Vault is not configured the chain stays tamper-evident
--      and the checkpoint records that it was not notarized.
--
-- Additive and idempotent.

ALTER TABLE ogiam_decisions
  ADD COLUMN IF NOT EXISTS hash_payload TEXT;

CREATE TABLE IF NOT EXISTS ogiam_checkpoints (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT         NOT NULL,
  -- The chain is signed up to and including this per-workspace sequence number.
  through_seq   BIGINT       NOT NULL,
  -- entry_hash of the decision row at through_seq (the chain head at sign time).
  head_hash     TEXT         NOT NULL,
  -- The exact canonical bytes that were signed (workspace, through_seq, head).
  payload       TEXT         NOT NULL,
  -- Signing algorithm and key identity, so verification can dispatch.
  algorithm     TEXT         NOT NULL,
  key_id        TEXT         NOT NULL,
  -- base64 signature. NULL when notarization is not configured (chain stays
  -- tamper-evident, just not externally non-repudiable).
  signature     TEXT,
  signed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ogiam_checkpoints_workspace_seq UNIQUE (workspace_id, through_seq)
);

CREATE INDEX IF NOT EXISTS idx_ogiam_checkpoints_workspace_seq
  ON ogiam_checkpoints (workspace_id, through_seq DESC);
