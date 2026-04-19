-- 033_site_domains.sql — custom domain bindings for Instinct Sites.
--
-- Without this table a designer can only hand clients a
-- `wolfpack-{slug}.vercel.app` preview URL. Attaching `acme.com` through
-- Vercel Domains requires persisting the domain + DNS verification
-- records so the UI can render a copy-pasteable block, and so the
-- learning loop sees every add/verify/remove event tied to a site.
--
-- NO data lost: a removed domain is kept as an archive row with
-- status = 'removed' + removed_at timestamp so we retain the full
-- attachment history per site.
--
-- NOTE: `site_id` is TEXT to match `apex_site_projects.id` (TEXT,
-- shape `site_<uuid>`). We don't use a UUID column here because the
-- rest of the sites schema (009, 029, 031, 032) uses TEXT ids.

CREATE TABLE IF NOT EXISTS apex_site_domains (
  id                    TEXT PRIMARY KEY,
  site_id               TEXT NOT NULL,
  domain                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',   -- pending | verified | removed | failed
  verification_records  JSONB,
  added_by              TEXT,
  added_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at           TIMESTAMPTZ,
  removed_at            TIMESTAMPTZ,
  last_error            TEXT,
  CONSTRAINT apex_site_domains_site_fk
    FOREIGN KEY (site_id) REFERENCES apex_site_projects(id) ON DELETE CASCADE,
  CONSTRAINT apex_site_domains_domain_uniq UNIQUE (domain)
);

CREATE INDEX IF NOT EXISTS apex_site_domains_site_idx ON apex_site_domains(site_id);
CREATE INDEX IF NOT EXISTS apex_site_domains_status_idx ON apex_site_domains(status);
CREATE INDEX IF NOT EXISTS apex_site_domains_added_at_idx ON apex_site_domains(added_at);

-- Instinct-name alias, mirroring 014's convention so external readers
-- can query `instinct_site_domains` without knowing about the apex_
-- legacy prefix.
CREATE OR REPLACE VIEW instinct_site_domains AS
  SELECT * FROM apex_site_domains;
