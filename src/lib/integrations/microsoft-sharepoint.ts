/**
 * Microsoft 365 SharePoint integration (Sites.Read.All / Files.Read.All).
 *
 * Built to feed the Wolfpack Instinct `/assistant` context resolver: when a
 * user asks the LLM something, we call `searchSharePoint` to find the
 * documents the user has access to, then optionally pull a small slice of
 * file text via `getSharePointFileText` to inject as grounded context.
 *
 * Design rules (mirrors microsoft-mail.ts):
 *   - All Graph access goes through the existing OAuth + token helper
 *     (`getValidToken`); callers pass the resolved access token directly.
 *   - Never throws on an expected Graph failure. Returns a typed Result so
 *     callers can surface scope_missing (403), rate_limited (429), or
 *     not_connected (401) distinctly. Unexpected failures are logged and
 *     returned as `internal`.
 *   - Privacy: the token MUST be the calling user's token (delegated). We
 *     surface only what THAT user has access to — never service-principal
 *     content. Caching SharePoint hits across users is forbidden; per-user
 *     per-question caching is fine.
 *
 * Graph surface used:
 *   POST /search/query     — query across driveItems / listItems / sites
 *   GET  /drives/{id}/items/{id}/content — first 8KB of a file's content
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { trackEvent } from "@/lib/analytics";
import { buildSearchQueryString } from "@/lib/integrations/microsoft-search-keywords";

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------

export type SharePointErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "invalid_input"
  | "graph_error"
  | "internal";

export interface SharePointErrorResult {
  ok: false;
  code: SharePointErrorCode;
  scope?: string;
  retryAfter?: number;
  status?: number;
  message?: string;
}

export interface SharePointOkResult<T> {
  ok: true;
  value: T;
}

export type Result<T> = SharePointOkResult<T> | SharePointErrorResult;

// ---------------------------------------------------------------------------
// Public hit shape (also exported from context-resolver re-export)
// ---------------------------------------------------------------------------

export interface SharePointSearchHit {
  /** Document or page title; falls back to the file name. */
  title: string;
  /** Direct SharePoint URL (webUrl on the underlying resource). */
  url: string;
  /** ~200 char excerpt suitable for prompt injection. Plain text only. */
  snippet: string;
  /** ISO timestamp; "" if Graph didn't return one. */
  modifiedAt: string;
  /** What kind of resource this is — used to pick the rendering format. */
  source_kind: "sharepoint_doc" | "sharepoint_page" | "sharepoint_list_item";
  /**
   * driveItem id (only for `sharepoint_doc` hits) so callers can request
   * the file text via `getSharePointFileText`. Always paired with `driveId`
   * — callers should not split them.
   */
  driveItemId?: string;
  /** parent drive id (paired with `driveItemId`). */
  driveId?: string;
}

export interface SharePointSearchResult {
  hits: SharePointSearchHit[];
  total: number;
  took_ms: number;
  /**
   * Final keyword string sent to Graph as `query.queryString`. Surfaced so
   * the diagnostic page (and integration tests) can assert exactly what
   * was searched. Often differs from the user's verbatim question because
   * `buildSearchQueryString` strips natural-language filler.
   */
  query_string_sent: string;
}

