-- Rollback for 302_forcefield_server_inventory.sql (ops-only; never run by deploy).
DROP INDEX IF EXISTS forcefield_server_inventory_received_at;
DROP TABLE IF EXISTS forcefield_server_inventory;
