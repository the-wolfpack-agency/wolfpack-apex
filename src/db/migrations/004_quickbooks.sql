-- 004_quickbooks.sql — QuickBooks Online token storage
-- Stores OAuth2 credentials for QBO integration

CREATE TABLE IF NOT EXISTS apex_qbo_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  realm_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  company_name TEXT,
  connected_by TEXT NOT NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qbo_tokens_realm ON apex_qbo_tokens(realm_id);
