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

export interface WatchDriveResult {
  action?: string;
  terminal?: boolean;
}

export interface WatchDeps {
  targets: WatchTarget[];
  /** List a target repo's open PRs (with that workspace's client). */
  listPRs: (target: WatchTarget) => Promise<WatchPr[]>;
  /** Drive ONE ci-fix step for a factory PR in that target's workspace. */
  drive: (target: WatchTarget, pr: WatchPr) => Promise<WatchDriveResult>;
}

export interface WatchSummary {
  enabled: boolean;
  driven: Array<{ workspaceId: string; repo: string; pr: number; action?: string; terminal?: boolean }>;
  /** factory PRs skipped by a per-PR error, so one bad PR never stalls the sweep. */
  errors: Array<{ workspaceId: string; repo: string; pr: number; error: string }>;
}

/** Run one watcher tick across every enrolled target. Never throws: a target or PR
 *  that errors is recorded and skipped so one failure never stalls the sweep. */
export async function runAiCodeWatch(deps: WatchDeps): Promise<WatchSummary> {
  if (deps.targets.length === 0) return { enabled: false, driven: [], errors: [] };
  const driven: WatchSummary["driven"] = [];
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
        const r = await deps.drive(target, pr);
        driven.push({ workspaceId: target.workspaceId, repo: target.repo, pr: pr.number, action: r.action, terminal: r.terminal });
      } catch (e) {
        errors.push({ workspaceId: target.workspaceId, repo: target.repo, pr: pr.number, error: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return { enabled: true, driven, errors };
}
