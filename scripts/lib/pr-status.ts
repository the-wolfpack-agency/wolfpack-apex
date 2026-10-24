/**
 * Pure logic for `npm run pr:status`: CI rollup and merge-readiness grouping.
 * The runner (scripts/pr-status.ts) fetches; nothing here touches the network.
 */

/**
 * Repositories where merging to the default branch deploys to production
 * (Vercel git integration or a push-to-main deploy workflow). A PR in one of
 * these is a production change the moment it merges, so pr:status says so.
 * Keep this list in sync when a repository's deploy wiring changes.
 */
export const DEPLOYS_PRODUCTION_ON_MERGE: readonly string[] = [
  "wolfpack-weekend",
  "OGIAM",
  "wolfpack-aidan-mulready",
  "wolfpack-feed",
  "wolfpack-apex",
];

/** A check run (Checks API) on the PR head commit. */
export interface CheckRunRow {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion: string | null; // success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | startup_failure
}

/** A commit status (Statuses API), e.g. Vercel's deploy status. */
export interface StatusRow {
  id: number;
  context: string;
  state: string; // success | failure | error | pending
}

export interface CiRollup {
  pass: number;
  fail: number;
  pending: number;
  skipped: number;
  failing: string[];
  pendingNames: string[];
}

const PASS = new Set(["success", "neutral"]);
const SKIP = new Set(["skipped"]);

/**
 * Count checks, latest run per name only: a re-run supersedes the failure it
 * replaced, so counting both would report a fixed PR as blocked.
 */
export function rollupChecks(runs: CheckRunRow[], statuses: StatusRow[]): CiRollup {
  const latestRun = new Map<string, CheckRunRow>();
  for (const r of runs) {
    const prev = latestRun.get(r.name);
    if (!prev || r.id > prev.id) latestRun.set(r.name, r);
  }
  const latestStatus = new Map<string, StatusRow>();
  for (const s of statuses) {
    const prev = latestStatus.get(s.context);
    if (!prev || s.id > prev.id) latestStatus.set(s.context, s);
  }
  const out: CiRollup = { pass: 0, fail: 0, pending: 0, skipped: 0, failing: [], pendingNames: [] };
  for (const r of latestRun.values()) {
    if (r.status !== "completed") {
      out.pending += 1;
      out.pendingNames.push(r.name);
    } else if (r.conclusion && PASS.has(r.conclusion)) out.pass += 1;
    else if (r.conclusion && SKIP.has(r.conclusion)) out.skipped += 1;
    else {
      out.fail += 1;
      out.failing.push(r.name);
    }
  }
  for (const s of latestStatus.values()) {
    if (s.state === "success") out.pass += 1;
    else if (s.state === "pending") {
      out.pending += 1;
      out.pendingNames.push(s.context);
    } else {
      out.fail += 1;
      out.failing.push(s.context);
    }
  }
  out.failing.sort();
  out.pendingNames.sort();
  return out;
}

export interface PrInfo {
  repo: string; // name only, e.g. wolfpack-apex
  number: number;
  url: string;
  title: string;
  createdAt: string;
  draft: boolean;
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  /** clean | unstable | blocked | behind | dirty | draft | has_hooks | unknown */
  mergeableState: string;
  ci: CiRollup;
}

export type Group = "ready" | "waiting" | "blocked";

export interface Classified extends PrInfo {
  group: Group;
  reasons: string[];
  deploysProduction: boolean;
  ageDays: number;
}

/**
 * Ready to merge: no failing and no pending checks, mergeable, not a draft.
 * Blocked: a failing check, a conflict, a draft, or branch protection unmet.
 * Waiting on CI: anything still running (or mergeability still computing).
 */
export function classify(pr: PrInfo, now: Date = new Date()): Classified {
  const reasons: string[] = [];
  if (pr.ci.fail > 0) reasons.push(`failing: ${pr.ci.failing.join(", ")}`);
  if (pr.mergeable === false || pr.mergeableState === "dirty") reasons.push("merge conflict");
  if (pr.draft) reasons.push("draft");
  if (pr.mergeableState === "blocked" && pr.ci.fail === 0 && pr.ci.pending === 0) reasons.push("branch protection not satisfied (review or required check)");

  let group: Group;
  if (reasons.length) group = "blocked";
  else if (pr.ci.pending > 0 || pr.mergeable === null || pr.mergeableState === "unknown") {
    group = "waiting";
    if (pr.ci.pending > 0) reasons.push(`pending: ${pr.ci.pendingNames.join(", ")}`);
    else reasons.push("GitHub is still computing mergeability");
  } else group = "ready";

  return {
    ...pr,
    group,
    reasons,
    deploysProduction: DEPLOYS_PRODUCTION_ON_MERGE.includes(pr.repo),
    ageDays: Math.max(0, Math.floor((now.getTime() - new Date(pr.createdAt).getTime()) / 86_400_000)),
  };
}

export function humanAge(createdAt: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const GROUP_TITLES: Record<Group, string> = {
  ready: "Ready to merge",
  waiting: "Waiting on CI",
  blocked: "Blocked",
};

export function renderText(prs: Classified[], now: Date = new Date()): string {
  const lines: string[] = [];
  for (const g of ["ready", "waiting", "blocked"] as Group[]) {
    const list = prs.filter((p) => p.group === g).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    lines.push(`## ${GROUP_TITLES[g]} (${list.length})`);
    lines.push("");
    for (const p of list) {
      lines.push(`- ${p.url}`);
      lines.push(`  ${p.title}`);
      const ci = `CI pass ${p.ci.pass}, fail ${p.ci.fail}, pending ${p.ci.pending}, skipped ${p.ci.skipped}`;
      const merge = `mergeable ${p.mergeable === null ? "unknown" : p.mergeable ? "yes" : "no"} (${p.mergeableState})`;
      lines.push(`  age ${humanAge(p.createdAt, now)} | ${ci} | ${merge}${p.deploysProduction ? " | deploys production on merge" : ""}`);
      for (const r of p.reasons) lines.push(`  ${r}`);
    }
    if (!list.length) lines.push("- none");
    lines.push("");
  }
  return lines.join("\n");
}

export interface PrStatusArgs {
  since: string | null;
  json: boolean;
}

export function parsePrStatusArgs(argv: string[]): PrStatusArgs | { error: string } {
  const i = argv.indexOf("--since");
  let since: string | null = null;
  if (i > -1) {
    since = argv[i + 1] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) return { error: "--since takes a date as YYYY-MM-DD." };
  }
  for (const a of argv) if (a.startsWith("--") && a !== "--since" && a !== "--json") return { error: `Unknown flag ${a}.` };
  return { since, json: argv.includes("--json") };
}

/** GitHub search qualifiers for the user's open PRs in the org. */
export function searchQuery(org: string, since: string | null): string {
  return ["is:pr", "is:open", "author:@me", `org:${org}`, ...(since ? [`created:>=${since}`] : [])].join(" ");
}