export interface SharePointFileText {
  text: string;
  /** True when the file content was longer than the byte cap. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** Max file bytes we materialize for prompt injection (8 KiB). */
const FILE_TEXT_BYTE_CAP = 8 * 1024;
/** Snippet we keep in each search hit. */
const SNIPPET_MAX = 200;
/** Default + cap for /search/query result count. */
const DEFAULT_TOP_N = 10;
const TOP_N_CAP = 25;

const SCOPE_SITES_READ = "Sites.Read.All";
const SCOPE_FILES_READ = "Files.Read.All";

// ---------------------------------------------------------------------------
// Internal Graph helpers — typed wrappers over fetch.
// (We do NOT reuse microsoft-mail's helpers verbatim because they are file-
// scoped there; rather we mirror the same shape so the contract is identical.)
// ---------------------------------------------------------------------------

interface GraphCallSuccess<T> {
  ok: true;
  status: number;
  data: T | null;
}

interface GraphCallError {
  ok: false;
  status: number;
  code: SharePointErrorCode;
  scope?: string;
  retryAfter?: number;
  message: string;
}

async function safeJson(res: Response): Promise<any | null> {
  try { return await res.json(); } catch { return null; }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function classify403(body: any, fallbackScope: string): { code: SharePointErrorCode; scope?: string; message: string } {
  const errCode = body?.error?.code || body?.error?.innerError?.code || "";
  const errMsg = body?.error?.message || "forbidden";
  const isScope =
    /AccessDenied/i.test(String(errCode)) ||
    /Authorization_RequestDenied/i.test(String(errCode)) ||
    /scope/i.test(errMsg) ||
    /permission/i.test(errMsg);
  if (isScope) return { code: "scope_missing", scope: fallbackScope, message: errMsg };
  return { code: "graph_error", message: errMsg };
}

async function graphPost<T>(
  endpoint: string,
  accessToken: string,
  body: unknown,
  expectedScope: string,
): Promise<GraphCallSuccess<T> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, code: "internal", message: `network_error: ${(err as Error).message}` };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 1,
      message: "rate_limited",
    };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 403) {
    const b = await safeJson(res);
    const c = classify403(b, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (!res.ok) {
    const t = await safeText(res);
    return { ok: false, status: res.status, code: "graph_error", message: `graph_${res.status}: ${t.slice(0, 200)}` };
  }
  const data = (await safeJson(res)) as T | null;
  return { ok: true, status: res.status, data };
}

async function graphGetBytes(
  endpoint: string,
  accessToken: string,
  byteCap: number,
  expectedScope: string,
): Promise<GraphCallSuccess<{ bytes: ArrayBuffer; truncated: boolean }> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // Ask Graph to bound the response. Many drive-item content endpoints
        // honor Range; for ones that don't we still re-truncate locally.
        Range: `bytes=0-${byteCap - 1}`,
        Accept: "*/*",
      },
    });
  } catch (err) {
    return { ok: false, status: 0, code: "internal", message: `network_error: ${(err as Error).message}` };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 1,
      message: "rate_limited",
    };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 403) {
    const b = await safeJson(res);
    const c = classify403(b, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: "graph_error", message: "not_found" };
  }
  // 206 Partial Content is success.
  if (!res.ok && res.status !== 206) {
    const t = await safeText(res);
    return { ok: false, status: res.status, code: "graph_error", message: `graph_${res.status}: ${t.slice(0, 200)}` };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (err) {
    return { ok: false, status: res.status, code: "internal", message: `read_failed: ${(err as Error).message}` };
  }
  // Whether server honored Range or not, hard-cap the byte count we keep.
  const truncated =
    res.status === 206 ||
    (res.headers.get("Content-Range") !== null) ||
    bytes.byteLength > byteCap;

  if (bytes.byteLength > byteCap) {
    bytes = bytes.slice(0, byteCap);
  }
  return { ok: true, status: res.status, data: { bytes, truncated } };
}

// ---------------------------------------------------------------------------
// Hit normalization
// ---------------------------------------------------------------------------

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function clipSnippet(raw: string | null | undefined, max = SNIPPET_MAX): string {
  const s = stripHtml(String(raw ?? ""));
  return s.length > max ? s.slice(0, max) : s;
}

interface RawGraphHit {
  hitId?: string;
  rank?: number;
  summary?: string;
  resource?: {
    id?: string;
    name?: string;
    title?: string;
    displayName?: string;
    webUrl?: string;
    lastModifiedDateTime?: string;
    "@odata.type"?: string;
    parentReference?: {
      driveId?: string;
      siteId?: string;
    };
  };
}

interface RawGraphSearchResponse {
  value?: Array<{
    hitsContainers?: Array<{
      hits?: RawGraphHit[];
      total?: number;
    }>;
  }>;
}

function classifyResource(odataType: string | undefined): SharePointSearchHit["source_kind"] {
  const t = String(odataType || "").toLowerCase();
  if (t.includes("driveitem")) return "sharepoint_doc";
  if (t.includes("listitem")) return "sharepoint_list_item";
  // Pages / sites / anything else — render as a page.
  return "sharepoint_page";
}

const OFFICE_EXTENSIONS = [
  ".docx", ".doc", ".docm",
  ".xlsx", ".xls", ".xlsm", ".csv",
  ".pptx", ".ppt", ".pptm",
];

