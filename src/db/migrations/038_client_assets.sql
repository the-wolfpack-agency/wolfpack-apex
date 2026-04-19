-- 038_client_assets.sql — per-client ASSET LIBRARY (logos, photos, icons,
-- illustrations) reusable across every site we build for that client.
--
-- Why: designers were re-uploading the same logo on every new site, at
-- best wasting GitHub commits, at worst getting the brand wrong because
-- the "correct" file was trapped on some other site's repo. This table
-- centralises the upload and lets `recordAssetUsage()` count how many
-- sites reference each asset — the reuse rate is THE key KPI for the
-- library's value, surfaced through analytics event
-- `client_asset_reused`.
--
-- Naming: `instinct_*` from the start (no legacy `apex_*` prefix). We
-- stopped mirroring `apex_*` writes in the Tier-3 rename (see
-- 014_instinct_table_aliases.sql + client-auth.ts header) so new tables
-- born after the rename use the canonical name directly.
--
-- Dedupe: UNIQUE (client_slug, sha256) guarantees the same bytes for
-- the same client map to a single row. `recordAssetUpload` SELECTs by
-- this pair first and falls through to INSERT only when absent — the
-- constraint is belt-and-suspenders for race conditions between two
-- parallel uploads of the same file.
--
-- Soft-delete: `deleted_at` lets us hide a retired asset from the picker
-- without losing the audit trail of which sites referenced it. The
-- partial kind index (`WHERE deleted_at IS NULL`) keeps `kind`-filtered
-- list queries cheap without bloating with tombstones.
--
-- Companion table `instinct_client_asset_blobs` stores the raw bytes as
-- base64. We deliberately do NOT commit to any specific client repo at
-- upload time — at upload time we don't know which site will use this
-- asset. Commit-to-repo happens later when onPick fires from the edit
-- page and the user chooses "use this as the logo on site X".

CREATE TABLE IF NOT EXISTS instinct_client_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug   TEXT NOT NULL,
  asset_kind    TEXT NOT NULL,   -- logo | photo | illustration | icon | other
  filename      TEXT NOT NULL,
  url           TEXT NOT NULL,   -- canonical URL served from /api/clients/[slug]/assets/[id]/raw
  mime          TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  sha256        TEXT NOT NULL,
  alt_text      TEXT,
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  use_count     INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  CONSTRAINT instinct_client_assets_kind_chk
    CHECK (asset_kind IN ('logo', 'photo', 'illustration', 'icon', 'other')),
  CONSTRAINT instinct_client_assets_dedupe UNIQUE (client_slug, sha256)
);

CREATE INDEX IF NOT EXISTS instinct_client_assets_client_idx
  ON instinct_client_assets(client_slug, deleted_at);
CREATE INDEX IF NOT EXISTS instinct_client_assets_kind_idx
  ON instinct_client_assets(client_slug, asset_kind)
  WHERE deleted_at IS NULL;
-- Sort key for the picker: most-recently-used assets float to the top.
CREATE INDEX IF NOT EXISTS instinct_client_assets_last_used_idx
  ON instinct_client_assets(client_slug, last_used_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

-- Blob storage: raw asset bytes as base64. Separated so the main
-- metadata table stays small for listing (the picker fetches rows of
-- ~200 bytes of metadata, not megabytes of image data).
CREATE TABLE IF NOT EXISTS instinct_client_asset_blobs (
  asset_id       UUID PRIMARY KEY
    REFERENCES instinct_client_assets(id) ON DELETE CASCADE,
  content_base64 TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
