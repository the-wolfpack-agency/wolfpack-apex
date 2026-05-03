/**
 * Microsoft OneNote integration.
 *
 * Graph surface:
 *   GET  /me/onenote/notebooks
 *   GET  /me/onenote/sections
 *   GET  /me/onenote/pages
 *   GET  /me/onenote/pages/{id}/content
 *   POST /me/onenote/sections/{id}/pages
 *
 * Notebooks + sections are fetched live (rarely change). Pages are cached
 * in `instinct_onenote_pages` so dashboard + Assistant RAG reads never
 * hit Graph on the hot path.
 *
 * Newly created pages are upserted into the cache AND indexed into the
 * Assistant RAG via `@/lib/learning/ms-content-ingest` so the agent can
 * immediately answer questions about what the user just wrote down.
 *
 * 403 → asScopeMissing() for typed `scope_missing` results.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken } from "@/lib/microsoft-graph";
import { htmlToText } from "@/lib/html-sanitize";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { indexOneNotePage } from "@/lib/learning/ms-content-ingest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Notebook {
  id: string;
  displayName: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  isDefault?: boolean;
}

export interface Section {
  id: string;
  displayName: string;
  notebookId?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

export interface OneNotePage {
  id: string; // local UUID
  msPageId: string;
  userId: string;
  msNotebookId: string | null;
  msSectionId: string | null;
  title: string;
  preview: string;
  createdAt: string;
  modifiedAt: string;
  contentUrl: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface ListPagesOpts {
  top?: number;
  cursor?: string; // Graph @odata.nextLink
}

export interface CreatePageInput {
  title: string;
  html: string;
}

export interface SyncRecentOpts {
  top?: number;
}

export interface SyncRecentResult {
  pageCount: number;
  durationMs: number;
}

export type ScopeMissingError = {
  ok: false;
  code: "scope_missing";
  scope: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OneNoteError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "OneNoteError";
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_RETRY_AFTER_MS = 60 * 1000;

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new OneNoteError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

async function graphCall<T = unknown>(
  method: "GET" | "POST",
  endpoint: string,
  accessToken: string,
  init: { body?: string; contentType?: string; responseType?: "json" | "text" } = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: init.responseType === "text" ? "text/html" : "application/json",
  };
  if (init.contentType) headers["Content-Type"] = init.contentType;

  const res = await fetch(url, { method, headers, body: init.body });

  if (res.status === 429) {
    const raRaw = parseInt(res.headers.get("Retry-After") || "0", 10);
    const raMs = Math.min(
      Number.isFinite(raRaw) && raRaw > 0 ? raRaw * 1000 : 1000,
      MAX_RETRY_AFTER_MS,
    );
    await sleep(raMs);
    const retry = await fetch(url, { method, headers, body: init.body });
    if (!retry.ok) {
      throw new OneNoteError(
        retry.status,
        `Graph ${method} ${endpoint} failed after retry: ${retry.status}`,
        Math.ceil(raMs / 1000),
      );
    }
    return init.responseType === "text"
      ? ((await retry.text()) as unknown as T)
      : ((await retry.json()) as T);
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new OneNoteError(res.status, `Graph ${method} ${endpoint} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as unknown as T;
  return init.responseType === "text"
    ? ((await res.text()) as unknown as T)
    : ((await res.json()) as T);
}

// ---------------------------------------------------------------------------
// HTML preview helper — reuses the Teams HTML→text function when possible.
// Local copy so the OneNote module stays independent of the Teams module
// if one gets removed.
// ---------------------------------------------------------------------------

function htmlToPlain(html: string | null | undefined): string {
  if (!html) return "";
  // Parser-based HTML→text via @/lib/html-sanitize. Replaces a regex
  // strip flagged by CodeQL for double-escaping,
  // incomplete-multi-character-sanitization, polynomial-redos, and
  // bad-tag-filter.
  return htmlToText(String(html))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function previewFrom(html: string, title: string, max = 240): string {
  const plain = htmlToPlain(html);
  // Drop the title if it leads the content (OneNote pages often repeat it).
  const stripped = plain.startsWith(title) ? plain.slice(title.length).trim() : plain;
  return stripped.length > max ? stripped.slice(0, max - 1) + "\u2026" : stripped;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphPage {
  id: string;
  title?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  contentUrl?: string;
  "@odata.etag"?: string;
  parentNotebook?: { id?: string };
  parentSection?: { id?: string };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Cache upsert
// ---------------------------------------------------------------------------

async function upsertPage(
  userId: string,
  g: GraphPage,
  contentHtmlForPreview?: string,
): Promise<string> {
  const title = g.title || "(untitled)";
  const createdAt = g.createdDateTime
    ? new Date(g.createdDateTime).toISOString()
    : new Date().toISOString();
  const modifiedAt = g.lastModifiedDateTime
    ? new Date(g.lastModifiedDateTime).toISOString()
    : createdAt;
  const preview = contentHtmlForPreview ? previewFrom(contentHtmlForPreview, title) : "";

  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_onenote_pages
       (user_id, ms_page_id, ms_notebook_id, ms_section_id, title, preview,
        created_at, modified_at, content_url, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (user_id, ms_page_id) DO UPDATE SET
       ms_notebook_id = COALESCE(EXCLUDED.ms_notebook_id, instinct_onenote_pages.ms_notebook_id),
       ms_section_id = COALESCE(EXCLUDED.ms_section_id, instinct_onenote_pages.ms_section_id),
       title = EXCLUDED.title,
       preview = CASE WHEN EXCLUDED.preview <> '' THEN EXCLUDED.preview ELSE instinct_onenote_pages.preview END,
       modified_at = EXCLUDED.modified_at,
       content_url = EXCLUDED.content_url,
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id`,
    [
      userId,
      g.id,
      g.parentNotebook?.id ?? null,
      g.parentSection?.id ?? null,
      title,
      preview,
      createdAt,
      modifiedAt,
      g.contentUrl ?? null,
      g["@odata.etag"] ?? null,
    ],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listNotebooks(userId: string): Promise<Notebook[]> {
  const token = await resolveToken(userId);
  const res = await graphCall<{ value?: Notebook[] }>("GET", "me/onenote/notebooks", token);
  trackEvent("system.ms_onenote_notebook_listed", userId, "system", {
    count: res.value?.length ?? 0,
  });
  return res.value ?? [];
}

export async function listSections(userId: string, notebookId: string): Promise<Section[]> {
  const token = await resolveToken(userId);
  const endpoint = notebookId
    ? `me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections`
    : `me/onenote/sections`;
  const res = await graphCall<{ value?: Section[] }>("GET", endpoint, token);
  return (res.value ?? []).map((s) => ({ ...s, notebookId: notebookId || s.notebookId }));
}

/**
 * List pages — fetches from Graph, upserts into cache, returns shells.
 * Optional sectionId filter keeps the round-trip small.
 */
