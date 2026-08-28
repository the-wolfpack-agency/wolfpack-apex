-- Where to send an external agent its work.
--
-- We could authorize an external agent (it asks, we answer) and, since
-- /api/gate/complete, run its reasoning through our router. Both are things
-- the agent initiates. Neither lets us hand it a task.
--
-- Delegation needs one fact we did not store: the address its operator wants
-- work delivered to. It belongs on the key rather than in a new table, because
-- the key already IS the external agent's identity here: it carries the
-- workspace, the agent name and the capability allowlist, and splitting the
-- endpoint away from those would let one be revoked while the other kept
-- working.
--
-- NULLABLE, and null is the common case. A key that only answers authorization
-- queries has no endpoint and should not be given one. Delegation is opt in
-- per agent, the same way write approval is.
--
-- NOT VALIDATED HERE. A URL that resolves to a private address is an SSRF
-- vector, and DNS resolution is not something a CHECK constraint can do: a
-- hostname that is public today can point at 169.254.169.254 tomorrow. The
-- guard runs at registration AND again at every dispatch, in
-- assertScannableUrl, because only the check at the moment of sending is
-- actually protective.
ALTER TABLE instinct_gate_api_keys
  ADD COLUMN IF NOT EXISTS delegation_url TEXT;

COMMENT ON COLUMN instinct_gate_api_keys.delegation_url IS
  'HTTPS endpoint this external agent receives delegated tasks at. NULL means the agent is not delegable. Re-validated against the SSRF guard on every dispatch, never trusted from storage.';
