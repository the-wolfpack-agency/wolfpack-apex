/**
 * brief-exemplars — retrieval layer that turns the stream of accepted
 * brief generations in `apex_site_brief_generations` into few-shot
 * exemplars for the next image→brief extraction.
 *
 * Why this exists: every image upload today hits Haiku cold. The brain
 * already captures every extraction + the designer's accept/reject
 * decision. That's training data sitting idle. This module reads the
 * most recent accepted generations for the current client, summarizes
 * each into a compact prompt block, and hands the block back for the
 * caller to splice into the system prompt.
 *
 * Design choices:
 *  - Zero new runtime deps. Pure SQL via safeQuery, pure TS
 *    summarization.
 *  - Best-effort: any failure returns `[]`. Exemplars are a primer, not
 *    a critical path. A broken DB should never block an extraction.
 *  - Bounded output: hard cap of 5 exemplars, hard cap of 2000 chars in
 *    the rendered prompt block so token cost stays predictable.
 *  - Analytics reflexivity: fires `site.brief_exemplars_served` or
 *    `site.brief_exemplars_empty` so the brain can later measure
 *    primed-vs-cold acceptance rate — the KPI that proves the tool is
 *    getting better over time.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { SiteBrief } from "@/lib/sites-schema";

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;
const DEFAULT_MIN_AGE_DAYS = 0;
const DEFAULT_MAX_AGE_DAYS = 365;
const MAX_PALETTE_COLORS = 5;
const MAX_FIELD_CHARS = 80;
const MAX_BLOCK_CHARS = 2000;

export interface BriefExemplar {
  client: string;
  productName: string;
  tagline: string | null;
  sectionTypes: string[];
  heroHeading: string | null;
  primaryCta: string | null;
  paletteHex: string[];
  font: string | null;
  createdAt: string;
}

export interface GetExemplarsOptions {
  clientSlug: string;
  limit?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  /** Optional analytics context. If provided, we fire a served/empty
   *  event so the brain can correlate primed extractions with outcomes. */
  userId?: string;
  userRole?: string;
}

interface BriefGenerationExemplarRow {
  extracted_brief: unknown;
  extracted_colors: string[] | null;
  detected_font: string | null;
  created_at: string;
}

/**
 * Pure mapping from a stored brief generation row to a BriefExemplar.
 * Exported so tests can exercise the summarization without a DB
 * round-trip. Returns null when the row is too thin to be useful.
 */
export function summarizeGeneration(row: {
  extracted_brief: unknown;
  extracted_colors: string[] | null;
  detected_font: string | null;
  created_at: string;
}): BriefExemplar | null {
  const brief = parseBrief(row.extracted_brief);
  if (!brief) return null;

  const productName =
    typeof brief.product?.name === "string" ? brief.product.name : null;
  if (!productName) return null;

  const tagline =
    typeof brief.product?.tagline === "string" && brief.product.tagline.length > 0
      ? brief.product.tagline
      : null;

  const sectionTypes: string[] = [];
  let heroHeading: string | null = null;
  let primaryCta: string | null = null;

  const pages = Array.isArray(brief.pages) ? brief.pages : [];
  for (const page of pages) {
    const sections = Array.isArray(page?.sections) ? page.sections : [];
    for (const section of sections) {
      if (!section || typeof section !== "object") continue;
      const type = typeof section.type === "string" ? section.type : null;
      if (type) sectionTypes.push(type);

      if (heroHeading === null && type === "hero") {
        const h = (section as { heading?: unknown }).heading;
        if (typeof h === "string" && h.length > 0) heroHeading = h;
      }

      if (primaryCta === null) {
        const cta = (section as { cta?: { label?: unknown } }).cta;
        if (
          cta &&
          typeof cta === "object" &&
          typeof cta.label === "string" &&
          cta.label.length > 0
        ) {
          primaryCta = cta.label;
        }
      }
    }
  }

  const paletteHex = Array.isArray(row.extracted_colors)
    ? row.extracted_colors
        .filter((c): c is string => typeof c === "string")
        .slice(0, MAX_PALETTE_COLORS)
    : [];

  const font =
    typeof row.detected_font === "string" && row.detected_font.length > 0
      ? row.detected_font
      : null;

  const client =
    typeof brief.client === "string" && brief.client.length > 0
      ? brief.client
      : "";

  return {
    client,
    productName,
    tagline,
    sectionTypes,
    heroHeading,
    primaryCta,
    paletteHex,
    font,
    createdAt: row.created_at,
  };
}

/**
 * Returns the most recent accepted=true generations for a client,
 * summarized. Never throws — on any error returns `[]`.
 *
 * Linking note: generations land with project_id=NULL and only get a
 * project_id once the designer accepts and commits to a new site. So
 * the client filter necessarily goes through apex_site_projects. A
 * generation with project_id=NULL cannot be exemplar-ized (we have no
 * way to attribute it to a client).
 */
