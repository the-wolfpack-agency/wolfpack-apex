-- Rollback for 231_ai_content_policy_profile.
--
-- Dropping the column returns every workspace to the deployment default
-- (baseline). The gate stays on; only the industry rule set is lost.

ALTER TABLE workspace_ai_policy
  DROP CONSTRAINT IF EXISTS workspace_ai_policy_content_profile_chk;
ALTER TABLE workspace_ai_policy
  DROP COLUMN IF EXISTS content_policy_profile;
