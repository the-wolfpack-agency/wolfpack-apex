/**
 * Readiness preflight: the pure status logic. Encodes the "catch it up front"
 * discipline - no App linked is a warning with a one-click install fix, an
 * unreachable repo is a hard fail, a red baseline is disclosed (not a stop).
 */
import { buildReadinessChecks, summarizeReadiness, type ReadinessProbes } from "@/lib/ai-code/readiness";

const base: ReadinessProbes = {
  githubTokenPresent: true,
  appConfigured: true,
  installationLinked: true,
  patConfigured: true,
  prCapable: true,
  ciReadable: true,
  repoReachable: true,
  defaultBranch: "main",
  ciPresent: true,
  baselineFailingCount: 0,
  installUrl: "https://github.com/apps/agentgate-ai/installations/new",
};
const byId = (probes: ReadinessProbes) => Object.fromEntries(buildReadinessChecks(probes).map((c) => [c.id, c]));

test("fully set up -> every check passes and it is fully ready", () => {
  const report = summarizeReadiness(buildReadinessChecks(base));
  expect(report.overall).toBe("pass");
  expect(report.ready).toBe(true);
  expect(report.fullyReady).toBe(true);
});

test("no GitHub token -> hard FAIL on access, not ready, with a connect fix", () => {
  const checks = byId({ ...base, githubTokenPresent: false });
  expect(checks["github-access"].status).toBe("fail");
  expect(checks["github-access"].fix?.url).toContain("installations/new");
  expect(summarizeReadiness(Object.values(checks)).ready).toBe(false);
});

test("unreachable repo -> hard FAIL on repo access", () => {
  const checks = byId({ ...base, repoReachable: false, defaultBranch: null, ciPresent: false });
  expect(checks["repo-access"].status).toBe("fail");
  expect(summarizeReadiness(Object.values(checks)).ready).toBe(false);
});

test("a CAPABLE token with NO App installed -> PASS (App optional), fully ready", () => {
  // The key simplification: the App is not required. A token that can open PRs
  // reads as ready and is never nagged to install the App.
  const checks = byId({ ...base, installationLinked: false, prCapable: true });
  expect(checks["pr-capability"].status).toBe("pass");
  expect(checks["pr-capability"].detail).toMatch(/App is optional/i);
  const report = summarizeReadiness(Object.values(checks));
  expect(report.fullyReady).toBe(true);
});

test("token present but CANNOT open PRs -> WARN with fix (grant Pull requests or install App)", () => {
  const checks = byId({ ...base, installationLinked: false, prCapable: false });
  expect(checks["pr-capability"].status).toBe("warn");
  expect(checks["pr-capability"].detail).toMatch(/Pull requests: Read and write|install the GitHub App/i);
  expect(summarizeReadiness(Object.values(checks)).ready).toBe(true); // warn does not block
});

test("no credential at all -> hard FAIL on PR capability", () => {
  const checks = byId({ ...base, githubTokenPresent: false, prCapable: false });
  expect(checks["pr-capability"].status).toBe("fail");
  expect(summarizeReadiness(Object.values(checks)).ready).toBe(false);
});

test("no CI on the base -> WARN, does not block", () => {
  const checks = byId({ ...base, ciPresent: false });
  expect(checks["ci-present"].status).toBe("warn");
  expect(summarizeReadiness(Object.values(checks)).ready).toBe(true);
});

test("no CI on the base is NOT a green baseline (found by dogfooding): baseline-health warns, never 'green'", () => {
  const checks = byId({ ...base, ciPresent: false, baselineFailingCount: 0 });
  expect(checks["baseline-health"].status).toBe("warn");
  expect(checks["baseline-health"].detail).not.toMatch(/green/i);
  expect(checks["baseline-health"].detail).toMatch(/unmeasured|no baseline to compare/i);
});

test("a MEASURED clean base (CI ran, zero failures) is green", () => {
  const checks = byId({ ...base, ciPresent: true, baselineFailingCount: 0 });
  expect(checks["baseline-health"].status).toBe("pass");
  expect(checks["baseline-health"].detail).toMatch(/green/i);
});

test("red baseline -> WARN that discloses pre-existing failures up front, does not block", () => {
  const checks = byId({ ...base, baselineFailingCount: 3 });
  expect(checks["baseline-health"].status).toBe("warn");
  expect(checks["baseline-health"].detail).toMatch(/3 failing check/i);
  expect(checks["baseline-health"].detail).toMatch(/pre-existing/i);
  expect(summarizeReadiness(Object.values(checks)).ready).toBe(true);
});

test("summarizeReadiness takes the worst status as overall", () => {
  expect(summarizeReadiness([
    { id: "a", label: "A", status: "pass", detail: "" },
    { id: "b", label: "B", status: "warn", detail: "" },
  ]).overall).toBe("warn");
  expect(summarizeReadiness([
    { id: "a", label: "A", status: "warn", detail: "" },
    { id: "b", label: "B", status: "fail", detail: "" },
  ]).overall).toBe("fail");
});

test("CI unreadable with the token -> ci-present + baseline both WARN, never silently green", () => {
  const checks = byId({ ...base, ciReadable: false, ciPresent: false, baselineFailingCount: 0 });
  expect(checks["ci-present"].status).toBe("warn");
  expect(checks["ci-present"].detail).toMatch(/could not be read/i);
  expect(checks["baseline-health"].status).toBe("warn");
  expect(checks["baseline-health"].detail).not.toMatch(/green/i);
});
