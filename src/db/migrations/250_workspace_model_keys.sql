-- Bring-your-own model keys.
--
-- A customer plugs in their OWN provider API key so their model authors,
-- repairs and judges code, while our deterministic gate governs it unchanged -
-- the model-agnostic pitch. The key is encrypted at rest (AES-256-GCM via
-- src/lib/crypto/secret-storage); this column never holds plaintext. Only a
-- last-4 hint is ever displayed, and the decrypted value is read solely by the
-- router to authenticate the model - never returned from any list surface.
--
-- One key per (workspace, provider); re-adding rotates it in place.

CREATE TABLE IF NOT EXISTS instinct_workspace_model_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT        NOT NULL,
  provider      TEXT        NOT NULL,
  label         TEXT,
  encrypted_key TEXT        NOT NULL,
  key_hint      TEXT        NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_workspace_model_keys_provider_chk
    CHECK (provider IN ('anthropic', 'openai', 'azure', 'foundry'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_model_keys_ws_provider
  ON instinct_workspace_model_keys (workspace_id, provider);
