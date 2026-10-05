/**
 * CI status for a factory PR, read back into Instinct.
 *
 * This is the producer for the dormant CI invariant: "a change may not reach a
 * human until CI is fully green" (OGIAM R-CI-INCOMPLETE-DENY). The summarizer is
 * pure over the check-run list, so it is trivially testable; the fetch is the
 * one GitHub call.
 *
 * "Fully passed" (ciComplete) is deliberately strict: at least one check ran,
 * every check has completed, and none failed. No checks yet -> NOT complete
 * (nothing verified is not the same as verified).
 */
import { listCheckRuns, listWorkflowRunChecks, workspaceGithubClient, triggerWorkflow, type CheckRun, type GithubClient } from "@/lib/github-client";

/** Read a ref's CI checks, tolerant of the token's permission shape: try the
 *  Checks API (per-job check-runs) first; if that is forbidden (the shared token
 *  cannot get "Checks", which is not even a grantable permission on it), fall
 *  back to the Actions API (workflow runs), which the token's Actions permission
 *  allows. Throws only when BOTH are unavailable, so a caller can surface the
 *  real reason. */
export async function readRefChecks(client: GithubClient, repoFullName: string, ref: string): Promise<CheckRun[]> {
  try {
    return await listCheckRuns(client, repoFullName, ref);
  } catch (checksErr) {
    try {
      return await listWorkflowRunChecks(client, repoFullName, ref);
    } catch {
      throw checksErr; // surface the original (usually the more informative) error
    }
  }
}

/** Conclusions that count as a pass. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/** Conclusions that mean the check did NOT run to completion - superseded by a
 *  newer run (concurrency cancel-in-progress), marked stale, or manually
 *  cancelled. These are NOT failures: there is no code defect to repair. Treating
 *  a cancellation as a failure made the autonomous fixer THRASH - each no-op /
 *  whitespace re-author pushes a commit, which cancels its own in-flight CI run,
 *  which then read as "failed", so the next tick re-authored and cancelled again.
 *  Count them as pending so CI reads as "not settled yet, wait" until a real run
 *  concludes, instead of as red to fix. Everything else with a conclusion (and
 *  not in PASSING) is a genuine failure: failure, timed_out, action_required,
 *  startup_failure. A null conclusion means it has not finished. */
const INCOMPLETE = new Set(["cancelled", "stale"]);

export interface CiSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Every check has completed (none queued / in_progress). */
  complete: boolean;
  /** Completed AND at least one check AND zero failures. Maps to ciComplete. */
  ciComplete: boolean;
  /** Names of the checks that failed, for a legible verdict. */
  failedChecks: string[];
  /** Failed checks with GitHub's output summary - the material a fixer acts on. */
  failedDetails: { name: string; summary: string }[];
  /** False when the CI could not be READ (no token, or the token lacks Checks:
   *  read, or a GitHub error) - as opposed to "read successfully, zero checks".
   *  A caller must never treat unreadable as "still running" or "green". Optional
   *  for back-compat: absent/true both mean "read succeeded". */
  readable?: boolean;
  /** Why the CI was unreadable, when readable is false. */
  unreadableReason?: string;
}

/** Summarize a check-run list. Pure: no IO. */
export function summarizeChecks(checks: readonly CheckRun[]): CiSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failedChecks: string[] = [];
  const failedDetails: { name: string; summary: string }[] = [];
  for (const c of checks) {
    if (c.status !== "completed") {
      pending++;
      continue;
    }
    // A cancelled / stale check did not run to completion - treat it as not-yet-
    // settled (pending), never as a failure to fix. This is what stops the
    // self-cancelling thrash loop (see INCOMPLETE).
    if (c.conclusion && INCOMPLETE.has(c.conclusion)) {
      pending++;
      continue;
    }
    if (c.conclusion && PASSING.has(c.conclusion)) {
      passed++;
    } else {
      failed++;
      failedChecks.push(c.name);
      failedDetails.push({ name: c.name, summary: (c.output?.summary ?? "").slice(0, 2000) });
    }
  }
  const total = checks.length;
  const complete = total > 0 && pending === 0;
  return { total, passed, failed, pending, complete, ciComplete: complete && failed === 0, failedChecks, failedDetails, readable: true };
}

