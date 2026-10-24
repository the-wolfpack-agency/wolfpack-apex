/**
 * Supply-chain sweep across every repository in the GitHub organization.
 *
 *   npm run security:supply-chain
 *   npm run security:supply-chain -- --repo wolfpack-apex      # one repo
 *   npm run security:supply-chain -- --out /tmp/sec --fail-on high
 *
 * Four questions, each one a check we ran by hand during the week of
 * 2026-10-20 and should not have to remember to run again:
 *
 *   1. Dependabot: which open alerts are malware, critical or high?
 *   2. OSV: does any lockfile resolve a package@version that OSV lists,
 *      including MAL- (malicious package) records that are not CVEs at all?
 *   3. Curated list: does anything match security/known-compromised.json,
 *      the releases we read about this week (litellm 1.107.0, @subql/common
 *      5.8.3, tensorlake 0.5.144, the fake Apex Accelerator packages)? That
 *      list also covers container images, which OSV does not.
 *   4. GhostAction: was any workflow file changed in the last 14 days by a
 *      commit that is not part of a merged pull request? That is how a stolen
 *      token turns into a "security audit" workflow that ships secrets out.
 *
 * READ-ONLY. GitHub is read through `gh api` GETs; OSV is read through its
 * query API (a POST that only reads). Nothing is opened, commented, dismissed
 * or pushed.
 *
 * Needs: the gh CLI authenticated with read access to the org's repositories,
 * Dependabot alerts and pull requests (locally `gh auth login`; in Actions the
 * SECURITY_AUDIT_GH_TOKEN secret, see docs/security/scheduled-checks.md).
 * Exit: 0 clean or skipped, 1 findings at or above --fail-on (default medium),
 * 2 could not run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ghGet, ghGetRaw, ghPaginate } from "./lib/gh";
import { isImageFile, lockfileKind, parseImageRefs, parseLockfile, type LockedPackage } from "./lib/lockfiles";
import { emitReport, mapPool, newReport, parseCliOptions, type Finding } from "./lib/report";
import {
  OSV_BATCH_LIMIT,
  chunk,
  dependabotFindings,
  ghostActionFindings,
  matchKnownImages,
  matchKnownPackages,
  osvFindings,
  osvQueries,
  osvSeverity,
  type DependabotAlert,
  type KnownCompromised,
  type OsvVulnDetail,
  type WorkflowCommit,
} from "./lib/supply-chain";

const argv = process.argv.slice(2);
const opts = parseCliOptions(argv, "scripts/security/out");
const argValue = (flag: string) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
};
const ORG = argValue("--org") ?? process.env.SECURITY_ORG ?? "the-wolfpack-agency";
const ONLY_REPO = argValue("--repo");
const WINDOW_DAYS = Number(argValue("--days") ?? 14);
const KNOWN_PATH = resolve(argValue("--known") ?? "security/known-compromised.json");
const MAX_VULN_DETAILS = 3000;

interface Repo {
  name: string;
  full_name: string;
  archived: boolean;
  default_branch: string;
  private: boolean;
  size: number;
}

interface TreeEntry {
  path: string;
  type: string;
}

interface LockfileHit {
  repo: string;
  file: string;
  packages: LockedPackage[];
}

const report = newReport("supply-chain");
const findings: Finding[] = report.findings;
const notes = report.notes;

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

async function osvPost<T>(url: string, body: unknown): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      /* retried below */
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

async function osvGet<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as T;
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      /* retried below */
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

async function scanDependabot(repo: Repo, counters: Record<string, number>): Promise<void> {
  const r = await ghPaginate<DependabotAlert>(`repos/${repo.full_name}/dependabot/alerts?state=open&per_page=100`);
  if (!r.ok) {
    if (r.status === 403 && /disabled/i.test(r.message)) {
      findings.push({
        severity: "medium",
        rule: "dependabot.disabled",
        subject: repo.full_name,
        detail: "Dependabot alerts are disabled, so a known-vulnerable or malicious dependency here raises nothing. Enable them in Settings, Code security.",
        source: `https://github.com/${repo.full_name}/settings/security_analysis`,
      });
    } else {
      notes.push(`${repo.full_name}: could not read Dependabot alerts (${r.status ?? "error"}: ${r.message.slice(0, 120)}).`);
    }
    return;
  }
  const { findings: f, counts } = dependabotFindings(repo.full_name, r.data);
  findings.push(...f);
  for (const [k, v] of Object.entries(counts)) counters[`dependabot_${k}`] = (counters[`dependabot_${k}`] ?? 0) + v;
}

