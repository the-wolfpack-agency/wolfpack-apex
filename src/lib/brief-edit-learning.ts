/**
 * Brief Edit Learning Loop — aggregator over instinct_site_brief_edits.
 *
 * Purpose: turn the raw audit log (migration 029) into structured,
 * actionable insights that surface in the admin dashboard and feed
 * future prompt-engineering decisions. Zero tokens consumed — all
 * aggregation is pure SQL + in-memory TypeScript.
 *
 * Signals computed:
 *   1. acceptanceRate      overall + per user + per model
 *   2. rejectionReasons    bucket counts
 *   3. blockedPaths        frequency of guardrail-rejected patch paths
 *   4. performance         latency p50/p95/p99, mean tokens in/out,
 *                          total cost_usd
 *   5. sectionTypeEdits    counts grouped by section index touched
 *                          (see "Known limitations" below)
 *   6. instructionThemes   top-50 non-stopword terms across instructions
 *
 * Known limitations:
 *   - sectionTypeEdits is keyed by section INDEX rather than section
 *     TYPE (hero/text/cards/...). The audit row stores a JSON-Patch +
 *     brief_before_hash, not the dereferenced brief, so we cannot
 *     recover the section type without joining back to
 *     instinct_site_projects.brief (which has already moved on). Index is
 *     a usable proxy: the dashboard tells us "section #2 is edited
 *     the most" which is enough to know "people keep tweaking the
 *     third slot on the homepage". A future migration can store
 *     section_type_counts directly on the audit row.
 *   - time-to-publish (minutes between accepted row + next deploy
 *     event) is NOT implemented — the heuristic join on user +
 *     timestamp proximity is error-prone enough to warrant a
 *     dedicated migration (e.g. deploys_triggered_by_edit_id) before
 *     shipping. Tracked as TODO below.
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import type { JsonPatch, JsonPatchOp } from "@/lib/brief-edit";

/* ------------------------------ Types --------------------------------- */

export interface BriefEditInsightsWindow {
  start: string; // ISO
  end: string;   // ISO
  rowCount: number;
}

export interface BriefEditInsights {
  window: BriefEditInsightsWindow;
  acceptanceRate: {
    overall: number; // 0..1
    byUser: Record<string, number>;
    byModel: Record<string, number>;
  };
  rejectionReasons: Array<{ reason: string; count: number }>;
  blockedPaths: Array<{ path: string; count: number }>;
  performance: {
    latencyMs: { p50: number; p95: number; p99: number };
    tokens: { meanIn: number; meanOut: number };
    totalCostUsd: number;
  };
  sectionTypeEdits: Array<{ sectionType: string; count: number }>;
  instructionThemes: Array<{ term: string; count: number }>;
  // TODO (future migration): time-to-publish distribution. Requires a
  // deterministic join between accepted brief_edit rows and the
  // site.deploy_triggered event they caused. Current heuristic
  // (user_id + timestamp proximity against instinct_analytics_events)
  // is too noisy to ship — ambiguous when multiple edits are accepted
  // back-to-back. Add deploy_triggered_by_edit_id to instinct_site_deploys
  // and recompute. Holding this here so the schema is stable for the
  // snapshots table.
}

/* ------------------------- Row shape ---------------------------------- */

/**
 * Shape of a row pulled from instinct_site_brief_edits. Exported so the
 * nightly script + tests can share the type.
 */
export interface BriefEditRow {
  id: string;
  user_id: string;
  user_role: string;
  instruction: string;
  patch: JsonPatch | string | null;
  accepted: boolean | null;
  rejection_reason: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | string | null; // pg returns NUMERIC as string
  model: string | null;
  created_at: Date | string;
}

/* --------------------------- Tokenizer -------------------------------- */

// Small English stopword list. Deliberately short so we don't accidentally
// hide real signal (e.g. "make" survives because "make the hero bigger"
// is a meaningful instruction intent).
const STOPWORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of",
  "to", "in", "on", "at", "by", "for", "with", "from", "as", "is",
  "are", "was", "were", "be", "been", "being", "am", "it", "its",
  "this", "that", "these", "those", "i", "we", "you", "they", "he",
  "she", "him", "her", "them", "us", "my", "our", "your", "their",
  "not", "no", "do", "does", "did", "doing", "have", "has", "had",
  "can", "could", "should", "would", "will", "shall", "may", "might",
  "just", "so", "too", "very", "also", "about", "into", "over",
  "please", "thanks", "thank",
]);