export async function listPages(
  userId: string,
  sectionId?: string,
  opts: ListPagesOpts = {},
): Promise<{ pages: GraphPage[]; nextCursor?: string }> {
  const token = await resolveToken(userId);
  const top = Math.min(Math.max(opts.top ?? 50, 1), 100);
  const endpoint =
    opts.cursor ??
    (sectionId
      ? `me/onenote/sections/${encodeURIComponent(sectionId)}/pages?$top=${top}&$orderby=lastModifiedDateTime desc`
      : `me/onenote/pages?$top=${top}&$orderby=lastModifiedDateTime desc`);

  const res = await graphCall<{ value?: GraphPage[]; "@odata.nextLink"?: string }>(
    "GET",
    endpoint,
    token,
  );

  const pages = res.value ?? [];
  // Best-effort cache warming — shells only (no content fetch here).
  for (const g of pages) {
    try {
      await upsertPage(userId, g);
    } catch {
      // Cache warming is best-effort.
    }
  }

  return { pages, nextCursor: res["@odata.nextLink"] };
}

/**
 * Fetch a page's HTML content. Emits `system.ms_onenote_page_viewed`.
 */
export async function getPageContent(userId: string, pageId: string): Promise<string> {
  const token = await resolveToken(userId);
  const html = await graphCall<string>(
    "GET",
    `me/onenote/pages/${encodeURIComponent(pageId)}/content`,
    token,
    { responseType: "text" },
  );
  trackEvent("system.ms_onenote_page_viewed", userId, "system", {
    ms_page_id: pageId,
  });
  return html;
}

/**
 * Create a page in a OneNote section. Builds the Graph-required HTML
 * envelope from `title + html`, upserts the returned page into the cache,
 * writes an audit entry, and indexes the page into the Assistant RAG.
 */
