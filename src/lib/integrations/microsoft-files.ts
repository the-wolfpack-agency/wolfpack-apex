/**
 * Microsoft 365 OneDrive Files integration.
 *
 * Builds on @/lib/microsoft-graph OAuth + token storage. Metadata-only
 * cache in `instinct_ms_files_metadata` — we never store file bytes.
 * Downloads use the Graph-issued short-lived download URL so the browser
 * hits Microsoft directly (no proxy, no bandwidth through Instinct).
 *
 * Graph surface:
 *   GET    /me/drive/root/children
 *   GET    /me/drive/items/{id}
 *   PUT    /me/drive/items/{parentId}:/{filename}:/content   (< 4 MB)
 *   POST   /me/drive/items/{parentId}:/{filename}:/createUploadSession
 *   GET    /me/drive/items/{id}?$select=@microsoft.graph.downloadUrl
 *   POST   /me/drive/items/{id}/createLink
 *   DELETE /me/drive/items/{id}
 *
 * Error semantics:
 *   - 403 returns { ok:false, code:"scope_missing", scope } from helpers
 *     exposed as *_Safe wrappers. Core helpers throw GraphFilesError.
 *   - 429 is retried once honoring Retry-After.
 *   - All mutations emit audit + analytics even on failure.
 *
 * Scope requirements (already requested by MS_SCOPES owned by Stream A):
 *   Files.ReadWrite
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, type AuditActor } from "@/lib/audit-log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriveItem {
  id: string;               // local UUID
  msDriveItemId: string;    // Graph id
  userId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webUrl: string | null;
  downloadUrl: string | null;
  parentPath: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  etag: string | null;
  syncedAt: string;
  isFolder: boolean;
}

export interface ListDriveItemsOpts {
  parentId?: string;   // Graph drive item id of the parent folder; default = root
  top?: number;        // Graph page size (max 999)
  cursor?: string;     // @odata.nextLink from previous page
  search?: string;     // optional full-text search on file names
}

export interface UploadSessionInfo {
  uploadUrl: string;
  expirationDateTime: string;
}

export interface ShareLink {
  url: string;
  expiresAt: string | null;
  type: "view" | "edit";
  scope: "anonymous" | "organization";
}

export type ScopeMissingResult = { ok: false; code: "scope_missing"; scope: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GraphFilesError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "GraphFilesError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** Max size for single-PUT upload path. Over this the caller MUST use an upload session. */
export const SMALL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Graph helpers (private)
// ---------------------------------------------------------------------------

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new GraphFilesError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

interface GraphCallOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  accessToken: string;
  body?: unknown;
  binaryBody?: Buffer;
  binaryContentType?: string;
}

