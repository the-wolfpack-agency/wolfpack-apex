/**
 * Guard for the E2E Reality Check workflow (.github/workflows/e2e-reality-check.yml).
 *
 * The reality-check is a merge gate; a silent drift (a renamed spec that no
 * longer exists, the hard gates falling out, or the slow soft specs leaking back
 * onto the PR critical path) would quietly weaken or slow it. This asserts the
 * invariants of the speed/reliability restructure so they can't regress unnoticed.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WF = path.join(REPO_ROOT, ".github/workflows/e2e-reality-check.yml");
const yaml = fs.readFileSync(WF, "utf8");

/** The hard gates that must run on every PR + push. */
const HARD_GATES = [
  "tests/e2e/sites-preview-reality-check.spec.ts",
  "tests/e2e/dashboard-quick-actions.spec.ts",
  "tests/e2e/ai-router-behaviour.spec.ts",
  /* A hard gate because this page shipped correct and unreadable, twice: once
     with no stylesheet at all, then with a diagram that fenced and closed
     early so half of it rendered as prose. Both times the unit tests were
     green, because they read the source string. Only a browser against the
     deployed page can tell the difference, and a check that only runs when
     somebody remembers to run it would not have caught either. */
  "tests/e2e/playbook-readable.spec.ts",
];

/**
 * Specs deliberately not run by this workflow, each with the reason.
 *
 * An unlisted spec is not a test: it rots silently and its red is invisible.
 * ai-router-behaviour.spec.ts sat unlisted from the day it was written, and by
 * 2026-08-20 five of its assertions had been obsoleted by #279 with nothing to
 * say so. Anything genuinely out of scope belongs here, named, so the omission
 * is a decision somebody made rather than an oversight nobody can see.
 */

/**
 * KNOWN-UNRUN BACKLOG, and it is meant to shrink.
 *
 * 70 of the 100 specs in tests/e2e are referenced by no workflow. They
 * were written, reviewed, and then never executed by anything, so none of them
 * can fail and none of them is evidence of anything. This list exists so that
 * number is visible and can only go DOWN: the test below fails on any spec not
 * on it, so a NEW orphan is caught on the PR that creates it, while the
 * existing backlog does not block unrelated work.
 *
 * Removing a name from this list means wiring the spec into a workflow. Adding
 * one is not allowed: write the spec into a job instead.
 *
 * Snapshot taken 2026-08-20, after ai-router-behaviour.spec.ts was found red
 * for weeks with five assertions obsoleted by #279 and nothing to report it.
 */
const KNOWN_UNRUN: string[] = [
  "tests/e2e/agent-control-plane.spec.ts",
  "tests/e2e/agent-deployments-pipeline.spec.ts",
  "tests/e2e/agent-detail-console.spec.ts",
  "tests/e2e/agent-model-regression.spec.ts",
  "tests/e2e/agent-screenshot-thumbnail.spec.ts",
  "tests/e2e/agents-behavior-panel.spec.ts",
  "tests/e2e/agents-console.spec.ts",
  "tests/e2e/agents-release-gate.spec.ts",
  "tests/e2e/alicia-first-day.spec.ts",
  "tests/e2e/assistant-clarify-widget.spec.ts",
  "tests/e2e/assistant-cross-tab-sync.spec.ts",
  "tests/e2e/assistant-debug.spec.ts",
  "tests/e2e/assistant-meeting-grounded.spec.ts",
  "tests/e2e/assistant-prompts-coverage-matrix.spec.ts",
  "tests/e2e/assistant-search-tool.spec.ts",
  "tests/e2e/assistant-suggestions-reopen.spec.ts",
  "tests/e2e/assistant-widget-persistence.spec.ts",
  "tests/e2e/authenticated-routes-redirect.spec.ts",
  "tests/e2e/automations-porsche-summary.spec.ts",
  "tests/e2e/benchmark-dashboard.spec.ts",
  "tests/e2e/brain-upload-reality-check.spec.ts",
  "tests/e2e/brand-url-import-reality-check.spec.ts",
  "tests/e2e/client-assets-data-flow.spec.ts",
  "tests/e2e/competitive-benchmark.spec.ts",
  "tests/e2e/compliance-scan.spec.ts",
  "tests/e2e/cross-scan-insights.spec.ts",
  "tests/e2e/dashboard-ms-tiles.spec.ts",
  "tests/e2e/deployment-pipeline.spec.ts",
  "tests/e2e/device-sweep.spec.ts",
  "tests/e2e/documents-recognize.spec.ts",
  "tests/e2e/emails-inbox-view.spec.ts",
  "tests/e2e/figma-import-reality-check.spec.ts",
  "tests/e2e/finance-receipt-router.spec.ts",
  "tests/e2e/hr-roster-access.spec.ts",
  "tests/e2e/job-code-concurrency-flow.spec.ts",
  "tests/e2e/job-code-dossier-flow.spec.ts",
  "tests/e2e/job-codes-flow.spec.ts",
  "tests/e2e/meeting-insights-analysis.spec.ts",
  "tests/e2e/meeting-insights-analyze.spec.ts",
  "tests/e2e/meeting-insights-feeds.spec.ts",
  "tests/e2e/meeting-prep.spec.ts",
  "tests/e2e/microsoft-banner.spec.ts",
  "tests/e2e/password-reset-flow.spec.ts",
  "tests/e2e/platform-scans-console.spec.ts",
  "tests/e2e/porsche-classes-poll-and-reprocess.spec.ts",
  "tests/e2e/portal-salesforce.spec.ts",
  "tests/e2e/release-gate.spec.ts",
  "tests/e2e/sites-acceptance-flow.spec.ts",
  "tests/e2e/sites-all-flows.spec.ts",
  "tests/e2e/sites-design-tokens-reality-check.spec.ts",
  "tests/e2e/sites-domain-flow.spec.ts",
  "tests/e2e/sites-edit-flow.spec.ts",
  "tests/e2e/sites-form-submit.spec.ts",
  "tests/e2e/sites-inline-edit-reality-check.spec.ts",
  "tests/e2e/sites-multi-frame-upload.spec.ts",
  "tests/e2e/sites-new-features.spec.ts",
  "tests/e2e/sites-prod-verify.spec.ts",
  "tests/e2e/sites-reorder-reality-check.spec.ts",
  "tests/e2e/sites-save-and-deploy.spec.ts",
  "tests/e2e/sites-section-comments-data-flow.spec.ts",
  "tests/e2e/sites-seo-reality-check.spec.ts",
  "tests/e2e/sites-share-approval-flow.spec.ts",
  "tests/e2e/sites-version-history-data-flow.spec.ts",
  "tests/e2e/sites-viewport-reality-check.spec.ts",
  "tests/e2e/sites-wireframe-and-image-gen.spec.ts",
  "tests/e2e/support-flow.spec.ts",
  "tests/e2e/tasks-assign.spec.ts",
  "tests/e2e/tasks-new-task.spec.ts",
  "tests/e2e/team-invite-flow.spec.ts",
];