export async function createPage(
  userId: string,
  sectionId: string,
  input: CreatePageInput,
): Promise<{ id: string; webUrl?: string }> {
  const token = await resolveToken(userId);
  const safeTitle = (input.title || "Untitled").replace(/</g, "&lt;");
  const envelope = `<!DOCTYPE html>
<html>
  <head><title>${safeTitle}</title></head>
  <body>${input.html ?? ""}</body>
</html>`;

  const created = await graphCall<GraphPage & { links?: { oneNoteWebUrl?: { href?: string } } }>(
    "POST",
    `me/onenote/sections/${encodeURIComponent(sectionId)}/pages`,
    token,
    { body: envelope, contentType: "application/xhtml+xml" },
  );

  // Cache it (preview from the html the caller supplied — already rendered).
  try {
    await upsertPage(userId, created, input.html);
  } catch {
    // Do not block on cache failure — Graph is the source of truth.
  }

  // Audit — createPage is a mutation so we record who/what/when.
  try {
    await recordAudit({
      actor: { user_id: userId, role: "system" },
      action: "onenote.page_created",
      resourceType: "onenote_page",
      resourceId: created.id,
      afterState: { title: input.title, sectionId },
    });
  } catch {
    // Audit failure must not block the mutation.
  }

  trackEvent("system.ms_onenote_page_created", userId, "system", {
    ms_page_id: created.id,
    ms_section_id: sectionId,
  });

  // Best-effort RAG indexing — never blocks.
  try {
    await indexOneNotePage(userId, {
      msPageId: created.id,
      title: input.title,
      preview: previewFrom(input.html ?? "", input.title),
      modifiedAt: new Date().toISOString(),
    });
  } catch (err) {
    trackEvent("system.ms_teams_sync_indexing_failed", userId, "system", {
      ms_page_id: created.id,
      source: "onenote",
      error: (err as Error).message,
    });
  }

  const webUrl = created.links?.oneNoteWebUrl?.href;
  return { id: created.id, webUrl };
}

/**
 * Sync the most recently modified pages across the user's notebooks,
 * upserting into the cache and feeding each into the RAG index.
 */
export async function syncRecentPages(
  userId: string,
  opts: SyncRecentOpts = {},
): Promise<SyncRecentResult> {
  const start = Date.now();
  const top = Math.min(Math.max(opts.top ?? 50, 1), 200);

  try {
    const { pages } = await listPages(userId, undefined, { top });
    let count = 0;
    for (const g of pages) {
      // upsertPage was already called inside listPages; re-index for RAG.
      try {
        await indexOneNotePage(userId, {
          msPageId: g.id,
          title: g.title || "(untitled)",
          preview: "", // preview populated by listPages cache warm
          modifiedAt: g.lastModifiedDateTime
            ? new Date(g.lastModifiedDateTime).toISOString()
            : new Date().toISOString(),
        });
      } catch (err) {
        trackEvent("system.ms_teams_sync_indexing_failed", userId, "system", {
          ms_page_id: g.id,
          source: "onenote",
          error: (err as Error).message,
        });
      }
      count++;
    }

    return { pageCount: count, durationMs: Date.now() - start };
  } catch (err) {
    trackEvent("system.ms_onenote_failed", userId, "system", {
      op: "sync_recent",
      error: (err as Error).message,
      http_status: err instanceof OneNoteError ? err.status : 0,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scope-missing helper
// ---------------------------------------------------------------------------

export function asScopeMissing(
  err: unknown,
  scope: string,
): ScopeMissingError | null {
  if (err instanceof OneNoteError && err.status === 403) {
    return { ok: false, code: "scope_missing", scope };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache reads
// ---------------------------------------------------------------------------

export interface ListCachedPagesOpts {
  sectionId?: string;
  notebookId?: string;
  limit?: number;
  cursor?: string;
  search?: string;
}

export async function listCachedPages(
  userId: string,
  opts: ListCachedPagesOpts = {},
): Promise<{ pages: OneNotePage[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  const conds: string[] = ["user_id = $1"];
  if (opts.sectionId) {
    params.push(opts.sectionId);
    conds.push(`ms_section_id = $${params.length}`);
  }
  if (opts.notebookId) {
    params.push(opts.notebookId);
    conds.push(`ms_notebook_id = $${params.length}`);
  }
  if (opts.search) {
    params.push(opts.search);
    const p = params.length;
    conds.push(
      `(title ILIKE '%' || $${p} || '%' OR preview ILIKE '%' || $${p} || '%')`,
    );
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_page_id, ms_notebook_id, ms_section_id,
            title, preview, created_at, modified_at, content_url, etag, synced_at
       FROM instinct_onenote_pages
       WHERE ${conds.join(" AND ")}
       ORDER BY modified_at DESC, id ASC
       LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const pages: OneNotePage[] = taken.map(rowToPage);
  const nextCursor = hasMore ? pages[pages.length - 1].id : null;
  return { pages, nextCursor };
}

function rowToPage(r: any): OneNotePage {
  return {
    id: r.id,
    userId: r.user_id,
    msPageId: r.ms_page_id,
    msNotebookId: r.ms_notebook_id,
    msSectionId: r.ms_section_id,
    title: r.title ?? "(untitled)",
    preview: r.preview ?? "",
    createdAt: new Date(r.created_at).toISOString(),
    modifiedAt: new Date(r.modified_at).toISOString(),
    contentUrl: r.content_url,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}
