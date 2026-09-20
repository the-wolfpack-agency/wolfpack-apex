-- Move delegation issuers off shared symmetric secrets toward asymmetric keys
-- (removes the "leak the secret, mint verified principals" hole and is the PQ
-- on-ramp). An issuer may now register an ES256 public key (JWK) instead of an
-- HMAC secret; the ML-DSA-65 post-quantum slot plugs into the same column later.
ALTER TABLE instinct_delegation_issuers
  ADD COLUMN IF NOT EXISTS public_key JSONB;
-- Widen the algorithm vocabulary; the app enforces that hs256 uses `secret` and
-- es256 uses `public_key`.
ALTER TABLE instinct_delegation_issuers
  DROP CONSTRAINT IF EXISTS delegation_issuer_algo_chk;
ALTER TABLE instinct_delegation_issuers
  ADD CONSTRAINT delegation_issuer_algo_chk CHECK (algorithm IN ('hs256', 'es256', 'ml-dsa-65-hybrid'));
-- hs256 secret is no longer mandatory (asymmetric issuers carry a public_key).
ALTER TABLE instinct_delegation_issuers
  ALTER COLUMN secret DROP NOT NULL;