/**
 * Convert a raw Graph webUrl into a URL that opens in the SharePoint /
 * OneDrive online viewer rather than triggering a download.
 *
 * Without `?web=1`, Office document URLs from Graph often serve the
 * file with `Content-Disposition: attachment`, so the browser
 * downloads the .docx / .xlsx / .pptx instead of rendering it in
 * Word / Excel / PowerPoint Online. The user reported this in
 * production today: every "related document" link saved to disk.
 *
 * Rule:
 *   * Office formats (Word/Excel/PowerPoint variants + CSV) → append
 *     `web=1` so SharePoint loads the online viewer.
 *   * Everything else (PDFs, images, .txt, .md, page links) → leave
 *     the URL untouched. SharePoint already renders these inline.
 *   * Already-parameterized URLs are preserved (`&web=1` instead of
 *     `?web=1`).
 */
export function toWebViewerUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  let withoutHash = rawUrl;
  let hash = "";
  const hashIdx = rawUrl.indexOf("#");
  if (hashIdx >= 0) {
    withoutHash = rawUrl.slice(0, hashIdx);
    hash = rawUrl.slice(hashIdx);
  }
  const lower = withoutHash.toLowerCase();
  // Trim any trailing query for the extension check; we only care about
  // the path's actual file ext, not "?download=1".
  const pathPart = lower.split("?")[0];
  const isOffice = OFFICE_EXTENSIONS.some((ext) => pathPart.endsWith(ext));
  if (!isOffice) return rawUrl;
  if (/[?&]web=1\b/i.test(withoutHash)) return rawUrl;
  const sep = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${sep}web=1${hash}`;
}

/**
 * Map a raw Graph hit into our normalized hit shape. Exported via __internal
 * so tests can exercise the mapping directly without going through fetch.
 */
function normalizeHit(hit: RawGraphHit): SharePointSearchHit | null {
  const r = hit?.resource;
  if (!r) return null;
  const rawUrl = r.webUrl ?? "";
  if (!rawUrl) return null;
  const url = toWebViewerUrl(rawUrl);
  const title = r.name ?? r.title ?? r.displayName ?? "(untitled)";
  const snippet = clipSnippet(hit.summary ?? "");
  const kind = classifyResource(r["@odata.type"]);
  const driveItemId = kind === "sharepoint_doc" ? r.id : undefined;
  const driveId = kind === "sharepoint_doc" ? r.parentReference?.driveId : undefined;
  return {
    title,
    url,
    snippet,
    modifiedAt: r.lastModifiedDateTime ?? "",
    source_kind: kind,
    ...(driveItemId ? { driveItemId } : {}),
    ...(driveId ? { driveId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API: searchSharePoint
// ---------------------------------------------------------------------------

export interface SearchSharePointOptions {
  query: string;
  /** Hit count cap. Defaults to 10, max 25. */
  topN?: number;
  /** Optional Graph site id to scope the search (`{tenant}.sharepoint.com,{guid},{guid}`). */
  siteId?: string;
}

/**
 * Search across SharePoint via Graph's /search/query endpoint.
 *
 * Uses entityTypes ["driveItem","listItem","site"] which is the cleanest
 * cross-surface query — covers documents, list items (e.g. SharePoint
 * pages, custom lists) and sites without three separate calls.
 *
 * Graph's /search/query is delegated-only (it always runs as the calling
 * user) so the result set is automatically scoped to what the user can see.
 *
 * Returns a typed Result. On 403 returns `scope_missing` with `Sites.Read.All`
 * — the assistant UI can use that to prompt for a Microsoft 365 reconnect.
 */
export async function searchSharePoint(
  token: string,
  opts: SearchSharePointOptions,
): Promise<Result<SharePointSearchResult>> {
  const t0 = Date.now();
  const q = String(opts?.query ?? "").trim();
  if (!q) {
    return { ok: false, code: "invalid_input", message: "query required" };
  }
  if (!token || typeof token !== "string") {
    return { ok: false, code: "not_connected", message: "missing_token" };
  }
  const requested = Number.isFinite(opts.topN) ? Number(opts.topN) : DEFAULT_TOP_N;
  const topN = Math.min(Math.max(requested, 1), TOP_N_CAP);

  /* Build a Graph KQL query string. Microsoft's /search/query is keyword/
     phrase based; passing a verbatim user question like
       "What's in the TWA Agenda 4.20 doc?"
     against a doc named TWA_Agenda_4.20.docx returns 0 hits. Extract the
     load-bearing tokens first so Graph can actually find the document.
     See: src/lib/integrations/microsoft-search-keywords.ts */
  const keywordQuery = buildSearchQueryString(q);
  const queryString = opts.siteId
    ? `${keywordQuery} site:"${opts.siteId.replace(/"/g, "")}"`
    : keywordQuery;

  const body = {
    requests: [
      {
        entityTypes: ["driveItem", "listItem", "site"],
        query: { queryString },
        from: 0,
        size: topN,
      },
    ],
  };

  const res = await graphPost<RawGraphSearchResponse>(
    "search/query",
    token,
    body,
    SCOPE_SITES_READ,
  );

  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope ?? (res.code === "scope_missing" ? SCOPE_SITES_READ : undefined),
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const containers = res.data?.value?.[0]?.hitsContainers ?? [];
  const rawHits: RawGraphHit[] = [];
  let total = 0;
  for (const c of containers) {
    if (Array.isArray(c.hits)) rawHits.push(...c.hits);
    if (typeof c.total === "number") total += c.total;
  }
  const hits = rawHits
    .map(normalizeHit)
    .filter((h): h is SharePointSearchHit => h !== null)
    .slice(0, topN);

  // If Graph didn't surface a `total`, fall back to the visible hit count
  // so the caller can still tell whether there were any results.
  if (!total) total = hits.length;

  return {
    ok: true,
    value: { hits, total, took_ms: Date.now() - t0, query_string_sent: queryString },
  };
}

