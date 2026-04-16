/**
 * Validates that scripts/verify.sh behaves as contracted:
 *   - returns 0 when every stage passes
 *   - returns non-zero when any stage fails
 *   - prints a per-stage summary
 *
 * We shim the script's subcommands by putting a scratch dir at the front of
 * PATH that overrides `npm` / `npx` with tiny shell stubs. That way we exercise
 * the real orchestration, but don't have to boot next/jest/playwright.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "verify.sh");

function shim(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function runVerify(stubDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      CI: "true",           // ensure e2e branch is the CI branch
      VERIFY_SKIP_E2E: "1", // always skip e2e for the unit test — covered separately
      ...extraEnv,
    },
    encoding: "utf-8",
  });
}

describe("scripts/verify.sh", () => {
  let stubDir: string;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "verify-stub-"));
  });

  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  it("exits 0 and prints a summary when all stages pass", () => {
    // npm run lint  → succeed
    shim(stubDir, "npm", 'exit 0');
    // npx tsc / jest → succeed
    shim(stubDir, "npx", 'exit 0');

    const res = runVerify(stubDir);
    expect(res.stdout).toMatch(/verify summary/);
    expect(res.stdout).toMatch(/\[PASS\] lint/);
    expect(res.stdout).toMatch(/\[PASS\] typecheck/);
    expect(res.stdout).toMatch(/\[PASS\] unit-tests/);
    expect(res.stdout).toMatch(/\[SKIP\] e2e-smoke/);
    expect(res.status).toBe(0);
  }, 30_000);

  it("exits non-zero and marks the failing stage when lint fails", () => {
    shim(stubDir, "npm", 'exit 7');
    shim(stubDir, "npx", 'exit 0');

    const res = runVerify(stubDir);
    expect(res.stdout).toMatch(/\[FAIL\] lint/);
    expect(res.status).not.toBe(0);
  }, 30_000);

  it("exits non-zero and still runs downstream stages when typecheck fails", () => {
    shim(stubDir, "npm", 'exit 0');
    // fail only on tsc; let jest succeed
    shim(
      stubDir,
      "npx",
      [
        'if [[ "${1:-}" == "tsc" ]]; then',
        "  exit 2",
        "fi",
        'if [[ "${1:-}" == "jest" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );

    const res = runVerify(stubDir);
    expect(res.stdout).toMatch(/\[FAIL\] typecheck/);
    expect(res.stdout).toMatch(/\[PASS\] unit-tests/);
    expect(res.status).not.toBe(0);
  }, 30_000);
});
