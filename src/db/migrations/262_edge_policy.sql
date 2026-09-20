-- Inline edge enforcement: per-workspace mode for real-time agent decisions.
--
-- Forcefield is watch-first by default (observe, classify, triage). Inline edge
-- mode lets an edge (a reverse proxy / the site's middleware) call the decision
-- endpoint synchronously per request and act on an allow / challenge / block
-- verdict BEFORE serving. Mode governs whether that verdict is enforced or just
-- recorded: "monitor" is shadow mode (decide + record, never block), "enforce"
-- gates for real. Mirrors the OGIAM enforcement-mode posture (intended vs
-- effective). No row = monitor (safe default: never block until switched on).
CREATE TABLE IF NOT EXISTS instinct_edge_policy (
  workspace_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'monitor',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT edge_policy_mode_chk CHECK (mode IN ('monitor', 'enforce'))
);