// ---------------------------------------------------------------------------
// Public API: getSharePointFileText
// ---------------------------------------------------------------------------

/**
 * Pull the first 8 KiB of a SharePoint file as plain text. We use this to
 * enrich a search-hit snippet for the LLM prompt when the user's question
 * looks like it's grounded in a specific document the search surfaced.
 *
 * Graph's /drives/{id}/items/{id}/content endpoint streams the file as-is.
 * We send a Range header to bound the byte cost; servers that ignore Range
 * still get re-clipped client-side.
 *
 * Decoded as UTF-8 with `fatal: false` so binary files (PDF, .docx) yield
 * readable-but-noisy text rather than throwing — the caller decides if the
 * snippet is useful. (Office 365 documents are zipped XML; the first 8 KiB
 * of a .docx is the manifest, which the LLM gracefully ignores.)
 */
export async function getSharePointFileText(
  token: string,
  driveId: string,
  itemId: string,
): Promise<Result<SharePointFileText>> {
  if (!token) return { ok: false, code: "not_connected", message: "missing_token" };
  const cleanDrive = String(driveId || "").trim();
  const cleanItem = String(itemId || "").trim();
  if (!cleanDrive || !cleanItem) {
    return { ok: false, code: "invalid_input", message: "drive_and_item_required" };
  }

  const path = `drives/${encodeURIComponent(cleanDrive)}/items/${encodeURIComponent(cleanItem)}/content`;
  const res = await graphGetBytes(path, token, FILE_TEXT_BYTE_CAP, SCOPE_FILES_READ);
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope ?? (res.code === "scope_missing" ? SCOPE_FILES_READ : undefined),
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  const { bytes, truncated } = res.data!;
  // Decode best-effort. fatal:false means invalid UTF-8 sequences become
  // U+FFFD instead of throwing — exactly what we want for prompt context.
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    // TextDecoder fatal:false should never throw, but guard anyway.
    text = "";
  }
  // Strip control characters so the text is safe to paste into a prompt.
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");
  return { ok: true, value: { text, truncated } };
}

// ---------------------------------------------------------------------------
// Analytics helper — exported so context-resolver can fire
// `assistant.sharepoint_lookup_failed` with consistent shape.
// ---------------------------------------------------------------------------

export function trackSharePointLookupFailure(
  userId: string,
  role: string,
  error: SharePointErrorResult,
): void {
  trackEvent("assistant.sharepoint_lookup_failed", userId, role, {
    status: error.status ?? 0,
    scope_missing: error.code === "scope_missing",
    code: error.code,
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  normalizeHit,
  classifyResource,
  clipSnippet,
  FILE_TEXT_BYTE_CAP,
  SNIPPET_MAX,
  TOP_N_CAP,
  SCOPE_SITES_READ,
  SCOPE_FILES_READ,
};
