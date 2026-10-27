-- Rollback for 301_forcefield_edge.sql (ops-only; never run by deploy).
DROP TABLE IF EXISTS forcefield_edge_hostnames;
ALTER TABLE forcefield_tenants
  DROP COLUMN IF EXISTS edge_origin_url,
  DROP COLUMN IF EXISTS edge_origin_secret_sealed,
  DROP COLUMN IF EXISTS edge_secret_rotated_at;
