/**
 * "Protected you from production issues": what the gate CAUGHT before a change
 * could reach a human, read back from the event stream. Shows the value of the
 * tool in the user's terms - problems stopped, by class - not internal rule ids.
 *
 * Sources (both workspace-scoped):
 *  - ai_code.finding_detected: one per issue the gate flagged (class/severity).
 *  - ai_code.pipeline_run: the run outcomes (blocked / escalated / criticals).
 * NEVER throws (safeQuery); returns zeros on a read failure.
 */
import { safeQuery } from "@/lib/db";

/** Friendly, product-agnostic names for the internal finding classes. */
const CLASS_LABEL: Record<string, string> = {
  logged_credential: "Secret written to a log",
  logged_secret: "Secret written to a log",
  hardcoded_secret: "Hardcoded secret",
  reset_link_logged: "Reset link written to a log",
  sql_injection: "SQL injection",
  xss: "Cross-site scripting",
  command_injection: "Command injection",
  ssrf: "Server-side request forgery",
  path_traversal: "Path traversal",
  open_redirect: "Open redirect",
  weak_crypto: "Weak cryptography",
  disabled_tls: "Disabled TLS verification",
  unsafe_html: "Unsafe HTML rendering",
  pii_exposure: "Personal data exposure",
  raw_api_fetch: "Unauthenticated data fetch",
};

export function labelForClass(cls: string): string {
  return CLASS_LABEL[cls] ?? cls.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export interface ProtectionSummary {
  /** Total issues the gate caught in the window. */
  totalCaught: number;
  /** Caught issues grouped by class, most-common first. */
  byClass: { klass: string; label: string; count: number }[];
  /** Changes the gate blocked from reaching a human at all. */
  changesBlocked: number;
  /** Changes sent for human review rather than auto-handed-off. */
  sentForReview: number;
  /** Critical security issues the deep scan caught. */
  criticalsCaught: number;
  /** MISSION outcomes: PRs the factory actually produced + whether they landed. */
  prsOpened: number;
  prsMerged: number;
  prsClosedUnmerged: number;
  /** merged / (merged + closed-unmerged); null until something has settled. The
   *  honest "does the tool's work actually ship" number, not just gate activity. */
  acceptanceRate: number | null;
  windowDays: number;
}

interface CountRow extends Record<string, unknown> { klass: string; n: number }
interface RunRow extends Record<string, unknown> { blocked: number; escalated: number; criticals: number }

const asObjWhere = (days: number) => `timestamp > now() - ($1 || ' days')::interval AND metadata->>'workspace_id' = $2`;

export async function listProtections(workspaceId: string, days = 30): Promise<ProtectionSummary> {
  const d = Math.min(Math.max(Math.trunc(days), 1), 365);

  const findings = await safeQuery<CountRow>(
    `SELECT coalesce(metadata->>'class', 'unknown') AS klass, count(*)::int AS n
       FROM instinct_events
      WHERE event_type = 'ai_code.finding_detected'
        AND ${asObjWhere(d)}
      GROUP BY 1 ORDER BY 2 DESC`,
    [String(d), workspaceId],
  );

  const runs = await safeQuery<RunRow>(
    `SELECT
       count(*) FILTER (WHERE metadata->>'final_outcome' = 'block')::int AS blocked,
       count(*) FILTER (WHERE metadata->>'status' = 'needs_human' OR metadata->>'final_outcome' = 'escalate')::int AS escalated,
       coalesce(sum((metadata->>'deep_scan_critical')::int), 0)::int AS criticals
       FROM instinct_events
      WHERE event_type = 'ai_code.pipeline_run'
        AND ${asObjWhere(d)}`,
    [String(d), workspaceId],
  );

  // MISSION outcomes: did the factory's PRs actually land? (pr_opened -> merged /
  // closed-unmerged, from the outcome telemetry). This is what tells us the tool
  // HELPS, not just that the gate ran.
  const outcomes = await safeQuery<{ opened: number; merged: number; closed: number }>(
    `SELECT
       count(*) FILTER (WHERE event_type = 'ai_code.pr_opened')::int AS opened,
       count(*) FILTER (WHERE event_type = 'ai_code.pr_merged')::int AS merged,
       count(*) FILTER (WHERE event_type = 'ai_code.pr_closed_unmerged')::int AS closed
       FROM instinct_events
      WHERE event_type IN ('ai_code.pr_opened', 'ai_code.pr_merged', 'ai_code.pr_closed_unmerged')
        AND ${asObjWhere(d)}`,
    [String(d), workspaceId],
  );

  const byClass = findings.rows.map((r) => ({ klass: r.klass, label: labelForClass(r.klass), count: Number(r.n) }));
  const totalCaught = byClass.reduce((s, r) => s + r.count, 0);
  const run = runs.rows[0] ?? { blocked: 0, escalated: 0, criticals: 0 };
  const o = outcomes.rows[0] ?? { opened: 0, merged: 0, closed: 0 };
  const settled = Number(o.merged) + Number(o.closed);

  return {
    totalCaught,
    byClass,
    changesBlocked: Number(run.blocked) || 0,
    sentForReview: Number(run.escalated) || 0,
    criticalsCaught: Number(run.criticals) || 0,
    prsOpened: Number(o.opened) || 0,
    prsMerged: Number(o.merged) || 0,
    prsClosedUnmerged: Number(o.closed) || 0,
    acceptanceRate: settled > 0 ? Number(o.merged) / settled : null,
    windowDays: d,
  };
}
