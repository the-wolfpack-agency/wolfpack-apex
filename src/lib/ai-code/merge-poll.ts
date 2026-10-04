/**
 * Merge-outcome poller - completes the factory's MISSION telemetry.
 *
 * ai_code.pr_opened records that a reviewable PR was produced. This closes the
 * loop: did a human actually MERGE it (the real win) or CLOSE it unmerged
 * (rejected / superseded)? Those outcomes are what tell us whether the tool
 * helps, not just whether the gate ran.
 *
 * The decision core (classifyOutcomes) is PURE - same inputs, same emitted
 * outcomes - so it is fully unit-testable without a DB or GitHub. The
 * orchestrator takes every IO as an injected dependency (DRY + testable, same
 * shape as author.ts), and the cron wires the real implementations.
 */
export interface OpenedPr {
  repo: string;
  prNumber: number;
  /** The handoff that opened this PR (pr_opened.approval_id) - the join key to the
   *  memories that run used, for confidence reinforcement. Absent on older PRs. */
  approvalId?: string;
}
export interface PrState {
  merged: boolean;
  /** closed WITHOUT merging */
  closedUnmerged: boolean;
}
export type MergeEvent = "ai_code.pr_merged" | "ai_code.pr_closed_unmerged";
export interface MergeOutcome {
  repo: string;
  prNumber: number;
  event: MergeEvent;
  /** Carried through from the opened PR so reinforcement can find its memories. */
  approvalId?: string;
}

const keyOf = (repo: string, prNumber: number) => `${repo}#${prNumber}`;

/**
 * PURE: for each opened PR not already reported, emit a terminal outcome when its
 * state has settled (merged, or closed-unmerged). A still-open PR emits nothing
 * (checked again next poll). A PR with no readable state is skipped (not guessed).
 */
export function classifyOutcomes(
  opened: readonly OpenedPr[],
  stateOf: (repo: string, prNumber: number) => PrState | null,
  alreadyReported: ReadonlySet<string>,
): MergeOutcome[] {
  const out: MergeOutcome[] = [];
  const seen = new Set<string>();
  for (const o of opened) {
    const key = keyOf(o.repo, o.prNumber);
    if (alreadyReported.has(key) || seen.has(key)) continue; // dedupe: terminal once
    const s = stateOf(o.repo, o.prNumber);
    if (!s) continue; // unreadable -> never guess an outcome
    if (s.merged) { out.push({ repo: o.repo, prNumber: o.prNumber, event: "ai_code.pr_merged", approvalId: o.approvalId }); seen.add(key); }
    else if (s.closedUnmerged) { out.push({ repo: o.repo, prNumber: o.prNumber, event: "ai_code.pr_closed_unmerged", approvalId: o.approvalId }); seen.add(key); }
    // still open -> nothing yet
  }
  return out;
}

export interface MergePollDeps {
  loadOpenedPrs: () => Promise<OpenedPr[]>;
  loadAlreadyReported: () => Promise<Set<string>>;
  prState: (repo: string, prNumber: number) => Promise<PrState | null>;
  emit: (event: MergeEvent, repo: string, prNumber: number) => Promise<void>;
  /** Optional: apply the outcome to the memories the handoff used (confidence
   *  reinforce on merge / decay on reject). Best-effort; a failure never aborts. */
  reinforce?: (outcome: MergeOutcome) => Promise<void>;
}

/** Orchestrate one poll: load opened + already-reported, fetch each state, emit
 *  the settled outcomes. Never throws - a single PR's read failure skips it. */
export async function pollMergeOutcomes(deps: MergePollDeps): Promise<MergeOutcome[]> {
  const [opened, alreadyReported] = await Promise.all([deps.loadOpenedPrs(), deps.loadAlreadyReported()]);
  const stateCache = new Map<string, PrState | null>();
  for (const o of opened) {
    const key = keyOf(o.repo, o.prNumber);
    if (alreadyReported.has(key) || stateCache.has(key)) continue;
    stateCache.set(key, await deps.prState(o.repo, o.prNumber).catch(() => null));
  }
  const outcomes = classifyOutcomes(opened, (repo, n) => stateCache.get(keyOf(repo, n)) ?? null, alreadyReported);
  for (const o of outcomes) {
    await deps.emit(o.event, o.repo, o.prNumber).catch(() => {});
    if (deps.reinforce) await deps.reinforce(o).catch(() => {});
  }
  return outcomes;
}
