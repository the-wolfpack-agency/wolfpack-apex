-- 302_forcefield_server_inventory.sql
--
-- "Is your server exposed?": the latest server inventory the Forcefield
-- WordPress plugin reports for its site, one row per tenant. The plugin sends it
-- when it is linked and then once a day (WP-Cron), authenticated by the site key
-- it already holds. It carries ONLY software versions:
--   php_version         PHP_VERSION on the site's server, e.g. "8.3.10".
--   wordpress_version   the WordPress core version.
--   server_software     the web server software string, e.g. "Apache/2.4.62".
--   plugins             active plugins as [{ "slug", "version" }].
--   plugin_version      the Forcefield plugin's own version.
-- No visitor, content or account data. Findings are NOT stored: they are
-- computed on read from these versions and the fixed-version data in
-- src/lib/forcefield/kev/fixed-versions.ts, so a data update applies at once.
--
--   alerted_keys        exposure keys (rule id + product) already emailed to the
--                       owner. Pruned to the exposures still present on each
--                       report, so a flaw that is fixed and later reappears
--                       alerts again; one that persists never alerts twice.
--
-- Safe on live data: a new table only. Idempotent.

CREATE TABLE IF NOT EXISTS forcefield_server_inventory (
  tenant_id          UUID PRIMARY KEY REFERENCES forcefield_tenants(id) ON DELETE CASCADE,
  php_version        TEXT,
  wordpress_version  TEXT,
  server_software    TEXT,
  plugins            JSONB NOT NULL DEFAULT '[]'::jsonb,
  plugin_version     TEXT,
  alerted_keys       TEXT[] NOT NULL DEFAULT '{}',
  reports            INTEGER NOT NULL DEFAULT 1,
  first_received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT forcefield_server_inventory_plugins_array CHECK (jsonb_typeof(plugins) = 'array')
);

CREATE INDEX IF NOT EXISTS forcefield_server_inventory_received_at
  ON forcefield_server_inventory (received_at DESC);
