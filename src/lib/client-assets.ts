/**
 * Per-client asset library (Path C Phase 1, Stream P3).
 *
 * Orchestration layer backing /api/clients/[slug]/assets. Holds the
 * logo / hero photo / product shot that a designer uploads once per
 * client and reuses across every site we build for that client.
 *
 * The KEY metric this library feeds into analytics is the reuse rate:
 * every time a designer picks an existing asset from the picker we
 * call `recordAssetUsage(assetId)` and emit `client_asset_reused`, so
 * the learning loop can score the picker's value ("clients with rich
 * asset libraries ship sites 2x faster" — real decision input for
 * product roadmapping).
 *
 * Every write goes through `writeQuery` (the strict helper that throws
 * on any pg error or unexpected row count). A 200 response from any
 * route backed by this lib is a guarantee the write landed — this is
 * the same pattern the feature-request library uses to defend against
 * silent-discard bugs.
 */

import { randomUUID } from "node:crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type ClientAssetKind =
  | "logo"
  | "photo"
  | "illustration"
  | "icon"
  | "other";

export interface ClientAsset {
  id: string;
  clientSlug: string;
  assetKind: ClientAssetKind;
  filename: string;
  url: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  altText: string | null;
  useCount: number;
  lastUsedAt: string | null;
  uploadedAt: string;
}

export interface RecordAssetUploadInput {
  clientSlug: string;
  assetKind: ClientAssetKind;
  filename: string;
  url: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  altText?: string;
  uploadedBy?: string;
  /**
   * Optional caller-supplied UUID. When present, this is the id the
   * INSERT uses — which lets the route compute the canonical `url`
   * (which embeds the id) before the row exists, instead of running
   * a follow-up UPDATE. If omitted, the lib mints its own.
   */
  id?: string;
}

const VALID_KINDS: ReadonlySet<ClientAssetKind> = new Set([
  "logo",
  "photo",
  "illustration",
  "icon",
  "other",
]);

/**
 * Raw row shape coming back from pg. Columns mirror 038_client_assets.sql.
 * Kept private; callers get the camelCase `ClientAsset` view only.
 */
interface ClientAssetRow {
  id: string;
  client_slug: string;
  asset_kind: string;
  filename: string;
  url: string;
  mime: string;
  size_bytes: string | number;
  sha256: string;
  alt_text: string | null;
  use_count: number;
  last_used_at: string | Date | null;
  uploaded_at: string | Date;
}

function rowToAsset(row: ClientAssetRow): ClientAsset {
  return {
    id: row.id,
    clientSlug: row.client_slug,
    assetKind: row.asset_kind as ClientAssetKind,
    filename: row.filename,
    url: row.url,
    mime: row.mime,
    sizeBytes:
      typeof row.size_bytes === "string"
        ? Number.parseInt(row.size_bytes, 10)
        : row.size_bytes,
    sha256: row.sha256,
    altText: row.alt_text,
    useCount: row.use_count,
    lastUsedAt:
      row.last_used_at === null
        ? null
        : typeof row.last_used_at === "string"
          ? row.last_used_at
          : row.last_used_at.toISOString(),
    uploadedAt:
      typeof row.uploaded_at === "string"
        ? row.uploaded_at
        : row.uploaded_at.toISOString(),
  };
}

/**
 * List active (non-deleted) assets for a client. Sort order:
 * last_used_at DESC NULLS LAST — so the picker's first screen is
 * dominated by assets the designer has actually reached for recently,
 * and unused uploads sink to the bottom.
 */
export async function listAssetsForClient(
  clientSlug: string,
  opts?: { kind?: ClientAssetKind },
): Promise<ClientAsset[]> {
  const params: unknown[] = [clientSlug];
  let sql = `SELECT id, client_slug, asset_kind, filename, url, mime,
                    size_bytes, sha256, alt_text, use_count,
                    last_used_at, uploaded_at
               FROM instinct_client_assets
              WHERE client_slug = $1
                AND deleted_at IS NULL`;
  if (opts?.kind) {
    if (!VALID_KINDS.has(opts.kind)) {
      // Invalid kind filter → empty result rather than SQL error.
      return [];
    }
    params.push(opts.kind);
    sql += ` AND asset_kind = $${params.length}`;
  }
  sql += ` ORDER BY last_used_at DESC NULLS LAST, uploaded_at DESC`;
  const { rows } = await safeQuery<ClientAssetRow>(sql, params);
  return rows.map(rowToAsset);
}

/**
 * Record an asset upload. Dedupes on (client_slug, sha256) — if the
 * same bytes were uploaded before, we increment use_count + return the
 * existing row rather than creating a duplicate. Emits
 * `client_asset_uploaded` with `deduped: true/false` so the learning
 * loop can distinguish first uploads from re-uploads.
 */