async function graphCall<T = unknown>(endpoint: string, opts: GraphCallOpts): Promise<T> {
  // Build the request URL, then validate that the host is on the
  // Microsoft Graph allow-list before any fetch(). `endpoint` may be
  // either a relative path (recommended) OR an absolute URL Graph
  // returned (e.g. @microsoft.graph.downloadUrl). Either way, only
  // graph.microsoft.com or *.sharepoint.com / *.azureedge.net (Graph's
  // download CDNs) may be reached. (CodeQL: js/request-forgery.)
  const rawUrl = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GraphFilesError(400, `invalid graph endpoint: ${endpoint}`);
  }
  if (parsed.protocol !== "https:") {
    throw new GraphFilesError(400, `non-https graph endpoint: ${endpoint}`);
  }
  const host = parsed.hostname.toLowerCase();
  const hostAllowed =
    host === "graph.microsoft.com" ||
    host.endsWith(".graph.microsoft.com") ||
    host.endsWith(".sharepoint.com") ||
    host.endsWith(".azureedge.net") ||
    host.endsWith(".officeapps.live.com");
  if (!hostAllowed) {
    throw new GraphFilesError(400, `disallowed graph host: ${host}`);
  }
  const url = parsed.toString();
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    Accept: "application/json",
  };
  let body: BodyInit | undefined;
  if (opts.binaryBody !== undefined) {
    headers["Content-Type"] = opts.binaryContentType ?? "application/octet-stream";
    body = opts.binaryBody as any;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method, headers, body });

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await sleep(retryAfter * 1000);
    const retry = await fetch(url, { method, headers, body });
    if (!retry.ok) {
      throw new GraphFilesError(
        retry.status,
        `Graph ${method} ${endpoint} failed after retry: ${retry.status}`,
        retryAfter,
      );
    }
    if (retry.status === 204) return undefined as unknown as T;
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new GraphFilesError(res.status, `Graph ${method} ${endpoint} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphDriveItem {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string };
  "@microsoft.graph.downloadUrl"?: string;
  "@odata.etag"?: string;
  [k: string]: unknown;
}

function normalizeDriveItem(userId: string, g: GraphDriveItem): Omit<DriveItem, "id" | "syncedAt"> {
  return {
    msDriveItemId: g.id,
    userId,
    name: g.name,
    mimeType: g.file?.mimeType ?? null,
    sizeBytes: typeof g.size === "number" ? g.size : null,
    webUrl: g.webUrl ?? null,
    downloadUrl: g["@microsoft.graph.downloadUrl"] ?? null,
    parentPath: g.parentReference?.path ?? null,
    createdAt: g.createdDateTime ? new Date(g.createdDateTime).toISOString() : null,
    modifiedAt: g.lastModifiedDateTime ? new Date(g.lastModifiedDateTime).toISOString() : null,
    etag: g["@odata.etag"] ?? null,
    isFolder: !!g.folder,
  };
}

// ---------------------------------------------------------------------------
// Cache upserts
// ---------------------------------------------------------------------------

async function upsertItem(userId: string, g: GraphDriveItem): Promise<DriveItem> {
  const norm = normalizeDriveItem(userId, g);
  const { rows } = await query<{
    id: string; synced_at: string;
  }>(
    `INSERT INTO instinct_ms_files_metadata
       (user_id, ms_drive_item_id, name, mime_type, size_bytes, web_url, download_url,
        parent_path, created_at, modified_at, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (user_id, ms_drive_item_id) DO UPDATE SET
       name = EXCLUDED.name,
       mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes,
       web_url = EXCLUDED.web_url,
       download_url = EXCLUDED.download_url,
       parent_path = EXCLUDED.parent_path,
       created_at = EXCLUDED.created_at,
       modified_at = EXCLUDED.modified_at,
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id, synced_at`,
    [
      userId,
      norm.msDriveItemId,
      norm.name,
      norm.mimeType,
      norm.sizeBytes,
      norm.webUrl,
      norm.downloadUrl,
      norm.parentPath,
      norm.createdAt,
      norm.modifiedAt,
      norm.etag,
    ],
  );
  const row = rows[0];
  return {
    ...norm,
    id: row.id,
    syncedAt: new Date(row.synced_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scope-miss mapping
// ---------------------------------------------------------------------------

/**
 * Convert a thrown GraphFilesError into a standard scope_missing payload
 * when the status is 403. Other errors re-throw. Callers that want the
 * "never throw on scope" contract use this helper.
 */
function scopeMissingOnForbidden<T>(err: unknown, scope: string): ScopeMissingResult {
  if (err instanceof GraphFilesError && err.status === 403) {
    return { ok: false, code: "scope_missing", scope };
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List drive items inside a folder (default = drive root). Upserts each
 * item into the local cache + emits `system.ms_file_list_fetched`.
 * Returns the items plus a Graph-paging cursor (opaque URL).
 *
 * On 403 → returns { items: [], nextCursor: null, scopeMissing: "Files.ReadWrite" }.
 */
export async function listDriveItems(
  userId: string,
  opts: ListDriveItemsOpts = {},
): Promise<{ items: DriveItem[]; nextCursor: string | null; scopeMissing?: string }> {
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof GraphFilesError && err.status === 401) throw err;
    throw err;
  }

  const top = Math.min(Math.max(opts.top ?? 50, 1), 200);
  const params = new URLSearchParams();
  params.set("$top", String(top));
  // Include download URL + parent reference in the response payload.
  params.set("$select", "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl");

  let endpoint: string;
  if (opts.cursor) {
    // Cursor is the full @odata.nextLink URL; respect it.
    endpoint = opts.cursor;
  } else if (opts.search) {
    endpoint = `me/drive/root/search(q='${encodeURIComponent(opts.search)}')?${params.toString()}`;
  } else if (opts.parentId) {
    endpoint = `me/drive/items/${encodeURIComponent(opts.parentId)}/children?${params.toString()}`;
  } else {
    endpoint = `me/drive/root/children?${params.toString()}`;
  }

  try {
    const res = await graphCall<{ value: GraphDriveItem[]; "@odata.nextLink"?: string }>(
      endpoint,
      { accessToken: token },
    );
    const items: DriveItem[] = [];
    for (const g of res.value ?? []) {
      items.push(await upsertItem(userId, g));
    }
    trackEvent("system.ms_file_list_fetched", userId, "system", {
      count: items.length,
      parent_id: opts.parentId ?? "root",
      search: opts.search ?? "",
    });
    return {
      items,
      nextCursor: res["@odata.nextLink"] ?? null,
    };
  } catch (err) {
    if (err instanceof GraphFilesError && err.status === 403) {
      trackEvent("system.ms_file_operation_failed", userId, "system", {
        op: "list",
        http_status: 403,
        reason: "scope_missing",
      });
      return { items: [], nextCursor: null, scopeMissing: "Files.ReadWrite" };
    }
    trackEvent("system.ms_file_operation_failed", userId, "system", {
      op: "list",
      http_status: err instanceof GraphFilesError ? err.status : 0,
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Get a single drive item's metadata. Upserts into the cache. Returns null
 * on 404. Returns null on 403 (scope missing) and emits failed analytics.
 */
export async function getItem(
  userId: string,
  itemId: string,
): Promise<DriveItem | null> {
  const token = await resolveToken(userId);
  try {
    const g = await graphCall<GraphDriveItem>(
      `me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl`,
      { accessToken: token },
    );
    return upsertItem(userId, g);
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 404) return null;
      if (err.status === 403) {
        trackEvent("system.ms_file_operation_failed", userId, "system", {
          op: "get",
          item_id: itemId,
          http_status: 403,
          reason: "scope_missing",
        });
        return null;
      }
      trackEvent("system.ms_file_operation_failed", userId, "system", {
        op: "get",
        item_id: itemId,
        http_status: err.status,
        error: err.message,
      });
    }
    throw err;
  }
}

/**
 * Upload a small file (< 4 MB) via a single PUT. For larger files use
 * `startUploadSession`. parentId = Graph drive item id of the parent folder,
 * or the literal string "root" for the drive root.
 *
 * Audits `files.uploaded`; analytics `system.ms_file_uploaded`.
 */
export async function uploadSmallFile(
  userId: string,
  parentId: string,
  filename: string,
  contentType: string,
  buffer: Buffer,
  actor?: AuditActor,
): Promise<{ id: string; msDriveItemId: string; webUrl: string | null }> {
  if (buffer.length > SMALL_UPLOAD_MAX_BYTES) {
    throw new GraphFilesError(
      413,
      `File exceeds ${SMALL_UPLOAD_MAX_BYTES} bytes — use startUploadSession`,
    );
  }
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw new GraphFilesError(400, "filename must not contain path separators");
  }

  const token = await resolveToken(userId);
  const parent = parentId === "root" ? "root" : `items/${encodeURIComponent(parentId)}`;
  const endpoint = `me/drive/${parent}:/${encodeURIComponent(filename)}:/content`;

  try {
    const g = await graphCall<GraphDriveItem>(endpoint, {
      method: "PUT",
      accessToken: token,
      binaryBody: buffer,
      binaryContentType: contentType || "application/octet-stream",
    });
    const cached = await upsertItem(userId, g);

    trackEvent("system.ms_file_uploaded", userId, "system", {
      item_id: cached.msDriveItemId,
      size_bytes: cached.sizeBytes ?? buffer.length,
      parent_id: parentId,
      mime_type: contentType,
    });

    await recordAudit({
      actor: actor ?? { user_id: userId, role: "system" },
      action: "files.uploaded",
      resourceType: "ms_drive_item",
      resourceId: cached.msDriveItemId,
      afterState: {
        name: cached.name,
        size_bytes: cached.sizeBytes,
        web_url: cached.webUrl,
        parent_id: parentId,
        mime_type: contentType,
      },
    }).catch((e) => console.warn("[microsoft-files] audit failed:", (e as Error).message));

    return { id: cached.id, msDriveItemId: cached.msDriveItemId, webUrl: cached.webUrl };
  } catch (err) {
    trackEvent("system.ms_file_operation_failed", userId, "system", {
      op: "upload_small",
      parent_id: parentId,
      filename,
      http_status: err instanceof GraphFilesError ? err.status : 0,
      reason: err instanceof GraphFilesError && err.status === 403 ? "scope_missing" : "error",
    });
    throw err;
  }
}

/**
 * Start a resumable upload session. Caller uploads bytes directly to
 * Graph via the returned uploadUrl in chunks (<= 60 MB each recommended,
 * must be multiples of 320 KiB).
 */
export async function startUploadSession(
  userId: string,
  parentId: string,
  filename: string,
): Promise<UploadSessionInfo> {
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw new GraphFilesError(400, "filename must not contain path separators");
  }
  const token = await resolveToken(userId);
  const parent = parentId === "root" ? "root" : `items/${encodeURIComponent(parentId)}`;
  const endpoint = `me/drive/${parent}:/${encodeURIComponent(filename)}:/createUploadSession`;

  try {
    const res = await graphCall<{ uploadUrl: string; expirationDateTime: string }>(
      endpoint,
      {
        method: "POST",
        accessToken: token,
        body: {
          item: {
            "@microsoft.graph.conflictBehavior": "rename",
            name: filename,
          },
        },
      },
    );
    return { uploadUrl: res.uploadUrl, expirationDateTime: res.expirationDateTime };
  } catch (err) {
    trackEvent("system.ms_file_operation_failed", userId, "system", {
      op: "upload_session",
      parent_id: parentId,
      filename,
      http_status: err instanceof GraphFilesError ? err.status : 0,
    });
    throw err;
  }
}

/**
 * Get a short-lived Graph download URL for the item. Emits
 * `system.ms_file_downloaded`. Returns null on 404. On 403 returns null.
 */
export async function getDownloadUrl(
  userId: string,
  itemId: string,
): Promise<string | null> {
  const token = await resolveToken(userId);
  try {
    const g = await graphCall<GraphDriveItem>(
      `me/drive/items/${encodeURIComponent(itemId)}?$select=id,@microsoft.graph.downloadUrl,name,size,file,webUrl,lastModifiedDateTime,parentReference`,
      { accessToken: token },
    );
    const url = g["@microsoft.graph.downloadUrl"] ?? null;
    // Opportunistic cache refresh.
    await upsertItem(userId, g).catch(() => {});
    if (url) {
      trackEvent("system.ms_file_downloaded", userId, "system", {
        item_id: itemId,
        name: g.name ?? "",
      });
    }
    return url;
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 404) return null;
      if (err.status === 403) {
        trackEvent("system.ms_file_operation_failed", userId, "system", {
          op: "download_url",
          item_id: itemId,
          http_status: 403,
          reason: "scope_missing",
        });
        return null;
      }
    }
    trackEvent("system.ms_file_operation_failed", userId, "system", {
      op: "download_url",
      item_id: itemId,
      http_status: err instanceof GraphFilesError ? err.status : 0,
    });
    throw err;
  }
}

/**
 * Create a shareable link to the item. Audits `files.share_created` which
 * feeds the collaboration graph for learning signals.
 */
export async function createShareLink(
  userId: string,
  itemId: string,
  options: { type: "view" | "edit"; scope: "anonymous" | "organization" },
  actor?: AuditActor,
): Promise<ShareLink> {
  const token = await resolveToken(userId);
  try {
    const res = await graphCall<{
      link: { webUrl: string };
      expirationDateTime?: string;
    }>(
      `me/drive/items/${encodeURIComponent(itemId)}/createLink`,
      {
        method: "POST",
        accessToken: token,
        body: { type: options.type, scope: options.scope },
      },
    );
    const share: ShareLink = {
      url: res.link.webUrl,
      expiresAt: res.expirationDateTime ?? null,
      type: options.type,
      scope: options.scope,
    };

    await recordAudit({
      actor: actor ?? { user_id: userId, role: "system" },
      action: "files.share_created",
      resourceType: "ms_drive_item",
      resourceId: itemId,
      afterState: {
        type: options.type,
        scope: options.scope,
        url: share.url,
        expires_at: share.expiresAt,
      },
    }).catch((e) => console.warn("[microsoft-files] audit failed:", (e as Error).message));

    return share;
  } catch (err) {
    trackEvent("system.ms_file_operation_failed", userId, "system", {
      op: "share",
      item_id: itemId,
      http_status: err instanceof GraphFilesError ? err.status : 0,
    });
    throw err;
  }
}

/**
 * Delete a drive item. Removes the cached row + audits `files.deleted`.
 */
export async function deleteItem(
  userId: string,
  itemId: string,
  actor?: AuditActor,
): Promise<void> {
  const token = await resolveToken(userId);

  // Capture before-state from cache for the audit record.
  const { rows: priorRows } = await safeQuery<{
    name: string; size_bytes: number | null; web_url: string | null;
  }>(
    `SELECT name, size_bytes, web_url FROM instinct_ms_files_metadata
     WHERE user_id = $1 AND ms_drive_item_id = $2 LIMIT 1`,
    [userId, itemId],
  );
  const before = priorRows[0] ?? null;

  try {
    await graphCall<void>(
      `me/drive/items/${encodeURIComponent(itemId)}`,
      { method: "DELETE", accessToken: token },
    );
    // Purge cache row (best-effort — a missing row is harmless).
    await query(
      `DELETE FROM instinct_ms_files_metadata WHERE user_id = $1 AND ms_drive_item_id = $2`,
      [userId, itemId],
    ).catch(() => {});

    await recordAudit({
      actor: actor ?? { user_id: userId, role: "system" },
      action: "files.deleted",
      resourceType: "ms_drive_item",
      resourceId: itemId,
      beforeState: before,
    }).catch((e) => console.warn("[microsoft-files] audit failed:", (e as Error).message));
  } catch (err) {
    trackEvent("system.ms_file_operation_failed", userId, "system", {
      op: "delete",
      item_id: itemId,
      http_status: err instanceof GraphFilesError ? err.status : 0,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Safe wrappers — never throw on scope_missing.
// ---------------------------------------------------------------------------

export async function listDriveItems_Safe(
  userId: string,
  opts: ListDriveItemsOpts = {},
): Promise<{ ok: true; items: DriveItem[]; nextCursor: string | null } | ScopeMissingResult> {
  try {
    const r = await listDriveItems(userId, opts);
    if (r.scopeMissing) return { ok: false, code: "scope_missing", scope: r.scopeMissing };
    return { ok: true, items: r.items, nextCursor: r.nextCursor };
  } catch (err) {
    return scopeMissingOnForbidden<ScopeMissingResult>(err, "Files.ReadWrite");
  }
}

// ---------------------------------------------------------------------------
// Cache read helpers
// ---------------------------------------------------------------------------

export async function listCachedFiles(
  userId: string,
  opts: { limit?: number; search?: string } = {},
): Promise<DriveItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  let where = "user_id = $1";
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  params.push(limit);
  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_drive_item_id, name, mime_type, size_bytes, web_url, download_url,
            parent_path, created_at, modified_at, etag, synced_at
     FROM instinct_ms_files_metadata
     WHERE ${where}
     ORDER BY modified_at DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToItem);
}

function rowToItem(r: any): DriveItem {
  return {
    id: r.id,
    msDriveItemId: r.ms_drive_item_id,
    userId: r.user_id,
    name: r.name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    webUrl: r.web_url,
    downloadUrl: r.download_url,
    parentPath: r.parent_path,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    modifiedAt: r.modified_at ? new Date(r.modified_at).toISOString() : null,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
    isFolder: false, // not persisted; folders detected on hot list path
  };
}
