/**
 * SharePoint-backed Job Codes source.
 *
 * Architecture (chosen 2026-05-20 by CTO): the canonical workbook
 * lives in SharePoint. We never edit codes inside Instinct — every
 * change happens in the source xlsx by finance/HR/CEO, and Instinct
 * reads via Microsoft Graph's app-only token + the Excel workbook API.
 *
 * Why the file is found by name + cached, not configured by ID:
 *   - The drive / item IDs would drift the moment finance renames a
 *     folder or restores from version history. The filename is the
 *     stable contract the team already maintains.
 *   - We discover the file once per refresh via /search/query, then
 *     fetch its workbook via /drives/{driveId}/items/{itemId}/...
 *     and stash the discovered IDs into the cache table so the next
 *     refresh can skip the search if those IDs still resolve.
 *
 * Returns a typed Result so call sites can distinguish "Graph is down,
 * serve stale" from "the workbook itself is empty" without `try/catch`.
 */

import { getAppOnlyToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import type {
  JobCode,
  JobCodesError,
  JobCodesFetchValue,
  Result,
} from "./types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/* Source-discovery hierarchy (most reliable first):
 *   1. JOB_CODES_SHARE_URL — full SharePoint URL of the workbook. We
 *      decode it via Graph's /shares/{id}/driveItem endpoint, which
 *      works cleanly with the app-only Sites.Read.All Application
 *      permission. THIS IS THE PRODUCTION PATH on 2026-05-20 after
 *      /search/query app-only returned HTTP 401 for our tenant.
 *   2. Cache hint (source_drive_id + source_item_id from a previous
 *      successful refresh). Skips discovery entirely.
 *   3. JOB_CODES_SEARCH_QUERY filename search via /search/query.
 *      Last resort — many tenants reject app-only /search/query.
 */
export const JOB_CODES_SHARE_URL = process.env.JOB_CODES_SHARE_URL ?? "";

/* The filename pattern we search for (fallback only). Kept loose enough
   that "Wolfpack 2026 Job Codes.xlsx" and "Wolfpack_2026_Job Codes.xlsx"
   both match Graph search (which is keyword-based, not exact). */
export const JOB_CODES_FILE_QUERY = process.env.JOB_CODES_SEARCH_QUERY
  ?? "Wolfpack Job Codes filetype:xlsx";

/** Sheet name to read when the workbook has one. Fallback: first sheet. */
export const JOB_CODES_PREFERRED_SHEET = process.env.JOB_CODES_SHEET_NAME ?? "Job Codes";

/**
 * Encode a SharePoint URL for the Microsoft Graph /shares endpoint.
 * Per Microsoft docs: base64-encode the URL, trim trailing '=', replace
 * '/' with '_' and '+' with '-', then prepend "u!".
 * Exported for unit tests.
 */
export function encodeShareUrl(url: string): string {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  const urlSafe = b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${urlSafe}`;
}

interface GraphShareDriveItemResponse {
  id?: string;
  webUrl?: string;
  parentReference?: { driveId?: string };
}

interface GraphSearchResponse {
  value?: Array<{
    hitsContainers?: Array<{
      hits?: Array<{
        resource?: {
          name?: string;
          webUrl?: string;
          parentReference?: { driveId?: string };
          id?: string;
        };
      }>;
    }>;
  }>;
}

interface WorksheetListResponse {
  value?: Array<{ name?: string }>;
}

interface UsedRangeResponse {
  values?: Array<Array<string | number | boolean | null>>;
}

/* ───────────────────────────────────────────────────────────────────
   Graph access helpers — kept local so we can return precise typed
   errors instead of the lib/microsoft-graph.ts null-on-failure shape.
   ─────────────────────────────────────────────────────────────────── */

async function graphGet<T>(
  path: string,
  token: string,
): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    return {
      ok: false,
      error: { code: "graph_unavailable", detail: (err as Error).message },
    };
  }

  if (res.status === 403) {
    return {
      ok: false,
      error: { code: "graph_forbidden", detail: await safeText(res) },
    };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "60");
    return {
      ok: false,
      error: { code: "rate_limited", detail: "Graph 429", retryAfter },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: "graph_unavailable",
        detail: `HTTP ${res.status} ${await safeText(res)}`,
      },
    };
  }
  return { ok: true, value: (await res.json()) as T };
}

async function graphSearch<T>(
  query: string,
  token: string,
): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/search/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{ entityTypes: ["driveItem"], query: { queryString: query }, from: 0, size: 5 }],
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: { code: "graph_unavailable", detail: (err as Error).message },
    };
  }

  if (res.status === 403) {
    return {
      ok: false,
      error: { code: "graph_forbidden", detail: await safeText(res) },
    };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "60");
    return {
      ok: false,
      error: { code: "rate_limited", detail: "Graph 429 on /search", retryAfter },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: "graph_unavailable",
        detail: `HTTP ${res.status} ${await safeText(res)}`,
      },
    };
  }
  return { ok: true, value: (await res.json()) as T };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "<no-body>";
  }
}

/* ───────────────────────────────────────────────────────────────────
   Workbook parsing
   ─────────────────────────────────────────────────────────────────── */

/**
 * Read a usedRange `values` array and yield JobCode rows. Header row
 * is required; we tolerate variant spellings (Code/JobCode/Job Code,
 * Description/Desc/Name).
 *
 * Exported for unit testing so we can assert parser behavior on synthetic
 * inputs without spinning up a Graph mock.
 */
export function parseUsedRange(
  values: Array<Array<string | number | boolean | null>>,
  sheetName: string,
): JobCode[] {
  if (!Array.isArray(values) || values.length < 2) return [];

  const header = (values[0] ?? []).map((v) => String(v ?? "").trim().toLowerCase());
  const codeIdx = header.findIndex((h) => h === "code" || h === "jobcode" || h === "job code" || h === "job_code");
  const descIdx = header.findIndex(
    (h) => h === "description" || h === "desc" || h === "name" || h === "title",
  );
  if (codeIdx < 0) return [];

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const rows: JobCode[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const code = String(row[codeIdx] ?? "").trim();
    if (!code) continue;
    const lower = code.toLowerCase();
    if (seen.has(lower)) continue; // workbook duplicates collapse to first
    seen.add(lower);
    const description = descIdx >= 0 ? String(row[descIdx] ?? "").trim() : "";
    rows.push({
      code,
      description,
      sheetName,
      active: true,
      lastSeenAt: now,
    });
  }
  return rows;
}

/* ───────────────────────────────────────────────────────────────────
   Public entrypoint
   ─────────────────────────────────────────────────────────────────── */

/**
 * Discover the source workbook in SharePoint, read its preferred sheet,
 * and return the parsed JobCode rows.
 *
 * When a hint `{driveId, itemId}` is provided (the cache table stashes
 * the last-known IDs), skip the search and go straight to the workbook —
 * Graph search costs a hop AND can return stale results when the user
 * just uploaded a new version.
 */
export interface FetchOptions {
  hint?: { driveId: string; itemId: string };
}

export async function fetchJobCodesFromSharePoint(
  opts: FetchOptions = {},
): Promise<Result<JobCodesFetchValue>> {
  const token = await getAppOnlyToken();
  if (!token) {
    return {
      ok: false,
      error: {
        code: "not_configured",
        detail: "no app-only Graph token (check MS_CLIENT_ID/SECRET/TENANT)",
      },
    };
  }

  // Step 1 — locate the workbook (or trust the hint).
  let driveId: string;
  let itemId: string;
  let webUrl = "";

  if (opts.hint) {
    driveId = opts.hint.driveId;
    itemId = opts.hint.itemId;
  } else if (JOB_CODES_SHARE_URL) {
    /* Production path: decode the configured SharePoint URL via Graph's
       /shares endpoint. Works with app-only Sites.Read.All — unlike
       /search/query which our tenant rejects (HTTP 401) for app-only
       auth even with the same scope. */
    const encoded = encodeShareUrl(JOB_CODES_SHARE_URL);
    const shareRes = await graphGet<GraphShareDriveItemResponse>(
      `shares/${encodeURIComponent(encoded)}/driveItem`,
      token,
    );
    if (!shareRes.ok) {
      /* 404 from /shares means the URL is wrong or the app can't see it
         — surface as source_file_not_found so the page shows a clear
         "check JOB_CODES_SHARE_URL" rather than a generic Graph error. */
      if (shareRes.error.code === "graph_unavailable" && shareRes.error.detail.startsWith("HTTP 404")) {
        return {
          ok: false,
          error: {
            code: "source_file_not_found",
            detail: `JOB_CODES_SHARE_URL "${JOB_CODES_SHARE_URL}" did not resolve to a SharePoint item (HTTP 404)`,
          },
        };
      }
      return shareRes;
    }
    if (!shareRes.value.id || !shareRes.value.parentReference?.driveId) {
      return {
        ok: false,
        error: {
          code: "source_file_not_found",
          detail: "share URL resolved but driveItem is missing driveId/id",
        },
      };
    }
    driveId = shareRes.value.parentReference.driveId;
    itemId = shareRes.value.id;
    webUrl = shareRes.value.webUrl ?? JOB_CODES_SHARE_URL;
  } else {
    const search = await graphSearch<GraphSearchResponse>(JOB_CODES_FILE_QUERY, token);
    if (!search.ok) return search;
    const hits =
      search.value?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    const first = hits.find(
      (h) => h.resource?.parentReference?.driveId && h.resource?.id,
    );
    if (!first?.resource) {
      return {
        ok: false,
        error: {
          code: "source_file_not_found",
          detail: `no SharePoint xlsx matched query "${JOB_CODES_FILE_QUERY}"`,
        },
      };
    }
    driveId = first.resource.parentReference!.driveId!;
    itemId = first.resource.id!;
    webUrl = first.resource.webUrl ?? "";
  }

  // Step 2 — list worksheets, pick the preferred sheet (or first).
  const sheetsRes = await graphGet<WorksheetListResponse>(
    `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook/worksheets`,
    token,
  );
  if (!sheetsRes.ok) {
    /* The hint may have gone stale (file moved/renamed). Surface
       source_file_not_found so the resolver can decide to retry the
       search path. */
    if (sheetsRes.error.code === "graph_unavailable" && sheetsRes.error.detail.startsWith("HTTP 404")) {
      return {
        ok: false,
        error: { code: "source_file_not_found", detail: sheetsRes.error.detail },
      };
    }
    return sheetsRes;
  }
  const sheetNames = (sheetsRes.value.value ?? [])
    .map((s) => s.name ?? "")
    .filter((n) => n.length > 0);
  if (sheetNames.length === 0) {
    return {
      ok: false,
      error: { code: "no_codes_found", detail: "workbook has no worksheets" },
    };
  }
  const sheetName =
    sheetNames.find(
      (n) => n.toLowerCase() === JOB_CODES_PREFERRED_SHEET.toLowerCase(),
    ) ?? sheetNames[0];

  // Step 3 — pull the used range as values[][].
  const usedRes = await graphGet<UsedRangeResponse>(
    `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange(valuesOnly=true)?$select=values`,
    token,
  );
  if (!usedRes.ok) return usedRes;

  const rows = parseUsedRange(usedRes.value.values ?? [], sheetName);
  if (rows.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_codes_found",
        detail: `parser found no rows in sheet "${sheetName}"`,
      },
    };
  }

  // Best-effort source-fetch telemetry — gives us a learning signal on
  // refresh frequency / failure rate without coupling failures to
  // analytics availability. trackEvent returns void in some mocks so we
  // try/catch instead of chaining .catch on a possibly-undefined value.
  try {
    await trackEvent("jobcodes.source_fetched", "system", "system", {
      sheet_name: sheetName,
      rows_seen: rows.length,
      drive_id: driveId,
      item_id: itemId,
      used_hint: opts.hint ? "true" : "false",
    });
  } catch {
    /* analytics is best-effort; never block the refresh */
  }

  return {
    ok: true,
    value: {
      rows,
      driveId,
      itemId,
      webUrl,
      sheetName,
    },
  };
}
