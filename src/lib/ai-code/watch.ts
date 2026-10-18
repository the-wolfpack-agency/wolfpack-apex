/**
 * The autonomous watcher: the factory watches its OWN open PRs and drives each one
 * step of the ci-fix loop per tick, so a human is never the poller. Runs on a
 * Vercel cron; walks every enrolled (workspace, repo) TARGET, finds the factory's
 * PRs, and drives them toward merge_ready over successive ticks.
 *
 * Multi-tenant by construction: each target carries its OWN workspace, so the cron
 * drives every client's repos with that client's credentials + entitlement, from a
 * single deployment. Enrolled repos are DB config (watched-repos.ts), not env.
 *
 * Client-safety is by construction, not by option:
 *   - OPT-IN per (workspace, repo): only enrolled targets are ever touched.
 *   - ONLY the AI's own PRs BY DEFAULT: it acts on `factory/*` head branches, OR a
 *     human PR that EXPLICITLY opted in with the `ci-autofix` label. An unlabeled
 *     human branch is never touched (the loop auto-commits, so opt-in is required).
 *   - NEVER auto-merges: it drives to merge_ready and stops; a human approves.
 *   - Bounded + audited: same gate, same attempt budget, every terminal outcome
 *     recorded via ai_code.ci_fix_resolved.
 *   - REMEMBERS a dead end: a PR that ended in escalate_human is parked at its head
 *     commit and not driven again until that commit changes (watch-parking.ts).
 *     Without this, a stuck PR was re-authored every tick (144 model calls a day
 *     each), the largest line on the Azure bill for ten days.
 *
 * The orchestration is injectable (listPRs, drive) so it is unit-testable without
 * GitHub or a model; the cron route wires the real effects. The factory-branch
 * predicate is REUSED from revert.ts - one definition of "a branch the factory
 * created".
 */
import { isFactoryBranch } from "@/lib/ai-code/revert";

/** One thing the watcher drives: a repo in a specific workspace. */
export interface WatchTarget {
  workspaceId: string;
  repo: string;
}

export interface WatchPr {
  number: number;
  headRef: string;
  baseRef: string;
  /** The head commit. Needed to park a terminal outcome; a PR without it is never
   *  parked (exact prior behavior). */
  headSha?: string;
  /** PR labels, so a HAND-authored PR can OPT IN to auto-triage. Absent/undefined
   *  => only the factory-branch rule applies (exact prior behavior). */
  labels?: readonly string[];
}

/** The opt-in label a human adds to a non-factory PR to request auto-triage. The
 *  loop AUTO-COMMITS fixes, so a human's branch is touched ONLY with this explicit
 *  opt-in - never by default. */
export const AUTOFIX_LABEL = "ci-autofix";

/** A PR the watcher may act on: the AI's own factory branch (always), OR any PR a
 *  human explicitly opted in with the AUTOFIX_LABEL. Anything else is never touched.
 *  Pure - the single eligibility rule, reused by the sweep + the cron wiring. */
export function isAutoTriageEligible(pr: WatchPr): boolean {
  return isFactoryBranch(pr.headRef) || !!pr.labels?.includes(AUTOFIX_LABEL);
}

export interface WatchDeps {
  targets: WatchTarget[];
  /** List a target repo's open PRs (with that workspace's client). */
  listPRs: (target: WatchTarget) => Promise<WatchPr[]>;
  /** Drive ONE ci-fix step for a factory PR in that target's workspace. */
  drive: (target: WatchTarget, pr: WatchPr) => Promise<WatchDriveResult>;
  /** Is this PR parked at its current head commit? Absent = nothing is parked. */
  isParked?: (target: WatchTarget, pr: WatchPr & { headSha: string }) => Promise<boolean>;
  /** Park a PR at its head after an escalate_human outcome. Absent = never parks. */
  park?: (target: WatchTarget, pr: WatchPr & { headSha: string }, result: WatchDriveResult) => Promise<void>;
}

export interface WatchDriveResult {
  action?: string;
  terminal?: boolean;
  reason?: string;
}

/** A terminal outcome that needs a human: asking the model again cannot change it
 *  until the PR changes (pure). merge_ready is not parked: it costs no model call. */
export function shouldPark(r: WatchDriveResult): boolean {
  return r.terminal === true && r.action === "escalate_human";
}

export interface WatchSummary {
  enabled: boolean;
  driven: Array<{ workspaceId: string; repo: string; pr: number; action?: string; terminal?: boolean }>;
  /** PRs skipped because they are parked at their current head (no model call). */
  parked: Array<{ workspaceId: string; repo: string; pr: number }>;
  /** factory PRs skipped by a per-PR error, so one bad PR never stalls the sweep. */
  errors: Array<{ workspaceId: string; repo: string; pr: number; error: string }>;
}

/** Run one watcher tick across every enrolled target. Never throws: a target or PR
 *  that errors is recorded and skipped so one failure never stalls the sweep. */
export async function runAiCodeWatch(deps: WatchDeps): Promise<WatchSummary> {
  if (deps.targets.length === 0) return { enabled: false, driven: [], parked: [], errors: [] };
  const driven: WatchSummary["driven"] = [];
  const parked: WatchSummary["parked"] = [];
  const errors: WatchSummary["errors"] = [];
  for (const target of deps.targets) {
    let prs: WatchPr[] = [];
    try {
      prs = (await deps.listPRs(target)).filter(isAutoTriageEligible);
    } catch {
      continue; // a target we cannot read is skipped, not fatal
    }
    for (const pr of prs) {
      try {
        const sha = pr.headSha;
        if (sha && deps.isParked && (await deps.isParked(target, { ...pr, headSha: sha }))) {
          parked.push({ workspaceId: target.workspaceId, repo: target.repo, pr: pr.number });
          continue;
        }
        const r = await deps.drive(target, pr);
        if (sha && deps.park && shouldPark(r)) await deps.park(target, { ...pr, headSha: sha }, r);
        driven.push({ workspaceId: target.workspaceId, repo: target.repo, pr: pr.number, action: r.action, terminal: r.terminal });
      } catch (e) {
        errors.push({ workspaceId: target.workspaceId, repo: target.repo, pr: pr.number, error: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return { enabled: true, driven, parked, errors };
}