async function scanFiles(repo: Repo, known: KnownCompromised, lockHits: LockfileHit[], counters: Record<string, number>): Promise<void> {
  const tree = await ghGet<{ tree: TreeEntry[]; truncated: boolean }>(
    `repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
  );
  if (!tree.ok) {
    notes.push(`${repo.full_name}: could not list files (${tree.status ?? "error"}${tree.status === 409 ? ", empty repository" : ""}).`);
    return;
  }
  if (tree.data.truncated) notes.push(`${repo.full_name}: file tree was truncated by GitHub; some lockfiles may be missed.`);
  const files = tree.data.tree.filter((e) => e.type === "blob" && (lockfileKind(e.path) || isImageFile(e.path)));
  await mapPool(files, 4, async (e) => {
    const body = await ghGetRaw(`repos/${repo.full_name}/contents/${encodePath(e.path)}?ref=${encodeURIComponent(repo.default_branch)}`);
    if (!body.ok) {
      notes.push(`${repo.full_name}:${e.path}: could not read (${body.status ?? "error"}).`);
      return;
    }
    const kind = lockfileKind(e.path);
    if (kind) {
      const packages = parseLockfile(kind, body.data);
      counters.lockfiles += 1;
      lockHits.push({ repo: repo.full_name, file: e.path, packages });
      findings.push(...matchKnownPackages(repo.full_name, e.path, packages, known.packages));
    } else {
      counters.image_files += 1;
      findings.push(...matchKnownImages(repo.full_name, e.path, parseImageRefs(body.data), known.images));
    }
  });
}

interface ActivityEvent {
  ref: string;
  timestamp: string;
  activity_type: string;
}

interface CommitListItem {
  sha: string;
}

interface CommitDetail {
  sha: string;
  author?: { login?: string } | null;
  commit: { author?: { name?: string; date?: string }; committer?: { date?: string }; message: string };
  files?: { filename: string }[];
}

async function scanGhostAction(repo: Repo, known: KnownCompromised, counters: Record<string, number>): Promise<void> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const bySha = new Map<string, { refs: Set<string>; onDefault: boolean }>();
  const listFor = async (ref: string, isDefault: boolean): Promise<boolean> => {
    const r = await ghPaginate<CommitListItem>(
      `repos/${repo.full_name}/commits?sha=${encodeURIComponent(ref)}&path=.github/workflows&since=${since}&per_page=100`,
    );
    if (!r.ok) return false;
    for (const c of r.data) {
      const entry = bySha.get(c.sha) ?? { refs: new Set<string>(), onDefault: false };
      entry.refs.add(ref);
      if (isDefault) entry.onDefault = true;
      bySha.set(c.sha, entry);
    }
    return true;
  };

  if (!(await listFor(repo.default_branch, true))) {
    notes.push(`${repo.full_name}: could not list default-branch workflow commits.`);
    return;
  }
  // Every other branch pushed to inside the window, from the repository
  // activity feed (covers branches with no PR, which is the case that matters).
  const activity = await ghPaginate<ActivityEvent>(`repos/${repo.full_name}/activity?time_period=month&per_page=100`);
  const branches = new Set<string>();
  if (activity.ok) {
    for (const ev of activity.data) {
      if (ev.timestamp < since) continue;
      if (!["push", "force_push", "branch_creation"].includes(ev.activity_type)) continue;
      if (!ev.ref?.startsWith("refs/heads/")) continue;
      const b = ev.ref.slice("refs/heads/".length);
      if (b !== repo.default_branch) branches.add(b);
    }
  } else {
    notes.push(`${repo.full_name}: could not read the activity feed; only the default branch was checked for workflow changes.`);
  }
  let gone = 0;
  await mapPool([...branches], 6, async (b) => {
    if (!(await listFor(b, false))) gone += 1;
  });
  counters.branches_checked += branches.size + 1;
  if (gone) counters.branches_deleted_since_push += gone;

  const commits: WorkflowCommit[] = [];
  await mapPool([...bySha.entries()], 6, async ([sha, info]) => {
    const [detail, pulls] = await Promise.all([
      ghGet<CommitDetail>(`repos/${repo.full_name}/commits/${sha}`),
      ghGet<WorkflowCommit["pulls"]>(`repos/${repo.full_name}/commits/${sha}/pulls`),
    ]);
    if (!detail.ok) return;
    const files = (detail.data.files ?? []).map((f) => f.filename).filter((f) => f.startsWith(".github/workflows/"));
    // The path filter also matches merges that only carry workflow changes in;
    // a commit whose own diff touches no workflow is not a workflow change.
    if (!files.length && (detail.data.files ?? []).length) return;
    commits.push({
      sha,
      refs: [...info.refs],
      onDefaultBranch: info.onDefault,
      author: detail.data.author?.login ?? detail.data.commit.author?.name ?? "unknown",
      committedAt: detail.data.commit.committer?.date ?? detail.data.commit.author?.date ?? "",
      message: detail.data.commit.message,
      workflowFiles: files,
      pulls: pulls.ok ? pulls.data : [],
    });
  });
  counters.workflow_commits_examined += commits.length;
  findings.push(...ghostActionFindings(repo.full_name, commits, known.workflowIndicators));
}

async function runOsv(lockHits: LockfileHit[], counters: Record<string, number>): Promise<void> {
  const unique = new Map<string, LockedPackage>();
  for (const h of lockHits) for (const p of h.packages) unique.set(`${p.ecosystem}|${p.name}|${p.version}`, p);
  const pkgs = [...unique.values()];
  counters.unique_packages = pkgs.length;
  const vulnsByKey = new Map<string, string[]>();
  let failedBatches = 0;
  for (const batch of chunk(pkgs, OSV_BATCH_LIMIT)) {
    const res = await osvPost<{ results: { vulns?: { id: string }[]; next_page_token?: string }[] }>(
      "https://api.osv.dev/v1/querybatch",
      { queries: osvQueries(batch) },
    );
    if (!res) {
      failedBatches += 1;
      continue;
    }
    res.results.forEach((r, i) => {
      const p = batch[i];
      if (r.vulns?.length) vulnsByKey.set(`${p.ecosystem}|${p.name}|${p.version}`, r.vulns.map((v) => v.id));
      if (r.next_page_token) notes.push(`OSV returned more than one page of advisories for ${p.name}@${p.version}; only the first page was read.`);
    });
  }
  if (failedBatches) notes.push(`OSV: ${failedBatches} batch request(s) failed after retries; those packages were NOT checked.`);

  const ids = [...new Set([...vulnsByKey.values()].flat())];
  counters.osv_advisories_matched = ids.length;
  const details = new Map<string, OsvVulnDetail>();
  const toFetch = ids.filter((id) => !id.startsWith("MAL-")).slice(0, MAX_VULN_DETAILS);
  if (ids.length > MAX_VULN_DETAILS) notes.push(`OSV: ${ids.length} advisories matched; severity was looked up for the first ${MAX_VULN_DETAILS}.`);
  await mapPool(toFetch, 8, async (id) => {
    const d = await osvGet<OsvVulnDetail>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`);
    if (d) details.set(id, d);
  });
  for (const id of ids) {
    const s = osvSeverity(details.get(id) ?? { id });
    const k = `osv_${s ?? "unrated"}`;
    counters[k] = (counters[k] ?? 0) + 1;
  }
  for (const h of lockHits) {
    for (const p of h.packages) {
      const v = vulnsByKey.get(`${p.ecosystem}|${p.name}|${p.version}`);
      if (!v) continue;
      const f = osvFindings(h.repo, h.file, p, v, details);
      if (f) findings.push(f);
    }
  }
}

