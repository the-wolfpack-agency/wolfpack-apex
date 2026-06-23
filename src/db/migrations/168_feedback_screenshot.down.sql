-- Down for 168: drop the feedback screenshot table. The images are
-- derived attachments, not the source of truth, so dropping them on
-- rollback loses only the pictures, never the feedback text itself.
DROP TABLE IF EXISTS instinct_feedback_screenshot;
