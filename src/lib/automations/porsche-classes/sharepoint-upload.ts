/**
 * SharePoint upload module for the porsche-classes automation.
 *
 * Alicia's manual workflow today: download a class summary PDF / DOCX from
 * Instinct → drop it into the PCNA SharePoint folder so PCNA stakeholders
 * can read it. This module automates the drop step by PUTting the bytes
 * directly to the configured SharePoint drive folder via Microsoft Graph.
 *
 * Configuration (env, all required for live mode):
 *   INSTINCT_SHAREPOINT_SITE_ID
 *     Graph site identifier — the comma-joined triple Graph returns from
 *     /sites/{hostname}:/{path}, e.g.
 *       "contoso.sharepoint.com,abc123-...,def456-..."
 *   INSTINCT_SHAREPOINT_DRIVE_ID
 *     Drive (document library) identifier within the site.
 *   INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH
 *     Folder path inside the drive (NO leading or trailing slashes), e.g.
 *       "PCNA Brand Ambassador/2026 Brand Ambassador/Class Summaries"
 *
 * Auth: reuses `getValidToken` from `@/lib/microsoft-graph`. We try the
 * caller's Instinct user.id first and fall back to the user's email — same
 * dual-anchor pattern as the meeting-insights live-pull poller. This keeps
 * the upload working even when the Instinct user record was renamed /
 * recreated since they connected Microsoft.
 *
 * Failure semantics: NEVER throws. Every error path returns a structured
 * `{ ok: false, error, skipped_reason? }` so the calling route can return
 * 4xx/5xx without try/catch wrapping. Skipped reasons:
 *   - "not_configured" — env vars missing; treat as "feature off"
 *   - "no_token"       — user has no Microsoft connection
 *   - "graph_error"    — Graph rejected the upload (auth, scope, 5xx, etc.)
 *
 * Analytics: caller is responsible for emitting the
 * `automations.sharepoint_upload_*` event so this module stays a pure I/O
 * helper. (We don't have a tenant id or a class_key here — the route does.)
 *
 * Graph endpoint used:
 *   PUT https://graph.microsoft.com/v1.0/sites/{siteId}/drives/{driveId}
 *       /root:/{folderPath}/{filename}:/content
 *
 * The :/{path}:/content path-resolution form is the documented way to
 * upload by folder path without first looking up a folder id. Files up to
 * ~4 MiB go in a single PUT — class summary docx files are ~30-100 KiB so
 * this is well within bounds. Larger files would need an upload session;
 * not implemented here because the docx renderer caps well below 4 MiB.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import { getSharepointConfig } from "./config-repo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadClassSummaryArgs {
  /** Instinct user id (preferred token anchor). */
  userId: string;
  /** Optional fall-back anchor — the user's email/UPN. The dual-anchor
   *  lookup in `getValidToken` already accepts either, but we pass it
   *  explicitly when it differs so the route doesn't have to know
   *  about the fallback ordering. */
  userEmail?: string | null;
  /** File name SharePoint will assign — should include extension. */
  filename: string;
  /** Bytes to upload. */
  bytes: Buffer;
  /** Content-Type header value (e.g. application/vnd.openxmlformats-...). */
  contentType: string;
}

export type UploadSkippedReason = "not_configured" | "no_token" | "graph_error";

export type UploadClassSummaryResult =
  | { ok: true; web_url: string; item_id: string | null }
  | {
      ok: false;
      error: string;
      skipped_reason?: UploadSkippedReason;
      status?: number;
    };