async function main(): Promise<number> {
  const auth = await ghGet<unknown>("rate_limit");
  if (!auth.ok) {
    report.skipped =
      "The gh CLI is not authenticated. Locally run `gh auth login`; in Actions add the SECURITY_AUDIT_GH_TOKEN secret (read-only: Contents, Metadata, Pull requests, Dependabot alerts on all org repositories).";
    return emitReport(report, opts);
  }
  let known: KnownCompromised;
  try {
    known = JSON.parse(readFileSync(KNOWN_PATH, "utf8")) as KnownCompromised;
  } catch (e) {
    process.stderr.write(`Cannot read ${KNOWN_PATH}: ${(e as Error).message}\n`);
    return 2;
  }
  const reposRes = await ghPaginate<Repo>(`orgs/${ORG}/repos?type=all&per_page=100`);
  if (!reposRes.ok) {
    process.stderr.write(`Cannot list repositories for ${ORG}: ${reposRes.message}\n`);
    return 2;
  }
  const all = reposRes.data.filter((r) => !ONLY_REPO || r.name === ONLY_REPO);
  const repos = all.filter((r) => !r.archived);
  const archived = all.length - repos.length;
  const counters: Record<string, number> = {
    lockfiles: 0,
    image_files: 0,
    branches_checked: 0,
    branches_deleted_since_push: 0,
    workflow_commits_examined: 0,
  };
  const lockHits: LockfileHit[] = [];

  await mapPool(repos, 3, async (repo) => {
    await scanDependabot(repo, counters);
    await scanFiles(repo, known, lockHits, counters);
    await scanGhostAction(repo, known, counters);
  });
  await runOsv(lockHits, counters);

  report.stats = {
    organization: ORG,
    repositories_scanned: repos.length,
    repositories_private: repos.filter((r) => r.private).length,
    archived_skipped: archived,
    curated_list_updated: known.updated,
    curated_packages: known.packages.length,
    ghostaction_window_days: WINDOW_DAYS,
    ...counters,
  };
  notes.push(
    "OSV moderate, low and unrated advisories are counted above but not listed; Dependabot tracks them per repository.",
    "GhostAction window uses commit dates, which the committer sets; a backdated commit would be missed. Commits on branches deleted before this run are not reachable and are not checked.",
    `Curated list: ${KNOWN_PATH}. Add new incidents there with a primary source (see docs/security/threat-to-rule.md).`,
  );
  return emitReport(report, opts);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`security:supply-chain failed: ${(e as Error).stack ?? e}\n`);
    process.exit(2);
  },
);