/** An unreadable-CI summary: we could not read the checks at all. Distinct from a
 *  successful read of zero checks, so a caller never mistakes it for "green" or
 *  "still running". */
function unreadable(reason: string): CiSummary {
  return { ...summarizeChecks([]), readable: false, unreadableReason: reason };
}

/** Fetch + summarize a PR head ref's CI. Never throws: a GitHub error becomes an
 *  empty (not-complete) summary so a caller treats "cannot read CI" as "not
 *  verified", never as green. */
export async function fetchCiStatus(repoFullName: string, ref: string, workspaceId?: string): Promise<CiSummary> {
  try {
    const client: GithubClient = await workspaceGithubClient(workspaceId);
    if (!client.token) return unreadable("no GitHub credential for this workspace");
    const checks = await readRefChecks(client, repoFullName, ref);
    return summarizeChecks(checks);
  } catch (e) {
    // Both the Checks and Actions reads failed. Surface the RAW reason (never a
    // silent "0 checks"), so what is actually wrong is visible.
    return unreadable(`cannot read CI: ${(e as Error).message.slice(0, 200)}`);
  }
}

/* -------------------------------------------------------------------------- *
 * Pipeline health dashboard: group raw CI check runs into a few legible
 * instruments (Unit, Types & Lint, Contract, UI & E2E, Data & DB, Security &
 * PII, Build & Deploy) so a non-engineer reads "is my code healthy" at a glance,
 * the way a vehicle dashboard reads at a glance. Deterministic mapping of a check
 * NAME to a category; pure over the check list.
 * -------------------------------------------------------------------------- */

/** An instrument's state. absent = no matching check ran (a dark gauge). */
export type CiCategoryStatus = "pass" | "fail" | "pending" | "absent";

export interface CiCategory {
  key: string;
  label: string;
  status: CiCategoryStatus;
  passed: number;
  failed: number;
  pending: number;
  /** The underlying check names, so a click can show what rolled up. */
  checks: string[];
}

export interface CiDashboard {
  categories: CiCategory[];
  /** Worst instrument wins: fail > pending > pass > absent. */
  overall: CiCategoryStatus;
  summary: CiSummary;
}

/** Ordered instruments. First matching pattern wins, so order is meaningful
 *  (a "SQL security scan" is Data before Security only if Data is listed first;
 *  here Security is intentionally last-but-one so a security scan is Security). */
// Labels are deliberately PRODUCT-AGNOSTIC checkpoints - "Build & deploy", not
// "Vercel"; "Security", not "CodeQL"; "Unit tests", not "Jest". A non-technical
// user reads the checkpoint and its light; the tool that produced it is an
// implementation detail the dashboard never surfaces. This is what lets the same
// dashboard sit over any client's pipeline once they plug in their tools.
const CI_CATEGORIES: { key: string; label: string; match: RegExp }[] = [
  { key: "unit", label: "Unit tests", match: /\bunit\b|jest/i },
  { key: "types-lint", label: "Code quality", match: /lint|type|tsc|eslint|typecheck|format/i },
  { key: "contract", label: "Contract & API", match: /contract|\bapi\b|openapi/i },
  { key: "ui-e2e", label: "UI & journeys", match: /e2e|\bui\b|playwright|reality|device|browser|dom/i },
  { key: "data-db", label: "Data & privacy", match: /\bsql\b|postgres|\bdb\b|migration|\bdata\b|\brls\b|pii|tenant/i },
  { key: "security", label: "Security", match: /security|pentest|codeql|scan|secret|vuln|audit|inject/i },
  { key: "build-deploy", label: "Build & deploy", match: /vercel|build|deploy|verify-platform|compile|bundle/i },
  { key: "other", label: "Other checks", match: /.*/ },
];

function statusFor(passed: number, failed: number, pending: number): CiCategoryStatus {
  if (failed > 0) return "fail";
  if (pending > 0) return "pending";
  if (passed > 0) return "pass";
  return "absent";
}

