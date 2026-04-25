/**
 * meeting-insights / feeds-repo — DB persistence for the feed config.
 *
 * Server-only. Every query is parameterized; every write goes through
 * `writeQuery` so silent discard surfaces. The repo is intentionally
 * thin (no analytics, no audit) — those concerns live at the API
 * route layer where they have access to the actor identity.
 *
 * Schema lives in src/db/migrations/083_meeting_insights.sql.
 */

import { query, writeQuery } from "@/lib/db";
import type {
  MeetingFeed,
  MeetingFeedFilters,
  MeetingFeedInput,
} from "./types";

/* ------------------------------------------------------------------ */
/* Slug helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Turn a free-form name into a route-safe kebab-case slug. Pure — no
 * I/O. Collisions are resolved at the API layer by appending a numeric
 * suffix until the slug is unique.
 */
export function nameToSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base.length > 0 ? base : "feed";
}

/* ------------------------------------------------------------------ */
/* Row → record                                                        */
/* ------------------------------------------------------------------ */

interface FeedRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  filters: MeetingFeedFilters;
  is_enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToFeed(row: FeedRow): MeetingFeed {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    filters: normalizeFilters(row.filters),
    is_enabled: row.is_enabled,
    created_by: row.created_by,
    created_at: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(row.updated_at).toISOString(),
  };
}

/**
 * Defensive normalization — pg returns jsonb as plain JS values; if the
 * column was somehow non-object (legacy row, hand-edit) we coerce to a
 * safe empty filter shape rather than NPE'ing downstream.
 */
export function normalizeFilters(raw: unknown): MeetingFeedFilters {
  const f = (raw ?? {}) as Partial<MeetingFeedFilters>;
  return {
    sender_match: Array.isArray(f.sender_match) ? f.sender_match.map(String) : [],
    subject_match: Array.isArray(f.subject_match) ? f.subject_match.map(String) : [],
    since: typeof f.since === "string" ? f.since : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listFeeds(args: { onlyEnabled?: boolean } = {}): Promise<MeetingFeed[]> {
  const where = args.onlyEnabled ? "WHERE is_enabled = TRUE" : "";
  const r = await query<FeedRow>(
    `SELECT id, slug, name, description, filters, is_enabled,
            created_by, created_at, updated_at
       FROM instinct_meeting_feeds
       ${where}
      ORDER BY created_at DESC`,
  );
  return r.rows.map(rowToFeed);
}

export async function getFeedBySlug(slug: string): Promise<MeetingFeed | null> {
  const r = await query<FeedRow>(
    `SELECT id, slug, name, description, filters, is_enabled,
            created_by, created_at, updated_at
       FROM instinct_meeting_feeds
      WHERE slug = $1
      LIMIT 1`,
    [slug],
  );
  return r.rows.length === 0 ? null : rowToFeed(r.rows[0]);
}

export async function getFeedById(id: string): Promise<MeetingFeed | null> {
  const r = await query<FeedRow>(
    `SELECT id, slug, name, description, filters, is_enabled,
            created_by, created_at, updated_at
       FROM instinct_meeting_feeds
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return r.rows.length === 0 ? null : rowToFeed(r.rows[0]);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function createFeed(args: {
  input: MeetingFeedInput;
  created_by: string;
}): Promise<MeetingFeed> {
  const baseSlug = nameToSlug(args.input.name);
  // Resolve collisions by appending -2, -3, ... up to 50. Past that we
  // give up — names this similar are almost certainly a UI mistake.
  let slug = baseSlug;
  for (let i = 0; i < 50; i++) {
    const existing = await getFeedBySlug(slug);
    if (!existing) break;
    slug = `${baseSlug}-${i + 2}`;
  }

  const r = await writeQuery<FeedRow>(
    `INSERT INTO instinct_meeting_feeds
       (slug, name, description, filters, is_enabled, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id, slug, name, description, filters, is_enabled,
               created_by, created_at, updated_at`,
    [
      slug,
      args.input.name,
      args.input.description ?? null,
      JSON.stringify(args.input.filters),
      args.input.is_enabled ?? true,
      args.created_by,
    ],
    { expectRows: 1 },
  );
  return rowToFeed(r.rows[0]);
}

export async function updateFeed(args: {
  slug: string;
  patch: Partial<MeetingFeedInput>;
}): Promise<MeetingFeed | null> {
  // Build a dynamic SET clause covering only the keys present in the
  // patch — using COALESCE-style defaults makes "omit means keep" feel
  // natural to the API caller.
  const sets: string[] = [];
  const params: unknown[] = [args.slug];
  let i = 2;
  if (args.patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(args.patch.name);
  }
  if (args.patch.description !== undefined) {
    sets.push(`description = $${i++}`);
    params.push(args.patch.description);
  }
  if (args.patch.filters !== undefined) {
    sets.push(`filters = $${i++}::jsonb`);
    params.push(JSON.stringify(args.patch.filters));
  }
  if (args.patch.is_enabled !== undefined) {
    sets.push(`is_enabled = $${i++}`);
    params.push(args.patch.is_enabled);
  }
  if (sets.length === 0) {
    // Pure no-op patch — return current row.
    return getFeedBySlug(args.slug);
  }
  sets.push(`updated_at = NOW()`);

  const r = await writeQuery<FeedRow>(
    `UPDATE instinct_meeting_feeds
        SET ${sets.join(", ")}
      WHERE slug = $1
      RETURNING id, slug, name, description, filters, is_enabled,
                created_by, created_at, updated_at`,
    params,
  );
  return r.rows.length === 0 ? null : rowToFeed(r.rows[0]);
}

/**
 * Soft-delete: we flip is_enabled rather than DELETE so message history
 * stays addressable. Hard-delete is intentionally not exposed.
 */
export async function disableFeed(slug: string): Promise<MeetingFeed | null> {
  const r = await writeQuery<FeedRow>(
    `UPDATE instinct_meeting_feeds
        SET is_enabled = FALSE,
            updated_at = NOW()
      WHERE slug = $1
      RETURNING id, slug, name, description, filters, is_enabled,
                created_by, created_at, updated_at`,
    [slug],
  );
  return r.rows.length === 0 ? null : rowToFeed(r.rows[0]);
}

/* ------------------------------------------------------------------ */
/* Union — produce one filter set covering every enabled feed          */
/* ------------------------------------------------------------------ */

/**
 * Return the UNION of all enabled feeds' filters as a single
 * sender_match / subject_match pair. Used by the inbox poller via
 * `meetingInsights.loadInboxFilters` so the Graph delta query is a
 * superset of every feed's needs.
 *
 * If NO feeds are enabled we return empty arrays; the poller treats
 * "empty filter set" as "match nothing", which is the correct
 * behavior — no feeds means no work to do.
 */
export async function unionEnabledFilters(): Promise<{
  sender_match: string[];
  subject_match: string[];
}> {
  const feeds = await listFeeds({ onlyEnabled: true });
  const senders = new Set<string>();
  const subjects = new Set<string>();
  for (const f of feeds) {
    for (const s of f.filters.sender_match) senders.add(s);
    for (const s of f.filters.subject_match) subjects.add(s);
  }
  return {
    sender_match: [...senders],
    subject_match: [...subjects],
  };
}
