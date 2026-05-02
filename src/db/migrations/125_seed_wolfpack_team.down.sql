-- 125 down: noop. Rolling back team members is operationally
-- destructive (cascades to refresh tokens, audit log, etc.). Manual
-- DELETE is the right path if a row genuinely needs to come out.
BEGIN;
COMMIT;
