-- 039_site_section_comments.down.sql — reversible teardown of 039.
--
-- Drop order: indexes → table. The table's own CASCADE on the self-FK
-- cleans up reply rows automatically.
--
-- WARNING: this drops ALL section comments for every site. There is no
-- recovery short of a DB restore. Run only when explicitly rolling back
-- Path C Phase 3 · Stream R3.

DROP INDEX IF EXISTS site_section_comments_site_all_idx;
DROP INDEX IF EXISTS site_section_comments_parent_idx;
DROP INDEX IF EXISTS site_section_comments_site_page_idx;
DROP TABLE IF EXISTS instinct_site_section_comments;
