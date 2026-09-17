/**
 * Labeled-dataset export - the governance executions turned into a corpus for
 * evaluation and fine-tuning, built from the SAME records as the rollup.
 *
 * WHY THE LABELS ARE GOOD: the label on each example is the platform's OWN
 * deterministic decision - the gate's allow/escalate/block verdict, or whether a
 * decoy touch was contained. That is ground truth by construction, not a human
 * guess after the fact, which is exactly what a useful eval/fine-tune set needs.
 *
 * WHAT IS DELIBERATELY NOT HERE: the raw diff and the raw action payload. Those
 * can carry secrets, and the whole platform exists to keep secrets out of places
 * they leak. The export is DECISION-LEVEL: labels plus safe, structural features
 * (severity, finding count, risk tier), never the sensitive input. Per-finding
 * features can extend this later from the stored findings, still without the diff.
 *
 * Readers are injected (reusing the rollup's readers), so this is unit-testable
 * with no DB; liveDatasetDeps wires the real ones.
 */
import { listReviews, type ReviewRecord } from "@/lib/ai-code/store";
import { listCanaryTrips, type CanaryTrip } from "@/lib/forcefield/triage";

export interface DatasetExample {
  source: "secure_agent" | "forcefield";
  /** Ground-truth label: the deterministic decision the platform made. */
  label: string;
  /** Safe, structural features only. Never the raw diff / payload. */
  features: Record<string, string | number>;
  ref: string;
  at: string;
}

export interface DatasetExport {
  examples: DatasetExample[];
  counts: { secureAgent: number; forcefield: number; total: number };
}

export interface DatasetDeps {
  listReviews: (workspaceId: string, limit?: number) => Promise<ReviewRecord[]>;
  listTrips: (workspaceId: string, limit?: number) => Promise<CanaryTrip[]>;
}

export function liveDatasetDeps(): DatasetDeps {
  return {
    listReviews: (ws, limit) => listReviews(ws, limit),
    listTrips: (ws, limit) => listCanaryTrips(ws, limit),
  };
}

const PAGE = 500;

export async function buildDataset(workspaceId: string, deps: DatasetDeps): Promise<DatasetExport> {
  const [reviews, trips] = await Promise.all([
    deps.listReviews(workspaceId, PAGE),
    deps.listTrips(workspaceId, PAGE),
  ]);

  const secureAgent: DatasetExample[] = reviews.map((r) => ({
    source: "secure_agent",
    label: r.outcome, // allow | escalate | block - the gate's verdict
    features: {
      author: r.author ?? "unknown",
      highestSeverity: r.highestSeverity ?? "none",
      findingCount: r.findingCount,
    },
    ref: r.ref,
    at: r.createdAt,
  }));

  const forcefield: DatasetExample[] = trips.map((t) => ({
    source: "forcefield",
    label: t.contained ? "contained" : "monitored",
    features: {
      riskTier: t.riskTier,
      agent: t.agent,
    },
    ref: t.id,
    at: t.whenIso,
  }));

  const examples = [...secureAgent, ...forcefield];
  return {
    examples,
    counts: { secureAgent: secureAgent.length, forcefield: forcefield.length, total: examples.length },
  };
}

/** JSONL: one example per line, the format eval/fine-tune tooling ingests. */
export function toJsonl(examples: readonly DatasetExample[]): string {
  return examples.map((e) => JSON.stringify(e)).join("\n");
}
