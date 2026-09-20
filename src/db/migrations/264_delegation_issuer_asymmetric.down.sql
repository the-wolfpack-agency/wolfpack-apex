ALTER TABLE instinct_delegation_issuers DROP CONSTRAINT IF EXISTS delegation_issuer_algo_chk;
ALTER TABLE instinct_delegation_issuers ADD CONSTRAINT delegation_issuer_algo_chk CHECK (algorithm IN ('hs256'));
ALTER TABLE instinct_delegation_issuers DROP COLUMN IF EXISTS public_key;