/** Roll raw check runs up into the dashboard instruments. Pure. */
export function categorizeChecks(checks: readonly CheckRun[]): CiDashboard {
  const buckets = new Map<string, { passed: number; failed: number; pending: number; checks: string[] }>();
  for (const cat of CI_CATEGORIES) buckets.set(cat.key, { passed: 0, failed: 0, pending: 0, checks: [] });

  for (const c of checks) {
    const cat = CI_CATEGORIES.find((k) => k.match.test(c.name)) ?? CI_CATEGORIES[CI_CATEGORIES.length - 1];
    const b = buckets.get(cat.key)!;
    b.checks.push(c.name);
    if (c.status !== "completed") b.pending++;
    else if (c.conclusion && PASSING.has(c.conclusion)) b.passed++;
    else b.failed++;
  }

  const categories: CiCategory[] = CI_CATEGORIES.map((cat) => {
    const b = buckets.get(cat.key)!;
    return { key: cat.key, label: cat.label, status: statusFor(b.passed, b.failed, b.pending), passed: b.passed, failed: b.failed, pending: b.pending, checks: b.checks };
  });

  const anyFail = categories.some((c) => c.status === "fail");
  const anyPending = categories.some((c) => c.status === "pending");
  const anyPass = categories.some((c) => c.status === "pass");
  const overall: CiCategoryStatus = anyFail ? "fail" : anyPending ? "pending" : anyPass ? "pass" : "absent";

  return { categories, overall, summary: summarizeChecks(checks) };
}

/** Fetch a ref's checks and roll them into the checkpoint dashboard. Never
 *  throws: a GitHub error becomes an all-absent dashboard (dark gauges), which
 *  reads as "nothing verified yet", not "healthy". */
export async function fetchCiDashboard(repoFullName: string, ref: string, workspaceId?: string): Promise<CiDashboard> {
  try {
    const client: GithubClient = await workspaceGithubClient(workspaceId);
    if (!client.token) return categorizeChecks([]);
    const checks = await readRefChecks(client, repoFullName, ref);
    return categorizeChecks(checks);
  } catch {
    return categorizeChecks([]);
  }
}

/* -------------------------------------------------------------------------- *
 * Baseline attribution: never let a PRE-EXISTING failure read as "the tool
 * broke it". Compare a change's checks against a BASELINE (the base branch's
 * most recent run, or a snapshot captured at onboarding) and report the DELTA -
 * what the change INTRODUCED vs what was already failing. This is the before/
 * after discipline a human engineer applies to a test environment, encoded so a
 * client whose repo was already red never blames the tool for it.
 * -------------------------------------------------------------------------- */

function isCompletedCheck(c: CheckRun): boolean {
  return c.status === "completed";
}
function isFailingCheck(c: CheckRun): boolean {
  return isCompletedCheck(c) && !(c.conclusion != null && PASSING.has(c.conclusion));
}
function isPassingCheck(c: CheckRun): boolean {
  return isCompletedCheck(c) && c.conclusion != null && PASSING.has(c.conclusion);
}

export interface CiAttribution {
  /** Failing on the change, PASSING on the baseline -> the change caused it. */
  introduced: string[];
  /** Failing on both -> already broken before the change, not its fault. */
  preexisting: string[];
  /** Failing on the change with no accurate baseline for it -> cannot attribute. */
  indeterminate: string[];
  /** Passing on the change, was failing on the baseline -> the change fixed it. */
  fixed: string[];
  /** Whether any completed baseline checks existed to compare against. */
  baselineKnown: boolean;
  /** Baseline had zero failing checks (a clean starting point). */
  baselineHealthy: boolean;
  /** The change introduced no NEW attributable failures. Read WITH baselineKnown:
   *  clean && !baselineKnown just means "nothing to attribute", not "all good". */
  clean: boolean;
  /** One-line, honest summary for the UI. */
  reason: string;
}

/** Attribute a change's checks against a baseline set of checks. Pure: same
 *  inputs, same verdict, so the "did the change break it" claim is reproducible
 *  and auditable. The baseline can be the base branch's latest run OR a snapshot
 *  captured at onboarding - this function does not care where it came from. */
