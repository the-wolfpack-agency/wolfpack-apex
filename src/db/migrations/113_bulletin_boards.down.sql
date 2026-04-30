-- 113_bulletin_boards.down.sql — reverse 113_bulletin_boards.sql.
BEGIN;

DROP INDEX IF EXISTS idx_bulletin_snapshots_assoc;
DROP INDEX IF EXISTS idx_bulletin_snapshots_board;
DROP TABLE IF EXISTS instinct_bulletin_snapshots;

DROP INDEX IF EXISTS idx_bulletin_notes_assoc;
DROP INDEX IF EXISTS idx_bulletin_notes_board_active;
DROP TABLE IF EXISTS instinct_bulletin_notes;

DROP INDEX IF EXISTS idx_bulletin_boards_active;
DROP INDEX IF EXISTS idx_bulletin_boards_created;
DROP TABLE IF EXISTS instinct_bulletin_boards;

COMMIT;