export async function getAcceptedExemplars(
  opts: GetExemplarsOptions,
): Promise<BriefExemplar[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const minAgeDays = Math.max(0, opts.minAgeDays ?? DEFAULT_MIN_AGE_DAYS);
  const maxAgeDays = Math.max(
    minAgeDays,
    opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
  );

  let exemplars: BriefExemplar[] = [];
  try {
    const result = await safeQuery<BriefGenerationExemplarRow>(
      `SELECT g.extracted_brief, g.extracted_colors, g.detected_font, g.created_at
         FROM apex_site_brief_generations g
         JOIN apex_site_projects p ON p.id = g.project_id
        WHERE g.accepted = true
          AND g.project_id IS NOT NULL
          AND p.client_slug = $1
          AND g.created_at <= NOW() - ($2::int * INTERVAL '1 day')
          AND g.created_at >= NOW() - ($3::int * INTERVAL '1 day')
        ORDER BY g.created_at DESC
        LIMIT $4`,
      [opts.clientSlug, minAgeDays, maxAgeDays, limit],
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const summary = summarizeGeneration({
        extracted_brief: row.extracted_brief,
        extracted_colors: row.extracted_colors ?? null,
        detected_font: row.detected_font ?? null,
        created_at: row.created_at,
      });
      if (summary) exemplars.push(summary);
    }
  } catch {
    exemplars = [];
  }

  // Analytics — best-effort, never throws. Fire regardless of whether
  // the caller supplied user context (fall back to "system" attribution
  // so the event still lands).
  try {
    const userId = opts.userId ?? "system";
    const userRole = opts.userRole ?? "system";
    if (exemplars.length > 0) {
      const now = Date.now();
      const oldestAgeDays = Math.max(
        0,
        ...exemplars.map((e) => daysBetween(e.createdAt, now)),
      );
      trackEvent("site.brief_exemplars_served", userId, userRole, {
        client_slug: opts.clientSlug,
        exemplar_count: exemplars.length,
        oldest_age_days: oldestAgeDays,
      });
    } else {
      trackEvent("site.brief_exemplars_empty", userId, userRole, {
        client_slug: opts.clientSlug,
        reason: "no_accepted_generations",
      });
    }
  } catch {
    // never let analytics break the caller
  }

  return exemplars;
}

/**
 * Render exemplars as a compact string block for injection into a
 * Haiku system prompt. Returns "" when no exemplars — callers must
 * handle empty-string gracefully.
 *
 * Output is hard-capped at 2000 chars; if exemplars would overflow,
 * drop from the tail (oldest first) until under.
 */
export function exemplarsToPromptBlock(exemplars: BriefExemplar[]): string {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return "";

  const now = Date.now();
  const renderedLines = exemplars.map((e, idx) => renderLine(e, idx + 1, now));

  const header =
    "PRIOR ACCEPTED BRIEFS FOR THIS CLIENT (for style reference — do NOT copy content verbatim):";
  const footer =
    "Use these to infer this client's typical voice, section rhythm, and brand system. Do not copy. If the new wireframe implies different content, follow the wireframe.";

  let lines = renderedLines.slice();
  while (lines.length > 0) {
    const block = [header, ...lines, "", footer].join("\n");
    if (block.length <= MAX_BLOCK_CHARS) return block;
    lines.pop(); // drop the tail (oldest) and retry
  }
  return ""; // header+footer alone still too big; degrade silently
}

/* ----------------------------- helpers -------------------------------- */

function parseBrief(raw: unknown): Partial<SiteBrief> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Partial<SiteBrief>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as Partial<SiteBrief>;
  return null;
}

function truncate(s: string, n = MAX_FIELD_CHARS): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function daysBetween(isoCreated: string, nowMs: number): number {
  const t = Date.parse(isoCreated);
  if (!Number.isFinite(t)) return 0;
  const diffMs = Math.max(0, nowMs - t);
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function renderLine(e: BriefExemplar, n: number, nowMs: number): string {
  const parts: string[] = [];
  parts.push(`${n}. "${truncate(e.productName)}"`);
  if (e.tagline) parts.push(`tagline "${truncate(e.tagline)}"`);
  if (e.sectionTypes.length > 0) {
    parts.push(`sections: ${e.sectionTypes.join(", ")}`);
  }
  if (e.heroHeading) parts.push(`hero heading was "${truncate(e.heroHeading)}"`);
  if (e.primaryCta) parts.push(`primary CTA was "${truncate(e.primaryCta)}"`);
  if (e.paletteHex.length > 0) {
    parts.push(`brand palette ${e.paletteHex.join(" ")}`);
  }
  if (e.font) parts.push(`font ${e.font}`);
  parts.push(`${daysBetween(e.createdAt, nowMs)} days ago`);
  return parts.join(" — ");
}
