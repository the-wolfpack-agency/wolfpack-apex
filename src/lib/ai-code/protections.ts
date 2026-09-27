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

  const byClass = findings.rows.map((r) => ({ klass: r.klass, label: labelForClass(r.klass), count: Number(r.n) }));
  const totalCaught = byClass.reduce((s, r) => s + r.count, 0);
  const run = runs.rows[0] ?? { blocked: 0, escalated: 0, criticals: 0 };

  return {
    totalCaught,
    byClass,
    changesBlocked: Number(run.blocked) || 0,
    sentForReview: Number(run.escalated) || 0,
    criticalsCaught: Number(run.criticals) || 0,
    windowDays: d,
  };
}
