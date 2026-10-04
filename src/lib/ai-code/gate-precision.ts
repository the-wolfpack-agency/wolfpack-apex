/**
 * Per-rule gate precision from HUMAN review labels - the FalsePositiveTracker the
 * plan called for, now that there's real ground truth to read.
 *
 * Signal: ai_code.finding_detected (how often each class fires) joined with
 * ai_code.gate_finding_reviewed (a human's verdict: wrong | valid | accepted_risk).
 * A class humans keep marking `wrong` is noisy and should be demoted; a class that
 * fires a lot but is never reviewed is UNKNOWN (not assumed good); a class never
 * flagged is a candidate dead rule. We never infer a verdict - only humans label.
 *
 * Pure summarizer (unit-tested) + never-throwing loader (safeQuery -> []).
 * Workspace-scoped, no new table (reads the event stream).
 */
import { safeQuery } from "@/lib/db";

export type ReviewVerdict = "wrong" | "valid" | "accepted_risk";
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["wrong", "valid", "accepted_risk"];

export interface ClassPrecision {
  findingClass: string;
  /** Times this class fired in the window. */
  flagged: number;
  /** Human reviews recorded for it. */
  reviewed: number;
  wrong: number;
  valid: number;
  acceptedRisk: number;
  /** wrong / reviewed - null until a human has reviewed it (no inferred precision). */
  wrongRate: number | null;
}

export interface GatePrecision {
  windowDays: number;
  classes: ClassPrecision[];
}

interface FlagRow extends Record<string, unknown> { klass: string; n: number }
interface ReviewRow extends Record<string, unknown> { klass: string; verdict: string; n: number }

/** Pure: fold flag-counts + review-verdict-counts into per-class precision, noisiest
 *  (highest wrong-rate, then most-flagged) first. */
export function summarizeGatePrecision(flags: readonly FlagRow[], reviews: readonly ReviewRow[], windowDays: number): GatePrecision {
  const byClass = new Map<string, ClassPrecision>();
  const get = (klass: string): ClassPrecision => {
    let c = byClass.get(klass);
    if (!c) { c = { findingClass: klass, flagged: 0, reviewed: 0, wrong: 0, valid: 0, acceptedRisk: 0, wrongRate: null }; byClass.set(klass, c); }
    return c;
  };
  for (const f of flags) get(f.klass).flagged = Number(f.n) || 0;
  for (const r of reviews) {
    const c = get(r.klass);
    const n = Number(r.n) || 0;
    c.reviewed += n;
    if (r.verdict === "wrong") c.wrong += n;
    else if (r.verdict === "valid") c.valid += n;
    else if (r.verdict === "accepted_risk") c.acceptedRisk += n;
  }
  const classes = [...byClass.values()].map((c) => ({ ...c, wrongRate: c.reviewed > 0 ? c.wrong / c.reviewed : null }));
  classes.sort((a, b) => (b.wrongRate ?? -1) - (a.wrongRate ?? -1) || b.flagged - a.flagged || a.findingClass.localeCompare(b.findingClass));
  return { windowDays, classes };
}

/** Load per-rule precision for a workspace over `days`. Never throws. */
export async function loadGatePrecision(workspaceId: string, days = 30): Promise<GatePrecision> {
  const d = Math.min(Math.max(Math.trunc(days), 1), 365);
  const win = `timestamp > now() - ($1 || ' days')::interval AND metadata->>'workspace_id' = $2`;
  const flags = await safeQuery<FlagRow>(
    `SELECT coalesce(metadata->>'class', 'unknown') AS klass, count(*)::int AS n
       FROM instinct_events WHERE event_type = 'ai_code.finding_detected' AND ${win}
      GROUP BY 1`,
    [String(d), workspaceId],
  );
  const reviews = await safeQuery<ReviewRow>(
    `SELECT coalesce(metadata->>'finding_class', 'unknown') AS klass, coalesce(metadata->>'verdict', '') AS verdict, count(*)::int AS n
       FROM instinct_events WHERE event_type = 'ai_code.gate_finding_reviewed' AND ${win}
      GROUP BY 1, 2`,
    [String(d), workspaceId],
  );
  return summarizeGatePrecision(flags.rows, reviews.rows, d);
}
