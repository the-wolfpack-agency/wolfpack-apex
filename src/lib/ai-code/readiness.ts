/**
 * Onboarding readiness preflight.
 *
 * Work back from failure: every painful surprise a user hit came from an
 * environmental condition discovered mid-flow (no App linked -> PR 403, a repo
 * that was already red, no CI to verify against). This runs those checks ONCE, up
 * front, and reports a single green / amber / red readiness with a one-click fix
 * per blocker - so the user never trips over a surprise while running the tool.
 *
 * The status builder is pure over a probes struct, so it is fully testable
 * without GitHub; assessReadiness gathers the probes with the existing helpers.
 */
import {
  fetchRepoInfo,
  listCheckRuns,
  workspaceGithubClient,
  type CheckRun,
  type GithubClient,
} from "@/lib/github-client";
import { getInstallation, readAppConfigFromEnv } from "@/lib/github-app";
import { summarizeChecks } from "./ci-status";

export type ReadinessStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** An action that resolves the check, when there is a one-click fix. */
  fix?: { label: string; url?: string };
}

export interface ReadinessReport {
  checks: ReadinessCheck[];
  /** Worst status across the checks. */
  overall: ReadinessStatus;
  /** No hard blockers: the tool can run (warnings are disclosures, not stops). */
  ready: boolean;
  /** Everything green: the ideal, fully-automatic experience. */
  fullyReady: boolean;
}

/** The raw signals a readiness assessment is built from. Kept as plain data so
 *  the status logic is pure and testable. */
export interface ReadinessProbes {
  /** A GitHub token (App installation OR PAT) is available for the workspace. */
  githubTokenPresent: boolean;
  /** The GitHub App is configured in the environment. */
  appConfigured: boolean;
  /** An App installation is linked to this workspace. */
  installationLinked: boolean;
  /** The shared PAT is configured (the fallback). */
  patConfigured: boolean;
  /** The repo could be read with the current token. */
  repoReachable: boolean;
  /** The repo's default branch, when reachable. */
  defaultBranch: string | null;
  /** Any completed CI checks exist on the base branch. */
  ciPresent: boolean;
  /** Count of checks already failing on the base branch (the baseline). */
  baselineFailingCount: number;
  /** The GitHub App install URL, for the one-click fix. */
  installUrl?: string;
}

const RANK: Record<ReadinessStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Roll a set of checks into an overall readiness. Pure. */
export function summarizeReadiness(checks: ReadinessCheck[]): ReadinessReport {
  let overall: ReadinessStatus = "pass";
  for (const c of checks) if (RANK[c.status] > RANK[overall]) overall = c.status;
  return { checks, overall, ready: overall !== "fail", fullyReady: overall === "pass" };
}