interface SharepointConfig {
  siteId: string;
  driveId: string;
  folderPath: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the SharePoint destination. Prefers the operator-managed row
 * in `instinct_automation_porsche_config` (written via the wizard at
 * `/automations/porsche-classes/setup`); falls back to the legacy env
 * vars when no config row exists. Returns null when neither yields a
 * complete (site_id + drive_id + folder_path) triple — the caller
 * surfaces `skipped_reason: "not_configured"`.
 *
 * Trims whitespace because Vercel env vars have a documented history of
 * silently appending trailing newlines (see feedback memory note
 * `feedback_vercel_env_trailing_newline`). A trailing `\n` in the site
 * id would make every Graph call 404. Trim everywhere.
 *
 * Async: reads from the DB (config-repo) first. The route layer already
 * handles async; the only sync caller in tests is `buildUploadUrl` which
 * takes the resolved config directly and is unaffected.
 */
async function loadConfig(): Promise<SharepointConfig | null> {
  /* Tier 1: operator-managed config row. */
  try {
    const dbConfig = await getSharepointConfig();
    if (dbConfig) {
      return {
        siteId: dbConfig.site_id,
        driveId: dbConfig.drive_id,
        folderPath: dbConfig.path,
      };
    }
  } catch (err) {
    /* Tier 1 fall-through is safe — env vars are the documented
       fallback. Log so a config-repo outage shows up in observability. */
    console.warn(
      `[sharepoint-upload] config-repo lookup failed, falling back to env: ${(err as Error).message}`,
    );
  }

  /* Tier 2: legacy env vars (pre-wizard deployments). */
  const siteId = (process.env.INSTINCT_SHAREPOINT_SITE_ID || "").trim();
  const driveId = (process.env.INSTINCT_SHAREPOINT_DRIVE_ID || "").trim();
  const folderPathRaw = (
    process.env.INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH || ""
  ).trim();
  if (!siteId || !driveId || !folderPathRaw) return null;
  // Strip leading/trailing slashes so the joined URL has exactly one.
  const folderPath = folderPathRaw.replace(/^\/+|\/+$/g, "");
  if (!folderPath) return null;
  return { siteId, driveId, folderPath };
}

/**
 * Encode each path segment but preserve the `/` separators between them.
 * SharePoint folder names regularly contain spaces and apostrophes — both
 * must be percent-encoded for Graph, but `/` must remain literal.
 */
function encodeFolderPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Build the canonical Graph PUT URL for a given filename. Exported via
 * `buildUploadUrl` for tests + observability — the route layer does NOT
 * need to construct the URL itself.
 */
export function buildUploadUrl(
  config: SharepointConfig,
  filename: string,
): string {
  const folder = encodeFolderPath(config.folderPath);
  const file = encodeURIComponent(filename);
  // Path-addressing form: /sites/{site}/drives/{drive}/root:/{folder}/{name}:/content
  return (
    `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(config.siteId)}` +
    `/drives/${encodeURIComponent(config.driveId)}` +
    `/root:/${folder}/${file}:/content`
  );
}

/**
 * Resolve a Graph access token. Tries `userId` first (Instinct user.id —
 * the original anchor stored as `connected_by`), then falls back to
 * `userEmail` if provided and different. Returns null when neither yields
 * a token.
 */
async function resolveToken(
  userId: string,
  userEmail?: string | null,
): Promise<string | null> {
  const tok = await getValidToken(userId);
  if (tok) return tok.accessToken;
  if (userEmail && userEmail !== userId) {
    const fallback = await getValidToken(userEmail);
    if (fallback) return fallback.accessToken;
  }
  return null;
}

/**
 * Pull a useful web_url from Graph's drive-item response. Graph returns
 * `webUrl` on a successful upload. We accept either spelling defensively
 * (the v1.0 endpoint uses `webUrl`; the beta endpoint historically used
 * `web_url`) so a docs change doesn't silently break this flow.
 */
function extractWebUrl(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.webUrl === "string") return obj.webUrl;
    if (typeof obj.web_url === "string") return obj.web_url;
  }
  return "";
}

/**
 * Pull the durable Graph item id from a drive-item response. Returned
 * separately from web_url so the audit log can store both — the item_id
 * is what the SharePoint DELETE undo path needs (web_url is a friendly
 * link that may not survive a rename).
 */
function extractItemId(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.id === "string") return obj.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a class summary file to the configured SharePoint folder.
 *
 * Never throws — every failure is surfaced as a structured result so the
 * caller can return a typed JSON response. This mirrors the contract in
 * `src/lib/integrations/microsoft-channel-messages.ts` (`asScopeMissing`)
 * and the `GraphClientError` codes in `src/lib/ms-graph/client.ts`.
 */
export async function uploadClassSummary(
  args: UploadClassSummaryArgs,
): Promise<UploadClassSummaryResult> {
  const { userId, userEmail, filename, bytes, contentType } = args;

  if (!filename || filename.includes("/") || filename.includes("\\")) {
    // SharePoint upload-by-path doesn't allow folder traversal in the
    // filename — reject early with a clear error.
    return {
      ok: false,
      error: `invalid filename: ${filename}`,
      skipped_reason: "graph_error",
    };
  }

  const config = await loadConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "SharePoint not configured — set INSTINCT_SHAREPOINT_SITE_ID, INSTINCT_SHAREPOINT_DRIVE_ID, INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH",
      skipped_reason: "not_configured",
    };
  }

  const accessToken = await resolveToken(userId, userEmail);
  if (!accessToken) {
    return {
      ok: false,
      error: `no Microsoft token for user ${userId}`,
      skipped_reason: "no_token",
    };
  }

  const url = buildUploadUrl(config, filename);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
      },
      // BodyInit (lib.dom) doesn't include Node Buffer or Uint8Array as
      // a named type, even though both work at runtime under Node 20's
      // undici fetch. Wrap in a Blob — Blob IS in BodyInit and Node 20
      // supports it natively (no extra dep). Same byte payload, same
      // upload semantics; SharePoint sees the raw octets via Content-Type.
      body: new Blob([new Uint8Array(bytes)], { type: contentType }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error during SharePoint upload: ${(err as Error).message}`,
      skipped_reason: "graph_error",
    };
  }

  if (res.status === 200 || res.status === 201) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const webUrl = extractWebUrl(payload);
    const itemId = extractItemId(payload);
    return { ok: true, web_url: webUrl, item_id: itemId };
  }

  // Non-2xx — read body for diagnostic, classify into skipped_reason.
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return {
    ok: false,
    error: `SharePoint PUT ${res.status}: ${body.slice(0, 500)}`,
    skipped_reason: "graph_error",
    status: res.status,
  };
}
