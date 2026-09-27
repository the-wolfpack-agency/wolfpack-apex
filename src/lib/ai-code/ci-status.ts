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
import { listCheckRuns, workspaceGithubClient, type CheckRun, type GithubClient } from "@/lib/github-client";

/** Conclusions that count as a pass. Everything else that has a conclusion is a
 *  fail; a null conclusion means it has not finished. */
const PASSING = new Set(["success", "neutral", "skipped"]);

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
  return { total, passed, failed, pending, complete, ciComplete: complete && failed === 0, failedChecks, failedDetails };
}

/** Fetch + summarize a PR head ref's CI. Never throws: a GitHub error becomes an
 *  empty (not-complete) summary so a caller treats "cannot read CI" as "not
 *  verified", never as green. */
export async function fetchCiStatus(repoFullName: string, ref: string, workspaceId?: string): Promise<CiSummary> {
  try {
    const client: GithubClient = await workspaceGithubClient(workspaceId);
    if (!client.token) return summarizeChecks([]);
    const checks = await listCheckRuns(client, repoFullName, ref);
    return summarizeChecks(checks);
  } catch {
    return summarizeChecks([]);
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
    const checks = await listCheckRuns(client, repoFullName, ref);
    return categorizeChecks(checks);
  } catch {
    return categorizeChecks([]);
  }
}
