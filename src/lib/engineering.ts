/**
 * engineering.ts: the OGIAM Engineering wiki domain logic.
 *
 * Backs the /engineering page: a hierarchical set of team-facing pages (a tree
 * via `parent_slug`). Reads are org-wide (engineering.view); authoring/editing is
 * gated (engineering.manage). Content is Markdown, rendered + sanitized on the
 * SERVER (see src/lib/markdown.ts) and shipped to the client as `bodyHtml` so
 * the sanitizer (jsdom/dompurify, Node-only) never enters the client bundle. New
 * pages are added as rows (seed script or the in-app editor), so the wiki grows
 * without a code change.
 */

import { safeQuery, query } from "@/lib/db";
import type { WikiPage } from "@/lib/engineering-tree";

// Re-export the client-safe types + tree helper so server callers keep a single
// `@/lib/engineering` import surface. The definitions live in engineering-tree.ts
// (no db import) so client bundles never pull in `pg`.
export type { WikiPage, WikiPageNode } from "@/lib/engineering-tree";
export { buildTree } from "@/lib/engineering-tree";

export interface UpsertPageInput {
  slug: string;
  parentSlug?: string | null;
  title: string;
  body?: string;
  position?: number;
  published?: boolean;
  createdBy?: string;
}

interface Row {
  id: string;
  slug: string;
  parent_slug: string | null;
  title: string;
  body: string;
  position: number;
  published: boolean;
  created_by: string | null;
  updated_at: string | Date;
}

function mapRow(r: Row): WikiPage {
  return {
    id: r.id,
    slug: r.slug,
    parentSlug: r.parent_slug,
    title: r.title,
    body: r.body ?? "",
    position: r.position,
    published: r.published,
    createdBy: r.created_by,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

/**
 * List published wiki pages, ordered for a stable tree (top-level first, then by
 * sibling position + title). Shadow-safe: returns [] with no DATABASE_URL so the
 * page renders an empty state instead of erroring.
 */
export async function listPages(opts: { includeUnpublished?: boolean } = {}): Promise<WikiPage[]> {
  const where = opts.includeUnpublished ? "" : "WHERE published = true";
  const { rows } = await safeQuery<Row>(
    `SELECT id, slug, parent_slug, title, body, position, published, created_by, updated_at
       FROM instinct_engineering_pages
       ${where}
       ORDER BY position ASC, title ASC`,
  );
  return rows.map(mapRow);
}

/** One page by slug (published only). */
export async function getPage(slug: string): Promise<WikiPage | null> {
  const { rows } = await safeQuery<Row>(
    `SELECT id, slug, parent_slug, title, body, position, published, created_by, updated_at
       FROM instinct_engineering_pages WHERE slug = $1 AND published = true`,
    [slug],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Create or update a page (upsert on slug). Requires DATABASE_URL. */
export async function upsertPage(input: UpsertPageInput): Promise<WikiPage> {
  const { rows } = await query<Row & Record<string, unknown>>(
    `INSERT INTO instinct_engineering_pages (slug, parent_slug, title, body, position, published, created_by)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, true), $7)
     ON CONFLICT (slug) DO UPDATE SET
       parent_slug = EXCLUDED.parent_slug,
       title       = EXCLUDED.title,
       body        = EXCLUDED.body,
       position    = EXCLUDED.position,
       published   = EXCLUDED.published,
       updated_at  = NOW()
     RETURNING id, slug, parent_slug, title, body, position, published, created_by, updated_at`,
    [
      input.slug,
      input.parentSlug ?? null,
      input.title,
      input.body ?? "",
      input.position ?? null,
      input.published ?? null,
      input.createdBy ?? null,
    ],
  );
  return mapRow(rows[0]);
}
