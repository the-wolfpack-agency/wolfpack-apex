/**
 * releases.ts: release notes / changelog domain logic.
 *
 * Backs the /releases wiki page and the release email. A release is a dated set
 * of plain-English feature breakdowns (what shipped + how to use it), authored
 * by the release-notes generator (scripts/generate-release-notes.mjs) or by
 * hand. Reads are org-wide (releases.view); publishing is gated (releases.manage).
 */

import { safeQuery, query } from "@/lib/db";

/** One feature/fix/improvement within a release. */
export interface ReleaseEntry {
  /** Short headline, e.g. "Forgot-password now works". */
  title: string;
  /** Plain-English description of what changed. */
  description: string;
  /** How to use it, in plain English. Empty when not applicable. */
  how_to_use: string;
  /** Product area, e.g. "Auto", "Instinct", "LMS". Optional. */
  area?: string;
  /** "feature" | "fix" | "improvement" | "milestone". Optional. */
  category?: string;
  /** Lines of code for the product (set on creation-milestone entries only). */
  loc?: number;
}

export interface Release {
  id: string;
  version: string;
  title: string;
  summary: string;
  /** ISO date (YYYY-MM-DD). */
  released_on: string;
  entries: ReleaseEntry[];
  published: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateReleaseInput {
  version: string;
  title: string;
  summary?: string;
  released_on?: string;
  entries: ReleaseEntry[];
  published?: boolean;
  created_by?: string;
}

interface ReleaseRow {
  id: string;
  version: string;
  title: string;
  summary: string;
  released_on: string | Date;
  entries: unknown;
  published: boolean;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function toEntries(raw: unknown): ReleaseEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      title: String(e.title ?? ""),
      description: String(e.description ?? ""),
      how_to_use: String(e.how_to_use ?? ""),
      area: e.area != null ? String(e.area) : undefined,
      category: e.category != null ? String(e.category) : undefined,
      loc: typeof e.loc === "number" ? e.loc : undefined,
    }));
}

function toISODate(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  // A DATE column comes back as "YYYY-MM-DD" already; a timestamp gets sliced.
  return String(d).slice(0, 10);
}

function mapRow(r: ReleaseRow): Release {
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    summary: r.summary ?? "",
    released_on: toISODate(r.released_on),
    entries: toEntries(r.entries),
    published: r.published,
    created_by: r.created_by,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

/**
 * List published releases, newest first. Read-through cache safe: returns an
 * empty list in shadow mode (no DATABASE_URL) so the page renders an empty
 * state instead of erroring.
 */
export async function listReleases(
  opts: { includeUnpublished?: boolean } = {},
): Promise<Release[]> {
  const where = opts.includeUnpublished ? "" : "WHERE published = true";
  const { rows } = await safeQuery<ReleaseRow>(
    `SELECT id, version, title, summary, released_on, entries, published,
            created_by, created_at, updated_at
       FROM instinct_releases
       ${where}
       ORDER BY released_on DESC, created_at DESC`,
  );
  return rows.map(mapRow);
}

/**
 * Create or update a release (upsert on version). Used by the generator and the
 * manual publish path. Requires DATABASE_URL (writes never happen in shadow).
 */
export async function createRelease(input: CreateReleaseInput): Promise<Release> {
  const entriesJson = JSON.stringify(input.entries ?? []);
  const { rows } = await query<ReleaseRow & Record<string, unknown>>(
    `INSERT INTO instinct_releases
       (version, title, summary, released_on, entries, published, created_by)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5::jsonb, COALESCE($6, true), $7)
     ON CONFLICT (version) DO UPDATE SET
       title       = EXCLUDED.title,
       summary     = EXCLUDED.summary,
       released_on = EXCLUDED.released_on,
       entries     = EXCLUDED.entries,
       published   = EXCLUDED.published,
       updated_at  = NOW()
     RETURNING id, version, title, summary, released_on, entries, published,
               created_by, created_at, updated_at`,
    [
      input.version,
      input.title,
      input.summary ?? "",
      input.released_on ?? null,
      entriesJson,
      input.published ?? true,
      input.created_by ?? null,
    ],
  );
  return mapRow(rows[0]);
}