/**
 * Lowercase + split on non-letter runs, filter stopwords and short tokens.
 * Pure function — no AI involvement.
 */
export function tokenizeInstruction(instruction: string): string[] {
  if (!instruction) return [];
  const lower = instruction.toLowerCase();
  // Split on anything that isn't a letter. Digits are dropped on purpose
  // — numbers in instructions ("make it 3 columns") are rarely a theme.
  const raw = lower.split(/[^a-z]+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 3) continue;       // drop "a", "to", single letters
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/* --------------------------- Percentiles ------------------------------ */

/**
 * Nearest-rank percentile on a numeric array. Returns 0 on empty input.
 * Exported for tests. pct is 0..1.
 */
export function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank: index = ceil(pct * N) - 1, clamped.
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(pct * sorted.length) - 1),
  );
  return sorted[idx];
}

/* ---------------------- Patch path helpers ---------------------------- */

/**
 * Parse a JSON-Patch ops blob into an array. Accepts already-parsed
 * arrays as well as the JSON string shape Postgres returns from JSONB.
 */
function normalizePatch(raw: BriefEditRow["patch"]): JsonPatch {
  if (Array.isArray(raw)) return raw as JsonPatch;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as JsonPatch;
    } catch {
      /* fall through */
    }
  }
  return [];
}

/**
 * Extract the 0-based section index from a patch path, if any.
 * /pages/0/sections/2/heading -> 2. Returns null if the path doesn't
 * target a section.
 */
export function extractSectionIndex(path: string | undefined): number | null {
  if (!path) return null;
  const m = /^\/pages\/\d+\/sections\/(\d+)(?:\/|$)/.exec(path);
  if (!m) return null;
  const idx = Number(m[1]);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/* --------------------------- Aggregator ------------------------------- */

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toIso(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  // Postgres already returns ISO-ish; normalize via Date for safety.
  const parsed = new Date(d);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(d);
}

/**
 * Pure function: aggregate a set of rows into a BriefEditInsights object.
 * Exported so tests can feed fixture arrays without touching the DB.
 *
 * `window` is supplied by the caller so the snapshot accurately reflects
 * the query window (not just the min/max of the returned rows, which
 * would shift when the window is empty).
 */
export function aggregateInsights(
  rows: BriefEditRow[],
  window: { start: Date | string; end: Date | string },
): BriefEditInsights {
  const start = toIso(window.start);
  const end = toIso(window.end);

  // --- acceptance rate -------------------------------------------------
  const decidedRows = rows.filter((r) => r.accepted !== null);
  const acceptedRows = rows.filter((r) => r.accepted === true);
  const overall =
    decidedRows.length === 0
      ? 0
      : acceptedRows.length / decidedRows.length;

  const byUserTotals = new Map<string, { accepted: number; decided: number }>();
  const byModelTotals = new Map<string, { accepted: number; decided: number }>();
  for (const row of rows) {
    if (row.accepted === null) continue;
    const u = row.user_id || "unknown";
    const m = row.model || "unknown";
    const uBucket = byUserTotals.get(u) ?? { accepted: 0, decided: 0 };
    uBucket.decided += 1;
    if (row.accepted === true) uBucket.accepted += 1;
    byUserTotals.set(u, uBucket);

    const mBucket = byModelTotals.get(m) ?? { accepted: 0, decided: 0 };
    mBucket.decided += 1;
    if (row.accepted === true) mBucket.accepted += 1;
    byModelTotals.set(m, mBucket);
  }
  const byUser: Record<string, number> = {};
  for (const [k, v] of byUserTotals)
    byUser[k] = v.decided === 0 ? 0 : v.accepted / v.decided;
  const byModel: Record<string, number> = {};
  for (const [k, v] of byModelTotals)
    byModel[k] = v.decided === 0 ? 0 : v.accepted / v.decided;

  // --- rejection reasons ----------------------------------------------
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.accepted === false && row.rejection_reason) {
      reasonCounts.set(
        row.rejection_reason,
        (reasonCounts.get(row.rejection_reason) ?? 0) + 1,
      );
    }
  }
  const rejectionReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // --- blocked paths --------------------------------------------------
  const blockedPathCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.rejection_reason !== "patch_blocked") continue;
    const ops = normalizePatch(row.patch);
    for (const op of ops as JsonPatchOp[]) {
      if (op && typeof op.path === "string" && op.path) {
        blockedPathCounts.set(
          op.path,
          (blockedPathCounts.get(op.path) ?? 0) + 1,
        );
      }
    }
  }
  const blockedPaths = [...blockedPathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  // --- performance ----------------------------------------------------
  const latencies: number[] = [];
  let tokensInSum = 0;
  let tokensInN = 0;
  let tokensOutSum = 0;
  let tokensOutN = 0;
  let totalCost = 0;
  for (const row of rows) {
    if (row.latency_ms != null && Number.isFinite(row.latency_ms)) {
      latencies.push(row.latency_ms);
    }
    if (row.tokens_in != null) {
      tokensInSum += toNumber(row.tokens_in);
      tokensInN += 1;
    }
    if (row.tokens_out != null) {
      tokensOutSum += toNumber(row.tokens_out);
      tokensOutN += 1;
    }
    totalCost += toNumber(row.cost_usd);
  }
  const performance = {
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    tokens: {
      meanIn: tokensInN === 0 ? 0 : tokensInSum / tokensInN,
      meanOut: tokensOutN === 0 ? 0 : tokensOutSum / tokensOutN,
    },
    // round to NUMERIC(10,6) scale so the number matches what storage
    // would have held had this run through cost_usd column math.
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
  };

  // --- section edits (by INDEX, see limitations note) -----------------
  const sectionCounts = new Map<string, number>();
  for (const row of rows) {
    const ops = normalizePatch(row.patch);
    // Dedup so one patch with 3 ops on section 2 still counts as "one
    // edit touching section 2" rather than skewing by op granularity.
    const touched = new Set<number>();
    for (const op of ops as JsonPatchOp[]) {
      const idx = extractSectionIndex(op?.path);
      if (idx !== null) touched.add(idx);
    }
    for (const idx of touched) {
      const key = `section_${idx}`;
      sectionCounts.set(key, (sectionCounts.get(key) ?? 0) + 1);
    }
  }
  const sectionTypeEdits = [...sectionCounts.entries()]
    .map(([sectionType, count]) => ({ sectionType, count }))
    .sort((a, b) => b.count - a.count);

  // --- instruction themes ---------------------------------------------
  const termCounts = new Map<string, number>();
  for (const row of rows) {
    const terms = tokenizeInstruction(row.instruction ?? "");
    // Count each term once per instruction so one chatty instruction
    // doesn't dominate.
    const seen = new Set<string>();
    for (const t of terms) {
      if (seen.has(t)) continue;
      seen.add(t);
      termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    }
  }
  const instructionThemes = [...termCounts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, 50);

  return {
    window: { start, end, rowCount: rows.length },
    acceptanceRate: { overall, byUser, byModel },
    rejectionReasons,
    blockedPaths,
    performance,
    sectionTypeEdits,
    instructionThemes,
  };
}

