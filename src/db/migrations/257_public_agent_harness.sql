-- Public agent harness - the "point your agent at our test site and watch it
-- behave" tool. A developer starts a session, points their agent at an
-- unguessable sandbox URL, and gets back an honest behavioral reading (journey +
-- scaffolding + operator dossier) reusing the same engine that runs on live
-- traffic. PUBLIC and unauthenticated by design, so the schema is deliberately
-- minimal and carries NO PII: no IP, no raw User-Agent, no request bodies. A
-- session is an opaque token; a hit is only (relative path, method, status, the
-- structural event it maps to, when). The reading is rebuilt from these rows.

CREATE TABLE IF NOT EXISTS instinct_harness_sessions (
  id          TEXT        PRIMARY KEY,          -- opaque, unguessable session token
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,             -- short TTL; expired sessions read as gone
  goal        TEXT,                             -- optional goal the developer set for their agent
  agent_label TEXT,                             -- optional human label ("gpt-5 + langchain")
  hit_count   INTEGER     NOT NULL DEFAULT 0,   -- hard-capped to bound public storage
  operator_key      TEXT,                         -- durable operator fingerprint, set once the run is captured
  sighting_recorded BOOLEAN NOT NULL DEFAULT false -- learning capture is idempotent: one sighting per session
);

CREATE TABLE IF NOT EXISTS instinct_harness_hits (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT        NOT NULL REFERENCES instinct_harness_sessions(id) ON DELETE CASCADE,
  path       TEXT        NOT NULL,              -- path RELATIVE to the sandbox base ("/", "/pricing", "/_trap/records")
  method     TEXT        NOT NULL DEFAULT 'GET',
  status     INTEGER     NOT NULL DEFAULT 200,
  event_type TEXT,                              -- the structural signal this hit maps to, or NULL for a plain page view
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_harness_hits_session_seen
  ON instinct_harness_hits (session_id, seen_at ASC);
CREATE INDEX IF NOT EXISTS idx_harness_sessions_expires
  ON instinct_harness_sessions (expires_at);
