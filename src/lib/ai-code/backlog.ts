/**
 * The automation backlog: WHERE HUMANS ARE STILL NEEDED, derived from the factory's
 * own terminal ci-fix outcomes (ai_code.ci_fix_resolved). Every escalate_human is a
 * spot the factory could not stay autonomous; aggregating them by class is the
 * ranked list of what to automate next - written by dogfooding, not guessed. Every
 * merge_ready is an autonomous win, so the ratio is the honest autonomy rate.
 *
 * The read mirrors runs.ts (instinct_events, workspace-scoped, safeQuery/never
 * throws); the summarizer is pure so the ranking is reproducible and unit-tested.
 */
import { safeQuery } from "@/lib/db";

export interface CiFixOutcome {
  action: "merge_ready" | "escalate_human" | string;
  /** governance | ambiguous_spec | infra_no_detail | preexisting_only | lint | type | ... */
  class: string;
  reason: string;
  repo: string;
  ref: string;
  createdAt: string;
}

export interface AutomationBacklog {
  total: number;
  /** Terminal outcomes the factory resolved on its own (green, ready to merge). */
  autonomous: number;
  /** Terminal outcomes handed to a human. */
  escalated: number;
  /** autonomous / total, 0..1. The headline "how self-sufficient is the factory". */
  autonomyRate: number;
  /** Escalations grouped by class, most-common first: the ranked automation backlog. */
  byClass: Array<{ class: string; count: number }>;
  /** The most recent escalations, so an operator sees the concrete cases. */
  recent: Array<{ repo: string; ref: string; class: string; reason: string; createdAt: string }>;
}

interface Row {
  metadata: Record<string, unknown> | string;
  timestamp: string;
}

function asObj(m: Row["metadata"]): Record<string, unknown> {
  if (typeof m === "string") {
    try { return JSON.parse(m) as Record<string, unknown>; } catch { return {}; }
  }
  return m ?? {};
}
const str = (v: unknown, dflt = ""): string => (typeof v === "string" && v.length > 0 ? v : dflt);

/** Read a workspace's terminal ci-fix outcomes within the window. NEVER throws. */
export async function listCiFixOutcomes(workspaceId: string, days = 30): Promise<CiFixOutcome[]> {
  const d = Math.min(Math.max(Math.trunc(days), 1), 365);
  const { rows } = await safeQuery<Row>(
    `SELECT metadata, timestamp::text AS timestamp
       FROM instinct_events
      WHERE event_type = 'ai_code.ci_fix_resolved'
        AND metadata->>'workspace_id' = $1
        AND timestamp > now() - ($2 || ' days')::interval
      ORDER BY timestamp DESC
      LIMIT 1000`,
    [workspaceId, String(d)],
  );
  return rows.map((r) => {
    const m = asObj(r.metadata);
    return {
      action: str(m.action, "escalate_human"),
      class: str(m.class, "other"),
      reason: str(m.reason),
      repo: str(m.repo, "(unknown)"),
      ref: str(m.ref, "(unknown)"),
      createdAt: r.timestamp,
    };
  });
}

/** Summarize outcomes into the autonomy rate + the ranked backlog. Pure. */
export function summarizeAutomationBacklog(outcomes: readonly CiFixOutcome[], recentLimit = 20): AutomationBacklog {
  const total = outcomes.length;
  const autonomous = outcomes.filter((o) => o.action === "merge_ready").length;
  const escalated = outcomes.filter((o) => o.action === "escalate_human").length;
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.action !== "escalate_human") continue;
    counts.set(o.class, (counts.get(o.class) ?? 0) + 1);
  }
  const byClass = [...counts.entries()]
    .map(([cls, count]) => ({ class: cls, count }))
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
  const recent = outcomes
    .filter((o) => o.action === "escalate_human")
    .slice(0, Math.max(1, recentLimit))
    .map((o) => ({ repo: o.repo, ref: o.ref, class: o.class, reason: o.reason, createdAt: o.createdAt }));
  return {
    total,
    autonomous,
    escalated,
    autonomyRate: total > 0 ? autonomous / total : 0,
    byClass,
    recent,
  };
}
