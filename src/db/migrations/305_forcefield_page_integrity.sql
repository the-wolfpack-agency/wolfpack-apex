-- 305_forcefield_page_integrity.sql
--
-- Page integrity (browser-side tamper reports). A protected site's pages carry a
-- report-only Content Security Policy; each visitor's browser reports a script,
-- frame, connection or form target the page loaded from an origin the policy
-- does not name. The site forwards each report to Instinct, which keeps one row
-- per (scope, directive, blocked origin, session, page, day), counting repeats:
--   scope           "tenant:<uuid>" or "site:<label>" (the agent-policy shape)
--   directive       script-src | frame-src | connect-src | form-action
--   blocked_origin  scheme + host (+ port) only, or "data" / "blob"; never a
--                   full URL, path or query, and never visitor data
--   sig             the visitor's hourly session signature (not an identity)
--   page            the page path only
-- Distinct sessions and pages per origin are what separate an injected script
-- (every visitor) from one person's browser extension (one visitor).
-- Safe on live data: a new table only. Idempotent.

CREATE TABLE IF NOT EXISTS forcefield_page_integrity (
  scope           TEXT NOT NULL,
  directive       TEXT NOT NULL,
  blocked_origin  TEXT NOT NULL,
  sig             TEXT NOT NULL,
  page            TEXT NOT NULL,
  day             DATE NOT NULL,
  reports         INTEGER NOT NULL DEFAULT 1,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, directive, blocked_origin, sig, page, day),
  CONSTRAINT forcefield_page_integrity_scope_shape CHECK (scope ~ '^(tenant:[0-9a-f-]{36}|site:[a-z0-9._-]{1,64})$'),
  CONSTRAINT forcefield_page_integrity_directive CHECK (directive IN ('script-src', 'frame-src', 'connect-src', 'form-action'))
);

CREATE INDEX IF NOT EXISTS idx_forcefield_page_integrity_scope_seen ON forcefield_page_integrity (scope, first_seen);
