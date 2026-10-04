/**
 * Factory brain pt3-C: turn a run's CONFIRMED gate catches into failure memories
 * (producer), and turn retrieved past failures into an author-prompt warning
 * (consumer = retrieval-augmented authoring).
 *
 * "Confirmed" = the deterministic gate actually flagged it on THIS run (a
 * deep-scan finding, a blocking engineering invariant). That is the contract from
 * pt3-A: only real catches seed the memory, never model opinion. Summaries are
 * the finding's description (title / reason), never raw code - and the store
 * redacts them again on write, so the memory can never hold a secret.
 */
import type { ScanFinding } from "@/lib/platform-scan/types";
import { rememberFailures, type FailureDoc } from "./factory-failure-store";
import type { FailureHit } from "./factory-failure-index";

/** Only the catches worth remembering: critical/high findings (noise floor). */
export function confirmedFailuresFromFindings(findings: readonly ScanFinding[]): FailureDoc[] {
  const out: FailureDoc[] = [];
  for (const f of findings) {
    if (f.severity !== "critical" && f.severity !== "high") continue;
    const summary = (f.title || f.detail || "").trim();
    if (!summary) continue;
    out.push({ findingClass: f.category || "security", summary, path: f.route || "", severity: f.severity });
  }
  return out;
}

/** A blocking engineering invariant is a confirmed catch too. */
export function confirmedFailuresFromInvariant(inv: { wouldBlock: boolean; ruleId: string; reason: string }): FailureDoc[] {
  if (!inv?.wouldBlock) return [];
  const summary = (inv.reason || inv.ruleId || "").trim();
  if (!summary) return [];
  return [{ findingClass: inv.ruleId || "invariant", summary, severity: "high" }];
}

/**
 * Persist a run's confirmed catches to the failure memory. Best-effort + never
 * throws (called fire-and-forget from the pipeline). Returns the count written.
 */
export async function rememberRunFailures(args: {
  workspaceId: string;
  repo: string;
  findings?: readonly ScanFinding[];
  invariant?: { wouldBlock: boolean; ruleId: string; reason: string };
}): Promise<{ written: number }> {
  try {
    const docs = [
      ...confirmedFailuresFromFindings(args.findings ?? []),
      ...(args.invariant ? confirmedFailuresFromInvariant(args.invariant) : []),
    ];
    if (docs.length === 0) return { written: 0 };
    return await rememberFailures({ workspaceId: args.workspaceId, repo: args.repo, docs });
  } catch {
    return { written: 0 };
  }
}

/**
 * The author-prompt block from retrieved past failures. Empty string when there
 * is nothing to warn about, so it adds no noise on a cold memory. Pure.
 */
export function buildFailureAvoidanceBlock(hits: readonly FailureHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.slice(0, 6).map((h) => `- ${h.findingClass}: ${h.summary}${h.path ? ` (previously in ${h.path})` : ""}`);
  return [
    "AVOID PAST FAILURES - the gate has CAUGHT these in this repo before. Do NOT",
    "reintroduce them; write the change so none of these recur:",
    ...lines,
  ].join("\n");
}
