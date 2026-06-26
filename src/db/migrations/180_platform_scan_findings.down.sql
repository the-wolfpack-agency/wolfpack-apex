-- Down for migration 180 — platform scan findings.
BEGIN;
DROP TABLE IF EXISTS instinct_platform_scan_findings;
DROP TABLE IF EXISTS instinct_platform_scans;
COMMIT;
