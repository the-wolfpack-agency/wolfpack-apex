-- 231_ai_content_policy_profile
--
-- Which content policy a workspace's answers are held to.
--
-- The router already redacts values in both directions. That finds SHAPES: a
-- card number, a key, an email. It cannot see a sentence that is dangerous
-- because of what it MEANS -- "you'll qualify for 2.9% APR", "that's covered
-- under your warranty", "yes, it's in stock, I'll hold one for you". Those
-- carry no redactable token and every one of them is a commitment the client,
-- not the model, is held to.
--
-- The rule sets live in code (src/lib/ai/policy.ts) so they are reviewable in
-- a diff rather than editable by an HTTP call, exactly as model availability
-- is. This column only says WHICH set a workspace runs, because that is a
-- per-tenant fact and the only part that differs between two clients on the
-- same deployment.
--
-- NULL means the deployment default, which is the baseline set: the rules true
-- of any business talking to its customers. A workspace never has "no policy".
--
-- No backfill and no new write path. Refusals are reported from the existing
-- append-only `instinct_events` stream (`ai.policy_refused`), the same way the
-- redaction panels already read `ai.prompt_redacted`.
--
-- Idempotent. Paired rollback in 231_ai_content_policy_profile.down.sql.

ALTER TABLE workspace_ai_policy
  ADD COLUMN IF NOT EXISTS content_policy_profile TEXT;

-- Constrained to the sets that exist. A typo here would otherwise degrade a
-- tenant to the baseline silently, which is the failure mode worth catching at
-- write time rather than discovering in a refusal log.
ALTER TABLE workspace_ai_policy
  DROP CONSTRAINT IF EXISTS workspace_ai_policy_content_profile_chk;
ALTER TABLE workspace_ai_policy
  ADD CONSTRAINT workspace_ai_policy_content_profile_chk
  CHECK (content_policy_profile IS NULL
         OR content_policy_profile IN ('baseline', 'automotive', 'retail'));
