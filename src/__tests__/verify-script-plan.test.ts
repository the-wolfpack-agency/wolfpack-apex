/**
 * Contract test for scripts/verify.sh's stage/shard PLANNING logic.
 *
 * verify.sh gained a VERIFY_DRY_RUN=1 mode that resolves which stages would
 * run (honoring VERIFY_STAGES) plus the jest shard + worker settings, prints
 * the plan, and exits 0 WITHOUT executing anything. That lets us assert the
 * CI parallelization knobs (used by .github/workflows/verify.yml) without
 * booting jest/next/playwright.
 *
 * Sibling file verify-script.test.ts covers the real PASS/FAIL orchestration;
 * this file is disjoint and covers only the planner. Guards against a
 * regression where a stage filter or shard flag silently stops being honored.
 */
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "verify.sh");

// Strip any verify-control vars the CI unit job sets at the job level
// (VERIFY_STAGES=unit, JEST_SHARD, ...). Without this they leak into the
// spawned verify.sh and the "default plans every stage" assertion fails in CI.
// Each test then sets exactly the env it intends via extraEnv.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "VERIFY_STAGES",
    "JEST_SHARD",
    "JEST_WORKERS",
    "JEST_JSON",
    "VERIFY_DRY_RUN",
    "VERIFY_SKIP_E2E",
    "VERIFY_SKIP_BUILD",
  ]) {
    delete env[k];
  }
  return env;
}

function plan(extraEnv: Record<string, string> = {}) {
  const res = spawnSync("bash", [SCRIPT], {
    env: { ...cleanEnv(), VERIFY_DRY_RUN: "1", ...extraEnv },
    encoding: "utf-8",
  });
  return res;
}

describe("scripts/verify.sh VERIFY_DRY_RUN plan", () => {
  it("default (no VERIFY_STAGES) plans every stage in order and exits 0", () => {
    const res = plan();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/=== verify plan ===/);
    expect(res.stdout).toMatch(/stages-filter: all/);
    expect(res.stdout).toMatch(/- lint/);
    expect(res.stdout).toMatch(/- typecheck/);
    expect(res.stdout).toMatch(/- unit-tests/);
    expect(res.stdout).toMatch(/- qr-download-decode/);
    expect(res.stdout).toMatch(/- next-build/);
  });

  it("default unit stage carries the honest-resourcing jest flags", () => {
    const res = plan();
    expect(res.stdout).toMatch(/--maxWorkers=50%/);
    expect(res.stdout).toMatch(/--workerIdleMemoryLimit=512MB/);
    expect(res.stdout).toMatch(/--json --outputFile=jest-results\.json/);
    // no global testTimeout / retries leaked into the command
    expect(res.stdout).not.toMatch(/--testTimeout/);
    expect(res.stdout).not.toMatch(/retryTimes/);
  });

  it("VERIFY_STAGES=unit plans ONLY the unit stage", () => {
    const res = plan({ VERIFY_STAGES: "unit" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/stages-filter: unit/);
    expect(res.stdout).toMatch(/- unit-tests/);
    expect(res.stdout).not.toMatch(/- lint/);
    expect(res.stdout).not.toMatch(/- typecheck/);
    expect(res.stdout).not.toMatch(/- qr-download-decode/);
    expect(res.stdout).not.toMatch(/- next-build/);
  });

  it("VERIFY_STAGES=typecheck,lint plans only those two (the lint-types CI job)", () => {
    const res = plan({ VERIFY_STAGES: "typecheck,lint" });
    expect(res.stdout).toMatch(/- lint/);
    expect(res.stdout).toMatch(/- typecheck/);
    expect(res.stdout).not.toMatch(/- unit-tests/);
    expect(res.stdout).not.toMatch(/- e2e-smoke/);
  });

  it("JEST_SHARD=2/4 surfaces --shard=2/4 in the unit command", () => {
    const res = plan({ VERIFY_STAGES: "unit", JEST_SHARD: "2/4" });
    expect(res.stdout).toMatch(/jest-shard:\s+2\/4/);
    expect(res.stdout).toMatch(/--shard=2\/4/);
  });

  it("no JEST_SHARD => no --shard flag (local full run is unsharded)", () => {
    const res = plan({ VERIFY_STAGES: "unit" });
    expect(res.stdout).toMatch(/jest-shard:\s+none/);
    expect(res.stdout).not.toMatch(/--shard=/);
  });

  it("JEST_WORKERS override is reflected in the plan", () => {
    const res = plan({ VERIFY_STAGES: "unit", JEST_WORKERS: "75%" });
    expect(res.stdout).toMatch(/jest-workers: 75%/);
    expect(res.stdout).toMatch(/--maxWorkers=75%/);
  });

  it("JEST_JSON override changes the artifact output path", () => {
    const res = plan({ VERIFY_STAGES: "unit", JEST_JSON: "shard-2.json" });
    expect(res.stdout).toMatch(/jest-json:\s+shard-2\.json/);
    expect(res.stdout).toMatch(/--outputFile=shard-2\.json/);
  });

  it("VERIFY_STAGES=e2e under CI plans the browser stages including e2e-smoke", () => {
    const res = plan({ VERIFY_STAGES: "e2e", CI: "true" });
    expect(res.stdout).toMatch(/- qr-download-decode/);
    expect(res.stdout).toMatch(/- next-build/);
    expect(res.stdout).toMatch(/- e2e-smoke/);
    expect(res.stdout).not.toMatch(/- unit-tests/);
  });

  it("e2e-smoke is NOT planned locally (CI-only stage)", () => {
    const res = plan({ VERIFY_STAGES: "e2e", CI: "" });
    expect(res.stdout).toMatch(/- qr-download-decode/);
    expect(res.stdout).not.toMatch(/- e2e-smoke/);
  });
});