/* --------------------- DB-backed entry point -------------------------- */

/**
 * Fetch rows from instinct_site_brief_edits in the given window and
 * aggregate. Shadow-mode safe: if DATABASE_URL is unset, safeQuery
 * returns [] and we emit an empty-but-valid insights object.
 */
export async function computeBriefEditInsights(
  options: { days?: number; now?: Date } = {},
): Promise<BriefEditInsights> {
  const days = Math.max(1, Math.floor(options.days ?? 7));
  const end = options.now ?? new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  const { rows } = await safeQuery<BriefEditRow>(
    `SELECT id, user_id, user_role, instruction, patch, accepted,
            rejection_reason, latency_ms, tokens_in, tokens_out,
            cost_usd, model, created_at
       FROM instinct_site_brief_edits
      WHERE created_at >= $1 AND created_at <= $2
      ORDER BY created_at ASC`,
    [start.toISOString(), end.toISOString()],
  );

  return aggregateInsights(rows, { start, end });
}

/* ------------------------ Snapshot persistence ------------------------ */

/**
 * Persist a computed insights object into
 * instinct_brief_edit_insights_snapshots. Returns the generated row
 * id. Shadow-mode safe: when DATABASE_URL is unset, safeQuery
 * silently no-ops and we return the id without throwing.
 *
 * Note: the table was renamed from apex_brief_edit_insights_snapshots
 * in migration 055. A backward-compat view with the old name still
 * exists (auto-updatable passthrough) so legacy deployments don't
 * break, but new code targets the canonical instinct_* name.
 */
export async function writeInsightsSnapshot(
  insights: BriefEditInsights,
): Promise<string> {
  const id = `brief_edit_insights_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO instinct_brief_edit_insights_snapshots
        (id, window_start, window_end, payload)
      VALUES ($1, $2, $3, $4)`,
    [id, insights.window.start, insights.window.end, JSON.stringify(insights)],
  );
  return id;
}
