-- Migration 169: OGIAM decision ledger (Phase 0, shadow mode).
--
-- OGIAM is the deterministic authorization layer for AI actions. Every action
-- the assistant is about to take is evaluated by the policy decision point and
-- the decision is appended here. In Phase 0 the gate runs in monitor mode: it
-- records what it WOULD decide without blocking, so we collect an evidence
-- stream and tuning data before enforcing.
--
-- Tamper evidence: each row chains to the previous one for its workspace via
-- entry_hash = sha256(prev_hash || '|' || canonical_json(decision fields)),
-- the same primitive the compliance audit log uses. Any later edit or deletion
-- breaks the chain. The signature column is reserved for the enforce phase,
-- where each entry_hash is signed with a key custodied in Azure Key Vault
-- through the crypto-agility registry.
--
-- Ids are stored as TEXT (not UUID FKs): this is an append-only log that must
-- never reject a write because an id is not a canonical UUID. Additive and
-- idempotent.

CREATE TABLE IF NOT EXISTS ogiam_decisions (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant the decision belongs to. The per-workspace chain keys on this.
  workspace_id      TEXT         NOT NULL,
  -- Monotonic per-workspace sequence number; the chain position.
  seq               BIGINT       NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Principal: the AI identity and the human it acts for (the owner).
  principal_agent   TEXT         NOT NULL,
  on_behalf_user_id TEXT         NOT NULL,
  on_behalf_role    TEXT,

  -- The proposed action, derived from the tool the assistant was about to run.
  tool              TEXT         NOT NULL,
  capability        TEXT         NOT NULL,
  is_mutation       BOOLEAN      NOT NULL,
  surface           TEXT,
  workflow_id       TEXT,

  -- The decision.
  risk_tier         TEXT         NOT NULL,
  intended_outcome  TEXT         NOT NULL,
  effective_outcome TEXT         NOT NULL,
  enforced          BOOLEAN      NOT NULL,
  mode              TEXT         NOT NULL,
  policy_version    TEXT         NOT NULL,
  rule_id           TEXT         NOT NULL,
  reason            TEXT,
  -- True when the intended outcome would block (deny or escalate). The headline
  -- shadow-mode metric: what enforcement would have stopped.
  would_block       BOOLEAN      NOT NULL,

  -- Evidence over inputs. The raw parameters never land here: only the redacted
  -- snapshot and the hash of it.
  params_hash       TEXT         NOT NULL,
  redacted_params   TEXT,
  signals           JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Hash chain + reserved signature.
  prev_hash         TEXT         NOT NULL,
  entry_hash        TEXT         NOT NULL,
  signature         TEXT,

  -- Chain integrity: one row per (workspace, seq). A concurrent fork attempt
  -- hits this and is retried by the writer.
  CONSTRAINT uq_ogiam_decisions_workspace_seq UNIQUE (workspace_id, seq)
);

-- Hot path for the decision explorer: most recent decisions in a workspace.
CREATE INDEX IF NOT EXISTS idx_ogiam_decisions_workspace_created
  ON ogiam_decisions (workspace_id, created_at DESC);

-- "Show me what enforcement would have blocked" filter.
CREATE INDEX IF NOT EXISTS idx_ogiam_decisions_workspace_would_block
  ON ogiam_decisions (workspace_id, would_block, created_at DESC);

-- Per-principal review ("what has this user's assistant been doing").
CREATE INDEX IF NOT EXISTS idx_ogiam_decisions_user
  ON ogiam_decisions (on_behalf_user_id, created_at DESC);
