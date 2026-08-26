-- Who may retrieve a document.
--
-- Retrieval had no permission model at all: any user holding assistant.use
-- could be quoted any document in the Brain. That is defensible while the
-- corpus is one company's own material and indefensible the moment a client
-- tenant holds HR files, dealer agreements and manager-only process docs in
-- the same index.
--
-- NULL means workspace-wide, which is what every existing row honestly IS: it
-- was ingested with no restriction, by hand, by somebody in this workspace.
-- Backfilling those to a narrow audience would be inventing a restriction that
-- was never applied.
--
-- Connector documents are different and default the other way. See the source
-- table below: a SharePoint library is somebody else's permission model, and
-- inheriting "everyone" from a system that says otherwise is the failure this
-- column exists to prevent.
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS audience_roles TEXT[];

CREATE INDEX IF NOT EXISTS brain_documents_audience_idx
  ON brain_documents USING GIN (audience_roles);

-- Which roles a connector source may be read by. NOT NULL and admin-only by
-- default: widening is a decision somebody makes, narrowing must never be
-- something they forget.
ALTER TABLE instinct_sharepoint_sources
  ADD COLUMN IF NOT EXISTS audience_roles TEXT[] NOT NULL DEFAULT ARRAY['admin']::TEXT[];
