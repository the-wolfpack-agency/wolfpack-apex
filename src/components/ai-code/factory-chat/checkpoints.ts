/**
 * Pure: turn a pipeline result (+ optional post-PR CI) into the client-facing
 * checkpoint track. Every checkpoint reflects a REAL signal from the response -
 * no simulated progress. We surface the outcome (passed / blocked / held), never
 * the rule or detector that produced it.
 */
import type { Checkpoint, PipelineResult, CiDashboardLite } from "./types";

const len = (a: unknown[] | null | undefined): number => (Array.isArray(a) ? a.length : 0);

/**
 * The synchronous gate checkpoints, in the order a client reads them. All resolve
 * from the single pipeline response (the gate runs server-side in one request).
 */
export function deriveGateCheckpoints(r: PipelineResult): Checkpoint[] {
  const hasDiff = !!(r.run?.diff && r.run.diff.trim()) || !!r.executor?.author;
  const generated: Checkpoint = r.executor?.error && !hasDiff
    ? { id: "generated", label: "Code generated", status: "blocked", detail: "The model could not produce a usable change." }
    : { id: "generated", label: "Code generated", status: hasDiff ? "clear" : "pending" };

  const security: Checkpoint = {
    id: "security",
    label: "Security checks",
    status: r.deepScan?.blocking || (r.deepScan?.critical ?? 0) > 0 ? "blocked" : "clear",
    detail: r.deepScan?.blocking ? "A critical security issue was caught and withheld." : "No security issues in the authored change.",
  };

  const dedupe: Checkpoint = {
    id: "duplication",
    label: "No duplication (DRY)",
    status: r.duplication?.escalate ? "blocked" : "clear",
    detail: r.duplication?.escalate ? "The change re-implements existing code; held for reuse." : undefined,
  };

  const compliance: Checkpoint = {
    id: "compliance",
    label: "Compliance & invariants",
    status: r.invariants?.wouldBlock ? "blocked" : "clear",
    detail: r.invariants?.wouldBlock ? "An engineering invariant blocked the change." : undefined,
  };

  const integrityOk =
    (r.syntax?.ok ?? true) &&
    len(r.phantomImports) === 0 &&
    len(r.incompleteFiles) === 0 &&
    len(r.removedExports) === 0 &&
    len(r.anchorFailures) === 0 &&
    len(r.brokenLocalImports) === 0;
  const integrity: Checkpoint = {
    id: "integrity",
    label: "Code integrity",
    status: integrityOk ? "clear" : "blocked",
    detail: integrityOk ? undefined : "Syntax, imports, or completeness checks did not pass.",
  };

  const status = r.run?.status;
  const verdict: Checkpoint =
    status === "ready_for_pr"
      ? { id: "verdict", label: "Ready for review", status: "clear", detail: "Passed the gate; awaiting human approval." }
      : { id: "verdict", label: "Ready for review", status: "held", detail: "Held for a human - the gate did not clear an auto-handoff." };

  return [generated, security, dedupe, compliance, integrity, verdict];
}

/** Map the post-PR CI dashboard into client-facing test checkpoints. */
export function deriveCiCheckpoints(ci: CiDashboardLite | null | undefined): Checkpoint[] {
  if (!ci) return [];
  const map: Record<string, CheckpointStatusInput> = {
    pass: "clear", fail: "blocked", pending: "pending", absent: "pending",
  };
  return ci.categories.map((c) => ({
    id: `ci:${c.key}`,
    label: c.label,
    status: map[c.status] ?? "pending",
  }));
}
type CheckpointStatusInput = Checkpoint["status"];

/** The full track: synchronous gate, then (once a PR is open) the CI suite. */
export function deriveCheckpoints(r: PipelineResult | null | undefined, ci?: CiDashboardLite | null): Checkpoint[] {
  if (!r) return [];
  return [...deriveGateCheckpoints(r), ...deriveCiCheckpoints(ci)];
}

/** A compact overall read for the bubble header. */
export function trackSummary(checkpoints: readonly Checkpoint[]): { clear: number; total: number; blocked: number; held: number } {
  let clear = 0, blocked = 0, held = 0;
  for (const c of checkpoints) {
    if (c.status === "clear") clear++;
    else if (c.status === "blocked") blocked++;
    else if (c.status === "held") held++;
  }
  return { clear, total: checkpoints.length, blocked, held };
}
