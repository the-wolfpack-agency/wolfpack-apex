/**
 * Every OPEN pull request you authored across the the-wolfpack-agency org,
 * grouped by what it needs next.
 *
 *   npm run pr:status
 *   npm run pr:status -- --since 2026-10-20     # only PRs created on or after the date
 *   npm run pr:status -- --json                 # machine-readable
 *
 * Per PR: full URL, title, age, CI rollup (pass, fail, pending, skipped, and
 * the failing check names, latest run per check), mergeable state, and
 * "deploys production on merge" for the repositories in
 * DEPLOYS_PRODUCTION_ON_MERGE (scripts/lib/pr-status.ts).
 *
 * Read-only: GETs through scripts/security/lib/gh.ts with your `gh auth login`
 * session. Runs locally, so it prints full detail.
 *
 * Exit: 0 listed, 2 could not run.
 */
import { ghGet, ghPaginate } from "./security/lib/gh";
import { mapPool } from "./security/lib/report";
import { classify, parsePrStatusArgs, renderText, rollupChecks, searchQuery, type CheckRunRow, type PrInfo, type StatusRow } from "./lib/pr-status";

const ORG = "the-wolfpack-agency";

interface SearchItem {
  number: number;
  html_url: string;
  title: string;
  created_at: string;
  draft?: boolean;
  repository_url: string;
}

interface PullRow {
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { sha: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadPr(item: SearchItem): Promise<PrInfo | { error: string; url: string }> {
  const fullName = item.repository_url.replace("https://api.github.com/repos/", "");
  const repo = fullName.split("/")[1];
  let pull = await ghGet<PullRow>(`repos/${fullName}/pulls/${item.number}`);
  // GitHub computes mergeability lazily: the first read often says null.
  if (pull.ok && pull.data.mergeable === null) {
    await sleep(1500);
    pull = await ghGet<PullRow>(`repos/${fullName}/pulls/${item.number}`);
  }
  if (!pull.ok) return { error: `could not read the PR (${pull.status ?? "error"})`, url: item.html_url };
  const sha = pull.data.head.sha;
  const [runs, statuses] = await Promise.all([
    ghPaginate<CheckRunRow>(`repos/${fullName}/commits/${sha}/check-runs?per_page=100`, "check_runs"),
    ghGet<{ statuses: StatusRow[] }>(`repos/${fullName}/commits/${sha}/status?per_page=100`),
  ]);
  if (!runs.ok) return { error: `could not read checks (${runs.status ?? "error"})`, url: item.html_url };
  return {
    repo,
    number: item.number,
    url: item.html_url,
    title: item.title,
    createdAt: item.created_at,
    draft: pull.data.draft,
    mergeable: pull.data.mergeable,
    mergeableState: pull.data.mergeable_state,
    ci: rollupChecks(runs.data, statuses.ok ? statuses.data.statuses : []),
  };
}

async function main(): Promise<number> {
  const args = parsePrStatusArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`${args.error}\nUsage: npm run pr:status -- [--since YYYY-MM-DD] [--json]\n`);
    return 2;
  }
  const q = encodeURIComponent(searchQuery(ORG, args.since));
  const found = await ghPaginate<SearchItem>(`search/issues?q=${q}&per_page=100`, "items");
  if (!found.ok) {
    process.stderr.write(`GitHub search failed (${found.status ?? "error"}): ${found.message}\nSigned in? gh auth status\n`);
    return 2;
  }
  const loaded = await mapPool(found.data, 6, loadPr);
  const now = new Date();
  const prs = loaded.filter((p): p is PrInfo => !("error" in p)).map((p) => classify(p, now));
  const errors = loaded.filter((p): p is { error: string; url: string } => "error" in p);

  if (args.json) {
    process.stdout.write(JSON.stringify({ generatedAt: now.toISOString(), since: args.since, prs, errors }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Open PRs by you in ${ORG}${args.since ? ` created on or after ${args.since}` : ""}: ${prs.length + errors.length}\n\n`);
  process.stdout.write(renderText(prs, now));
  for (const e of errors) process.stdout.write(`! ${e.url}: ${e.error}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`pr:status failed: ${(e as Error).message}\n`);
    process.exit(2);
  },
);