const NOT_RUN_HERE: Record<string, string> = {
  "tests/e2e/smoke.spec.ts": "runs in the post-deploy smoke workflow",
  "tests/e2e/ai-router.spec.ts": "needs SMOKE_TEST credentials against prod; the behaviour spec covers this page without them",
  "tests/e2e/agent-onboarding.spec.ts": "has its own workflow (agent-onboarding-e2e.yml)",
  "tests/e2e/smoke-probe-waits.spec.ts":
    "runs in the verify gate itself, on every PR and every local run, via the " +
    "smoke-self-check stage in scripts/verify.sh. Not in this workflow on purpose: it " +
    "guards the smoke suite's own timing and serves its own pages, so it needs no " +
    "deployment and must run where the deployed-URL smoke cannot.",
};

function referencedSpecs(): string[] {
  return [...new Set(yaml.match(/tests\/e2e\/[a-z0-9-]+\.spec\.ts/g) ?? [])];
}

test("every spec the workflow references actually exists (no silently-dropped spec)", () => {
  const missing = referencedSpecs().filter((s) => !fs.existsSync(path.join(REPO_ROOT, s)));
  expect(missing).toEqual([]);
});

test("every hard gate is present", () => {
  for (const g of HARD_GATES) expect(yaml).toContain(g);
});

test("every e2e spec is either run by a workflow or listed as deliberately not", () => {
  /* THE CLASS OF BUG THIS CATCHES: a spec that exists, passes review, and is
     never executed anywhere. It cannot fail, so it drifts out of agreement
     with the page it guards and nobody finds out until someone runs it by
     hand. */
  const workflowsDir = path.join(REPO_ROOT, ".github/workflows");
  const allWorkflowText = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => fs.readFileSync(path.join(workflowsDir, f), "utf8"))
    .join("\n");

  const specsOnDisk = fs
    .readdirSync(path.join(REPO_ROOT, "tests/e2e"))
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => `tests/e2e/${f}`);

  const orphaned = specsOnDisk.filter(
    (spec) =>
      !allWorkflowText.includes(spec) &&
      !(spec in NOT_RUN_HERE) &&
      !KNOWN_UNRUN.includes(spec),
  );
  expect(orphaned).toEqual([]);
});

test("the known-unrun backlog only shrinks", () => {
  /* A name left behind after its spec is wired in, or after the spec is
     deleted, quietly re-opens the hole this list was written to close. */
  const workflowsDir = path.join(REPO_ROOT, ".github/workflows");
  const allWorkflowText = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => fs.readFileSync(path.join(workflowsDir, f), "utf8"))
    .join("\n");

  const stale = KNOWN_UNRUN.filter(
    (spec) => allWorkflowText.includes(spec) || !fs.existsSync(path.join(REPO_ROOT, spec)),
  );
  expect(stale).toEqual([]);
});

test("targets the deployed app: skips loudly when PROD_URL is unset (no local dev-server fallback in CI)", () => {
  expect(yaml).toMatch(/PROD_URL secret not set/i);
  expect(yaml).toMatch(/configured=false/);
  // Every spec-running step is gated on the PROD_URL check.
  expect(yaml).toMatch(/steps\.cfg\.outputs\.configured == 'true'/);
});

test("soft specs run on push-to-main ONLY (kept off the PR critical path)", () => {
  // The soft-specs step gate combines the config flag with a push-only event check.
  expect(yaml).toMatch(/configured == 'true' && github\.event_name == 'push'/);
});

test("the Playwright browser is cached (the install only runs on a version bump)", () => {
  expect(yaml).toMatch(/~\/\.cache\/ms-playwright/);
  expect(yaml).toMatch(/cache-hit/);
});

test("the hard gates run in a single parallel invocation", () => {
  // One playwright invocation with --workers=2 carrying both gate specs.
  const gatesStep = yaml.slice(yaml.indexOf("Reality-check gates"));
  expect(gatesStep).toMatch(/--workers=2/);
  for (const g of HARD_GATES) expect(gatesStep.slice(0, gatesStep.indexOf("Reality-check soft"))).toContain(g);
});
