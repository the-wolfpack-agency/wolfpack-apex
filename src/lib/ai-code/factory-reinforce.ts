/**
 * Factory brain #2, pt2: reinforce/decay memory confidence from REAL PR outcomes.
 *
 * When a factory PR MERGES, the memories the brain gave that run helped ship -
 * raise their confidence. When it's CLOSED UNMERGED, the run was rejected - lower
 * it. The join is: PR -> approval_id (pr_opened) -> provenance rows -> the reuse
 * paths + failure signatures that run used. Weight-aware retrieval (already live)
 * then surfaces proven memories first and lets doubtful ones fade.
 *
 * Confidence is clamped in the stores, so this can't runaway or zero a memory out.
 * Never throws (best-effort learning). Deps injected for hermetic tests.
 */
import { loadProvenanceByApproval, type ProvenanceEntry } from "./factory-provenance";
import { adjustReuseConfidence } from "./factory-reuse-store";
import { adjustFailureConfidence } from "./factory-failure-store";

/** A merged PR's memories helped ship; a rejected PR's are suspect. */
export const REINFORCE_FACTOR = 1.15;
export const DECAY_FACTOR = 0.7;

export interface ReinforceDeps {
  loadProvenance: (workspaceId: string, approvalId: string) => Promise<ProvenanceEntry[]>;
  adjustReuse: (workspaceId: string, repo: string, paths: string[], factor: number) => Promise<{ adjusted: number }>;
  adjustFailure: (workspaceId: string, repo: string, signatures: string[], factor: number) => Promise<{ adjusted: number }>;
}

const defaultDeps: ReinforceDeps = {
  loadProvenance: loadProvenanceByApproval,
  adjustReuse: adjustReuseConfidence,
  adjustFailure: adjustFailureConfidence,
};

/**
 * Apply an outcome to the memories a handoff used. `merged` -> reinforce, else
 * decay. No-op without an approvalId (a run with no provenance). Never throws.
 * Returns how many reuse + failure memories were adjusted.
 */
export async function reinforceFromOutcome(args: {
  workspaceId: string;
  repo: string;
  approvalId?: string;
  merged: boolean;
  deps?: ReinforceDeps;
}): Promise<{ reuse: number; failure: number }> {
  const { workspaceId, repo, approvalId, merged } = args;
  if (!approvalId) return { reuse: 0, failure: 0 };
  const deps = args.deps ?? defaultDeps;
  const factor = merged ? REINFORCE_FACTOR : DECAY_FACTOR;
  try {
    const entries = await deps.loadProvenance(workspaceId, approvalId);
    const reusePaths = entries.filter((e) => e.kind === "reuse").map((e) => e.key);
    const failureSigs = entries.filter((e) => e.kind === "failure").map((e) => e.key);
    const [r, f] = await Promise.all([
      deps.adjustReuse(workspaceId, repo, reusePaths, factor),
      deps.adjustFailure(workspaceId, repo, failureSigs, factor),
    ]);
    return { reuse: r.adjusted, failure: f.adjusted };
  } catch {
    return { reuse: 0, failure: 0 };
  }
}