export async function recordAssetUpload(
  input: RecordAssetUploadInput,
): Promise<ClientAsset> {
  if (!VALID_KINDS.has(input.assetKind)) {
    throw new Error(`invalid asset_kind: ${input.assetKind}`);
  }

  // 1. Dedupe lookup. safeQuery is fine here: if the read falls back
  // to empty we just fall through to the INSERT which has the UNIQUE
  // constraint as the authoritative guard.
  const existing = await safeQuery<ClientAssetRow>(
    `SELECT id, client_slug, asset_kind, filename, url, mime, size_bytes,
            sha256, alt_text, use_count, last_used_at, uploaded_at
       FROM instinct_client_assets
      WHERE client_slug = $1 AND sha256 = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [input.clientSlug, input.sha256],
  );

  if (existing.rows.length > 0) {
    // Duplicate — bump use_count and return the existing row. We use
    // writeQuery with expectRows: 1 so a silent view-discard surfaces
    // loudly; this is a real write even though it's not an INSERT.
    const { rows } = await writeQuery<ClientAssetRow>(
      `UPDATE instinct_client_assets
          SET use_count = use_count + 1,
              last_used_at = NOW()
        WHERE id = $1
    RETURNING id, client_slug, asset_kind, filename, url, mime, size_bytes,
              sha256, alt_text, use_count, last_used_at, uploaded_at`,
      [existing.rows[0].id],
      { expectRows: 1 },
    );
    const asset = rowToAsset(rows[0]);
    trackEvent(
      "client_asset_uploaded",
      input.uploadedBy ?? "unknown",
      "unknown",
      {
        client_slug: asset.clientSlug,
        kind: asset.assetKind,
        size_bytes: asset.sizeBytes,
        deduped: true,
      },
    );
    return asset;
  }

  // 2. Fresh upload. writeQuery + expectRows: 1 guarantees either the
  // row is committed and returned OR we throw WriteQueryError — no
  // "silent success" path.
  const id = input.id ?? randomUUID();
  const { rows } = await writeQuery<ClientAssetRow>(
    `INSERT INTO instinct_client_assets
       (id, client_slug, asset_kind, filename, url, mime, size_bytes,
        sha256, alt_text, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_slug, asset_kind, filename, url, mime, size_bytes,
               sha256, alt_text, use_count, last_used_at, uploaded_at`,
    [
      id,
      input.clientSlug,
      input.assetKind,
      input.filename,
      input.url,
      input.mime,
      input.sizeBytes,
      input.sha256,
      input.altText ?? null,
      input.uploadedBy ?? null,
    ],
    { expectRows: 1 },
  );
  const asset = rowToAsset(rows[0]);
  trackEvent(
    "client_asset_uploaded",
    input.uploadedBy ?? "unknown",
    "unknown",
    {
      client_slug: asset.clientSlug,
      kind: asset.assetKind,
      size_bytes: asset.sizeBytes,
      deduped: false,
    },
  );
  return asset;
}

/**
 * Mark an asset as used on a site. Increments use_count + updates
 * last_used_at. The `client_asset_reused` event is how the learning
 * loop sees reuse rate — higher reuse = library is delivering value.
 *
 * Optional metadata lets callers tag which site referenced the asset
 * so we can later correlate "which assets land on which sites".
 */
export async function recordAssetUsage(
  assetId: string,
  opts?: { siteId?: string; userId?: string; userRole?: string },
): Promise<void> {
  const { rows } = await writeQuery<ClientAssetRow>(
    `UPDATE instinct_client_assets
        SET use_count = use_count + 1,
            last_used_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
  RETURNING id, client_slug, asset_kind, filename, url, mime, size_bytes,
            sha256, alt_text, use_count, last_used_at, uploaded_at`,
    [assetId],
    { expectRows: 1 },
  );
  const asset = rowToAsset(rows[0]);
  trackEvent(
    "client_asset_reused",
    opts?.userId ?? "unknown",
    opts?.userRole ?? "unknown",
    {
      client_slug: asset.clientSlug,
      asset_id: asset.id,
      site_id: opts?.siteId ?? "",
      kind: asset.assetKind,
    },
  );
}

/**
 * Soft-delete. Flips `deleted_at` so list queries exclude it, but the
 * row + blob persist so any site that already copied the asset doesn't
 * 404 on an in-flight reference. Emits `client_asset_deleted` for the
 * audit / learning trail.
 */
export async function softDeleteAsset(
  assetId: string,
  opts?: { userId?: string; userRole?: string },
): Promise<void> {
  const { rows } = await writeQuery<ClientAssetRow>(
    `UPDATE instinct_client_assets
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
  RETURNING id, client_slug, asset_kind, filename, url, mime, size_bytes,
            sha256, alt_text, use_count, last_used_at, uploaded_at`,
    [assetId],
    { expectRows: 1 },
  );
  const asset = rowToAsset(rows[0]);
  trackEvent(
    "client_asset_deleted",
    opts?.userId ?? "unknown",
    opts?.userRole ?? "unknown",
    {
      client_slug: asset.clientSlug,
      asset_id: asset.id,
    },
  );
}

/**
 * Internal — fetch a single asset by id regardless of deleted_at.
 * Used by the raw-content handler so a site that's still holding a
 * reference to a (recently) deleted asset can still resolve its bytes.
 */
export async function getAssetById(
  assetId: string,
): Promise<ClientAsset | null> {
  const { rows } = await safeQuery<ClientAssetRow>(
    `SELECT id, client_slug, asset_kind, filename, url, mime, size_bytes,
            sha256, alt_text, use_count, last_used_at, uploaded_at
       FROM instinct_client_assets
      WHERE id = $1
      LIMIT 1`,
    [assetId],
  );
  return rows.length > 0 ? rowToAsset(rows[0]) : null;
}

/**
 * Persist the raw asset bytes (base64) keyed by asset id. Separate
 * from recordAssetUpload so the metadata insert can commit even if
 * blob persistence fails — the caller can retry blob write without
 * creating duplicate asset rows.
 */
export async function saveAssetBlob(
  assetId: string,
  contentBase64: string,
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_client_asset_blobs (asset_id, content_base64)
     VALUES ($1, $2)
     ON CONFLICT (asset_id) DO UPDATE SET content_base64 = EXCLUDED.content_base64`,
    [assetId, contentBase64],
  );
}

export async function loadAssetBlob(
  assetId: string,
): Promise<{ contentBase64: string } | null> {
  const { rows } = await safeQuery<{ content_base64: string }>(
    `SELECT content_base64 FROM instinct_client_asset_blobs WHERE asset_id = $1 LIMIT 1`,
    [assetId],
  );
  return rows.length > 0 ? { contentBase64: rows[0].content_base64 } : null;
}