export function attributeChecks(
  baseline: readonly CheckRun[],
  head: readonly CheckRun[],
): CiAttribution {
  const baseByName = new Map<string, CheckRun>();
  for (const c of baseline) baseByName.set(c.name, c); // last occurrence wins

  const introduced: string[] = [];
  const preexisting: string[] = [];
  const indeterminate: string[] = [];
  const fixed: string[] = [];

  for (const c of head) {
    if (!isCompletedCheck(c)) continue; // pending/running: nothing to attribute yet
    const base = baseByName.get(c.name);
    if (isFailingCheck(c)) {
      if (base && isFailingCheck(base)) preexisting.push(c.name);
      else if (base && isPassingCheck(base)) introduced.push(c.name);
      else indeterminate.push(c.name); // no baseline entry, or baseline still pending
    } else if (isPassingCheck(c)) {
      if (base && isFailingCheck(base)) fixed.push(c.name);
    }
  }

  const baselineCompleted = baseline.filter(isCompletedCheck);
  const baselineKnown = baselineCompleted.length > 0;
  const baselineHealthy = baselineKnown && !baselineCompleted.some(isFailingCheck);
  const clean = introduced.length === 0;

  let reason: string;
  if (introduced.length > 0) {
    reason = `This change introduced ${introduced.length} new failing check(s): ${introduced.join(", ")}.`;
  } else if (!baselineKnown) {
    reason =
      "No baseline run was available on the base branch, so failures could not be attributed to this change. Establish a baseline to compare against.";
  } else if (preexisting.length > 0 || indeterminate.length > 0) {
    const parts: string[] = [];
    if (preexisting.length) parts.push(`${preexisting.length} were already failing on the base branch`);
    if (indeterminate.length) parts.push(`${indeterminate.length} had no baseline to compare against`);
    reason = `This change introduced no new failures. ${parts.join("; ")}.`;
  } else {
    reason = "This change introduced no new failures; the baseline was clean.";
  }

  return { introduced, preexisting, indeterminate, fixed, baselineKnown, baselineHealthy, clean, reason };
}

/** Fetch a change's checks and the base branch's most-recent checks, then
 *  attribute the delta. Never throws: a GitHub error yields an unknown-baseline
 *  attribution, which reads as "could not attribute", never as "the change is
 *  clean". */
export async function fetchCiAttribution(
  repoFullName: string,
  baseRef: string,
  headRef: string,
  workspaceId?: string,
): Promise<CiAttribution> {
  try {
    const client: GithubClient = await workspaceGithubClient(workspaceId);
    if (!client.token) return attributeChecks([], []);
    const [baseline, head] = await Promise.all([
      readRefChecks(client, repoFullName, baseRef).catch(() => [] as CheckRun[]),
      readRefChecks(client, repoFullName, headRef).catch(() => [] as CheckRun[]),
    ]);
    return attributeChecks(baseline, head);
  } catch {
    return attributeChecks([], []);
  }
}

/** Establish a baseline when the base branch has no measured CI: dispatch a
 *  workflow on the base ref so it produces the checks a baseline is made of.
 *  This is the "there would be no other way to know the initial state" step -
 *  measuring requires a run to have happened, and some repos have never run CI
 *  on their base. Defaults to the factory's own validate workflow (which runs the
 *  repo's tests); any dispatchable workflow file can be named. Never throws: a
 *  dispatch failure returns { dispatched:false, reason } so onboarding surfaces
 *  the real reason (e.g. the workflow is not workflow_dispatch-enabled) rather
 *  than silently proceeding without a baseline. */
export async function establishBaseline(
  repoFullName: string,
  baseRef: string,
  opts: { workflowFile?: string; workspaceId?: string } = {},
): Promise<{ dispatched: boolean; runId: string | null; workflowFile: string; reason?: string }> {
  const workflowFile = opts.workflowFile ?? "factory-validate.yml";
  try {
    const client: GithubClient = await workspaceGithubClient(opts.workspaceId);
    if (!client.token) {
      return { dispatched: false, runId: null, workflowFile, reason: "no GitHub credential for this workspace" };
    }
    const { run_id } = await triggerWorkflow(client, repoFullName, workflowFile, baseRef);
    return { dispatched: true, runId: run_id, workflowFile };
  } catch (e) {
    return { dispatched: false, runId: null, workflowFile, reason: (e as Error).message.slice(0, 200) };
  }
}
