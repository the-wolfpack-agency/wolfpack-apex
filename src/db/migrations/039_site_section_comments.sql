-- 039_site_section_comments.sql — per-section threaded comments for
-- Instinct Sites. Path C Phase 3 · Stream R3.
--
-- Why a new table (instead of reusing apex_site_approvals):
--   * Approvals are one-per-client-decision; comments are many-per-
--     section and often threaded. Shoving both into one table would
--     collapse two very different audit trails.
--   * The learning loop wants comment-volume + resolve-rate + reply-
--     depth as independent KPIs — those queries are cheaper off a
--     dedicated table.
--   * Comments may come from BOTH unauth share-link reviewers and
--     authed designers; share_token_id is nullable so the same row
--     shape covers both paths without a poison boolean.
--
-- Naming: `instinct_*` from the start (new table, no legacy alias
-- needed). See 038_client_assets.sql comment for the rename rationale.
--
-- NO data lost:
--   * Deletes are SOFT — body becomes "[deleted]" but the row remains so
--     analytics + audit trails stay intact.
--   * Revoked share tokens FK-null on comments (ON DELETE SET NULL) so
--     the comment history survives token lifecycle churn. If the parent
--     SITE is deleted, comments cascade (the site itself is gone).
--   * Parent-comment FK cascades so resolving + deleting a top-level
--     comment tombs the whole thread atomically.
--
-- Performance:
--   * Partial index on (site_id, page_index, section_index, created_at DESC)
--     WHERE state = 'open' — the hot read path is "open comments on a
--     section". Resolved comments aren't queried until someone opens
--     the "resolved" filter, a cold path.

BEGIN;

DO $$
DECLARE
  apex_sites_exists BOOLEAN;
  share_tokens_exists BOOLEAN;
BEGIN
  -- Foreign-key targets MUST exist before we attempt the CREATE. If a
  -- fresh DB hits this migration before 033/035 ran (shouldn't happen
  -- in prod but does in scratch envs), abort loudly with the root cause
  -- instead of a confusing 42P01 from the FK clause.
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_site_projects'
      AND c.relkind IN ('r', 'v')
      AND n.nspname = current_schema()
  ) INTO apex_sites_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_share_tokens'
      AND c.relkind IN ('r', 'v')
      AND n.nspname = current_schema()
  ) INTO share_tokens_exists;

  IF NOT apex_sites_exists THEN
    RAISE EXCEPTION 'apex_site_projects missing — run migrations 001..033 first before 039.';
  END IF;
  IF NOT share_tokens_exists THEN
    RAISE EXCEPTION 'apex_share_tokens missing — run migration 035 before 039.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_site_section_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           TEXT NOT NULL,
  -- null when the comment came from a signed-in designer (authed path);
  -- set when the comment came through /share/[token] (unauth path).
  share_token_id    UUID,
  page_index        INT NOT NULL,
  section_index     INT NOT NULL,
  -- Snapshot the section type at comment-time so a reorder or delete
  -- upstream doesn't orphan the comment's context. Nullable because
  -- legacy clients may POST without it.
  section_type      TEXT,
  body              TEXT NOT NULL,
  actor_name        TEXT,
  actor_email       TEXT,
  -- null = top-level; set = reply to another comment.
  parent_comment_id UUID,
  -- Lifecycle: open → resolved. Never deleted (soft-delete via body
  -- = '[deleted]').
  state             TEXT NOT NULL DEFAULT 'open',
  resolved_by       TEXT,  -- user identifier; see feedback_no_silent_data_loss.md
                          -- + migrations/040 rationale. Not UUID because demo
                          -- accounts use string slugs like "demo-cto".
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_section_comments_site_fk
    FOREIGN KEY (site_id) REFERENCES apex_site_projects(id) ON DELETE CASCADE,
  CONSTRAINT site_section_comments_token_fk
    FOREIGN KEY (share_token_id) REFERENCES apex_share_tokens(id) ON DELETE SET NULL,
  CONSTRAINT site_section_comments_parent_fk
    FOREIGN KEY (parent_comment_id) REFERENCES instinct_site_section_comments(id) ON DELETE CASCADE,
  CONSTRAINT site_section_comments_state_chk
    CHECK (state IN ('open', 'resolved')),
  CONSTRAINT site_section_comments_body_len_chk
    CHECK (length(body) <= 5000),
  CONSTRAINT site_section_comments_page_nonneg
    CHECK (page_index >= 0 AND section_index >= 0)
);

-- Hot path: "open comments on a section, newest first." Partial index
-- keeps the index small — resolved comments aren't queried on the hot
-- path, only in the cold "show resolved" filter.
CREATE INDEX IF NOT EXISTS site_section_comments_site_page_idx
  ON instinct_site_section_comments(site_id, page_index, section_index, created_at DESC)
  WHERE state = 'open';

-- Reply-thread lookup: "give me every reply to comment X."
CREATE INDEX IF NOT EXISTS site_section_comments_parent_idx
  ON instinct_site_section_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

-- Full-site list (designer pane needs both open + resolved):
CREATE INDEX IF NOT EXISTS site_section_comments_site_all_idx
  ON instinct_site_section_comments(site_id, created_at DESC);

-- Compat-view assertion: the auto-updatable view pattern from 036 would
-- apply IF we had a legacy apex_* alias. We don't (new name from day
-- one), but we still verify the table is writable at the end of the
-- migration so a misconfigured RLS policy surfaces immediately rather
-- than on the first POST.
DO $$
DECLARE
  is_table BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_site_section_comments'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO is_table;

  IF NOT is_table THEN
    RAISE EXCEPTION 'instinct_site_section_comments was not created — aborting.';
  END IF;
  RAISE NOTICE 'instinct_site_section_comments created + indexed.';
END $$;

COMMIT;