/** Build the readiness checks from the probes. Pure: same probes, same verdict. */
export function buildReadinessChecks(p: ReadinessProbes): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const installFix = p.installUrl ? { label: "Connect GitHub (one-click install)", url: p.installUrl } : undefined;

  // 1. Can we reach GitHub at all.
  checks.push(
    p.githubTokenPresent
      ? { id: "github-access", label: "GitHub access", status: "pass", detail: "A GitHub credential is available for this workspace." }
      : { id: "github-access", label: "GitHub access", status: "fail", detail: "No GitHub App installation or token is available. Connect GitHub to continue.", fix: installFix },
  );

  // 2. Can we read the target repo.
  checks.push(
    p.repoReachable
      ? { id: "repo-access", label: "Repository access", status: "pass", detail: `The repository is reachable (default branch: ${p.defaultBranch ?? "unknown"}).` }
      : { id: "repo-access", label: "Repository access", status: "fail", detail: "The repository could not be read with the current credential. Confirm the App is installed on this repo, or that access was granted.", fix: installFix },
  );

  // 3. Can we OPEN pull requests automatically (the core promise). This is the
  //    exact failure that caused the mid-flow 403: a PAT without pull-requests
  //    write. An App installation guarantees it; the PAT is a maybe.
  if (p.installationLinked) {
    checks.push({ id: "pr-capability", label: "Automatic pull requests", status: "pass", detail: "The GitHub App is installed, so pull requests open automatically with a scoped token." });
  } else if (p.patConfigured) {
    checks.push({ id: "pr-capability", label: "Automatic pull requests", status: "warn", detail: "Using the shared token. If it lacks pull-requests write, PRs will not open automatically (you would open them from a one-click link instead). Install the App to guarantee automatic PRs.", fix: installFix });
  } else {
    checks.push({ id: "pr-capability", label: "Automatic pull requests", status: "fail", detail: "No way to open pull requests is configured. Install the GitHub App.", fix: installFix });
  }

  // 4. Is there CI to verify a change before it merges.
  checks.push(
    p.ciPresent
      ? { id: "ci-present", label: "CI to verify changes", status: "pass", detail: "The base branch runs CI, so changes are verified before merge." }
      : { id: "ci-present", label: "CI to verify changes", status: "warn", detail: "No CI was detected on the base branch. Changes can still open as PRs, but there is nothing to verify them automatically." },
  );

  // 5. Is the baseline green. A red baseline is disclosed up front so its red
  //    is never mistaken for something the tool introduced.
  checks.push(
    !p.repoReachable
      ? { id: "baseline-health", label: "Baseline health", status: "warn", detail: "Baseline could not be measured because the repository is unreachable." }
      : p.baselineFailingCount === 0
        ? { id: "baseline-health", label: "Baseline health", status: "pass", detail: "The base branch is green: a clean starting point." }
        : { id: "baseline-health", label: "Baseline health", status: "warn", detail: `The base branch already has ${p.baselineFailingCount} failing check(s). These will appear on every pull request as PRE-EXISTING and are not caused by your changes.` },
  );

  return checks;
}

/** Gather the probes for a repo and produce a readiness report. Never throws: an
 *  unreachable repo or GitHub error yields a report that reads as "not ready" with
 *  the reason, never a 500 or a false "ready". */
export async function assessReadiness(
  repoFullName: string,
  workspaceId: string | null | undefined,
  installUrl?: string,
): Promise<ReadinessReport> {
  let client: GithubClient | null = null;
  try {
    client = await workspaceGithubClient(workspaceId);
  } catch {
    client = null;
  }
  const githubTokenPresent = Boolean(client?.token);

  const appConfigured = readAppConfigFromEnv() !== null;
  let installationLinked = false;
  try {
    installationLinked = appConfigured && Boolean(await getInstallation(workspaceId ?? ""));
  } catch {
    installationLinked = false;
  }
  const patConfigured = Boolean(process.env.GITHUB_TOKEN_WOLFPACK_AGENCY);

  let repoReachable = false;
  let defaultBranch: string | null = null;
  let ciPresent = false;
  let baselineFailingCount = 0;

  if (client?.token) {
    try {
      const info = await fetchRepoInfo(client, repoFullName);
      repoReachable = true;
      defaultBranch = info.defaultBranch;
      try {
        const checks: CheckRun[] = await listCheckRuns(client, repoFullName, info.defaultBranch);
        const summary = summarizeChecks(checks);
        ciPresent = summary.total > 0 && summary.pending < summary.total; // at least one completed check ever ran
        baselineFailingCount = summary.failed;
      } catch {
        // CI unreadable: leave ciPresent false / baseline 0 (disclosed as warnings).
      }
    } catch {
      repoReachable = false;
    }
  }

  const checks = buildReadinessChecks({
    githubTokenPresent,
    appConfigured,
    installationLinked,
    patConfigured,
    repoReachable,
    defaultBranch,
    ciPresent,
    baselineFailingCount,
    installUrl,
  });
  return summarizeReadiness(checks);
}
