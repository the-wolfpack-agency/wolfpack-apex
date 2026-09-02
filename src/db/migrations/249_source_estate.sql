-- 249: which client's material a source holds.
--
-- WHY
--
-- This tenant holds work for several clients. Nineteen SharePoint sites are
-- reachable and only two were connected, so almost everything we had been
-- given was invisible to the product. Connecting the rest is right and makes
-- the assistant far more useful internally.
--
-- What it must not do is move the numbers a CLIENT sees. The Phase 1 page
-- reports "your library holds N documents" straight off brain_documents. Index
-- nine more clients' material without a way to tell it apart and that sentence
-- becomes false, in the specific way that is hardest to notice: it still reads
-- like a fact about them.
--
-- The same shape was already fixed once, on 2026-09-01, when the passage count
-- was including our own platform-scan output and was corrected to exclude it.
-- That was one estate leaking into a client's figure. This is the general case.
--
-- ESTATE, NOT WORKSPACE. workspace_id already exists and means the Instinct
-- tenant: one workspace, many estates. A client's own deployment will have the
-- same shape internally, since their SharePoint is divided by brand and region
-- in exactly this way, so the column is worth having whichever side it runs on.
--
-- DEFAULTS TO 'wolfpack', not to null. A source nobody has classified is ours
-- until somebody says otherwise, which keeps it OUT of a client's figures. The
-- opposite default would put unclassified material into a client's library and
-- report it as theirs.
--
-- Idempotent. Reversible via 249_source_estate.down.sql.

ALTER TABLE instinct_sharepoint_sources
  ADD COLUMN IF NOT EXISTS estate TEXT NOT NULL DEFAULT 'wolfpack';

-- A document remembers the estate it came from, because brain_documents has no
-- source reference at all: the coverage report had to attribute documents by
-- matching URL prefixes, which cannot survive a site being renamed. Nullable,
-- since documents uploaded by hand belong to no source.
ALTER TABLE brain_documents
  ADD COLUMN IF NOT EXISTS estate TEXT;

-- The two sites connected before today are both PCNA work: the PCNA INTERNAL
-- site and the Wolfpack x PCNA shared site. Naming them explicitly rather than
-- pattern-matching, so a site added later with 'pcna' in its name does not
-- silently join a client's figures.
UPDATE instinct_sharepoint_sources
   SET estate = 'pcna'
 WHERE lower(site_url) LIKE '%/sites/pcnainternal%'
    OR lower(site_url) LIKE '%/sites/wolfpackxpcna%';

-- Everything already indexed came from those two sites or from uploads made
-- during the pilot, so it is the PCNA estate. Set before any new site is
-- connected, which is why this migration comes first: after the fact there is
-- no way to tell the two apart.
UPDATE brain_documents
   SET estate = 'pcna'
 WHERE estate IS NULL;

-- Read on every client-facing count.
CREATE INDEX IF NOT EXISTS idx_brain_documents_estate
  ON brain_documents (estate) WHERE estate IS NOT NULL;
