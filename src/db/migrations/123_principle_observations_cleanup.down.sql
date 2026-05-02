-- 123 down: noop. The duplicates this migration deleted were data
-- corruption — there's no way to recreate them, and rolling back the
-- index recreate is handled by 122's down.
BEGIN;
COMMIT;
