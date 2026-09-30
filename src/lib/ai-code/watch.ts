/**
 * The autonomous watcher: the factory watches its OWN open PRs and drives each one
 * step of the ci-fix loop per tick, so a human is never the poller. Runs on a
 * Vercel cron; walks every enrolled repo, finds the factory's PRs, and drives them
 * toward merge_ready over successive ticks.
 *
 * Client-safety is by construction, not by option (these are the things that keep
 * an enterprise buyer comfortable):
 *   - OPT-IN per repo: only repos in AI_CODE_WATCH_REPOS are ever touched. Unset =
 *     the watcher is disabled and does nothing.
 *   - ONLY the AI's own PRs: it acts on `factory/*` head branches exclusively -
 *     never a human's branch or a human's PR.
 *   - NEVER auto-merges: it drives to merge_ready and stops; a human approves the
 *     merge. (driveCiFixStep has no merge path.)
 *   - Bounded + audited: the same gate, the same attempt budget, and every terminal
 *     outcome recorded via ai_code.ci_fix_resolved.
 *
 * The orchestration is injectable (listPRs, drive) so it is unit-testable without
 * GitHub or a model; the cron route wires the real effects.
 *
 * The factory-branch safety predicate (never touch a human's branch) is REUSED from
 * revert.ts - one definition of "a branch the factory created".
 */
import { isFactoryBranch } from "@/lib/ai-code/revert";

/** Parse the opt-in repo allowlist. Empty/unset => the watcher is disabled. Pure. */
export function parseWatchRepos(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s));
}

export interface WatchPr {
  number: number;
  headRef: string;
  baseRef: string;
}

export interface WatchDriveResult {
  action?: string;
  terminal?: boolean;
}

export interface WatchDeps {
  repos: string[];
  /** List a repo's open PRs. */
  listPRs: (repo: string) => Promise<WatchPr[]>;
  /** Drive ONE ci-fix step for a factory PR. Returns the decision action + terminal. */
  drive: (repo: string, pr: WatchPr) => Promise<WatchDriveResult>;
}

export interface WatchSummary {
  enabled: boolean;
  /** PRs the watcher drove this tick. */
  driven: Array<{ repo: string; pr: number; action?: string; terminal?: boolean }>;
  /** factory PRs skipped by a per-PR error, so one bad PR never stalls the sweep. */
  errors: Array<{ repo: string; pr: number; error: string }>;
}

/** Run one watcher tick across every enrolled repo. Never throws: a repo or PR that
 *  errors is recorded and skipped so one failure never stalls the whole sweep. */
export async function runAiCodeWatch(deps: WatchDeps): Promise<WatchSummary> {
  if (deps.repos.length === 0) return { enabled: false, driven: [], errors: [] };
  const driven: WatchSummary["driven"] = [];
  const errors: WatchSummary["errors"] = [];
  for (const repo of deps.repos) {
    let prs: WatchPr[] = [];
    try {
      prs = (await deps.listPRs(repo)).filter((p) => isFactoryBranch(p.headRef));
    } catch {
      continue; // a repo we cannot read is skipped, not fatal
    }
    for (const pr of prs) {
      try {
        const r = await deps.drive(repo, pr);
        driven.push({ repo, pr: pr.number, action: r.action, terminal: r.terminal });
      } catch (e) {
        errors.push({ repo, pr: pr.number, error: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return { enabled: true, driven, errors };
}
