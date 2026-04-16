/**
 * Tests for scripts/add-capability.sh.
 *
 * The script edits two TS files and runs a jest coverage test. To exercise
 * it in isolation, we copy the real capabilities.ts + role-capabilities.ts
 * into a scratch dir, point the script at them via REPO_ROOT_OVERRIDE, and
 * skip the jest re-run via SKIP_JEST=1.
 *
 * Assertions:
 *   - fresh insertion mutates both files
 *   - re-running is a no-op (idempotent)
 *   - invalid capability id exits with code 2
 *   - invalid role exits with code 2
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "add-capability.sh");
const CAPS_SRC = readFileSync(
  join(REPO_ROOT, "src", "lib", "auth", "capabilities.ts"),
  "utf-8",
);
const ROLES_SRC = readFileSync(
  join(REPO_ROOT, "src", "lib", "auth", "role-capabilities.ts"),
  "utf-8",
);

function setupScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "add-cap-"));
  mkdirSync(join(root, "src", "lib", "auth"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "auth", "capabilities.ts"), CAPS_SRC);
  writeFileSync(join(root, "src", "lib", "auth", "role-capabilities.ts"), ROLES_SRC);
  return root;
}

function run(scratch: string, args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: {
      ...process.env,
      REPO_ROOT_OVERRIDE: scratch,
      SKIP_JEST: "1",
    },
    encoding: "utf-8",
  });
}

describe("scripts/add-capability.sh", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = setupScratch();
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("inserts a new capability into both files", () => {
    const res = run(scratch, [
      "testonly.module.action",
      "hr,sales",
      "A test-only capability",
    ]);
    expect(res.status).toBe(0);
    const caps = readFileSync(join(scratch, "src/lib/auth/capabilities.ts"), "utf-8");
    const roles = readFileSync(join(scratch, "src/lib/auth/role-capabilities.ts"), "utf-8");
    expect(caps).toContain('"testonly.module.action": "A test-only capability"');
    // Both HR and SALES arrays should now list the new cap.
    expect(roles).toContain('"testonly.module.action"');
    const hrBlock = roles.match(/const\s+HR\s*:[\s\S]*?\n\];/)?.[0] ?? "";
    const salesBlock = roles.match(/const\s+SALES\s*:[\s\S]*?\n\];/)?.[0] ?? "";
    expect(hrBlock).toContain("testonly.module.action");
    expect(salesBlock).toContain("testonly.module.action");
  });

  it("is idempotent — running twice yields the same files", () => {
    const first = run(scratch, ["testonly.module.action", "hr", "desc"]);
    expect(first.status).toBe(0);
    const capsAfterFirst = readFileSync(
      join(scratch, "src/lib/auth/capabilities.ts"),
      "utf-8",
    );
    const rolesAfterFirst = readFileSync(
      join(scratch, "src/lib/auth/role-capabilities.ts"),
      "utf-8",
    );

    const second = run(scratch, ["testonly.module.action", "hr", "desc"]);
    expect(second.status).toBe(0);
    const capsAfterSecond = readFileSync(
      join(scratch, "src/lib/auth/capabilities.ts"),
      "utf-8",
    );
    const rolesAfterSecond = readFileSync(
      join(scratch, "src/lib/auth/role-capabilities.ts"),
      "utf-8",
    );

    expect(capsAfterSecond).toBe(capsAfterFirst);
    expect(rolesAfterSecond).toBe(rolesAfterFirst);
    // And the capability should appear exactly once.
    const occurrences = (capsAfterSecond.match(/"testonly\.module\.action":/g) ?? [])
      .length;
    expect(occurrences).toBe(1);
  });

  it("rejects a malformed capability id with exit 2", () => {
    const res = run(scratch, ["NOT_DOTTED", "hr", "desc"]);
    expect(res.status).toBe(2);
    expect(res.stderr + res.stdout).toMatch(/capability ID must be/);
  });

  it("rejects an unknown role with exit 2", () => {
    const res = run(scratch, ["mod.action", "dark_wizard", "desc"]);
    expect(res.status).toBe(2);
    expect(res.stderr + res.stdout).toMatch(/unknown role/);
  });

  it("refuses with usage when too few args", () => {
    const res = run(scratch, ["only-one"]);
    expect(res.status).toBe(2);
    expect(res.stderr + res.stdout).toMatch(/usage:/);
  });

  it("for cto-only, does not edit any role array (cto inherits ALL_CAPS)", () => {
    const res = run(scratch, ["mod.newcap.action", "cto", "CTO-only capability"]);
    expect(res.status).toBe(0);
    const caps = readFileSync(join(scratch, "src/lib/auth/capabilities.ts"), "utf-8");
    const roles = readFileSync(join(scratch, "src/lib/auth/role-capabilities.ts"), "utf-8");
    expect(caps).toContain('"mod.newcap.action"');
    // The role-capabilities file should NOT have been modified with the cap id
    // in any explicit role array.
    expect(roles.includes('"mod.newcap.action"')).toBe(false);
    expect(existsSync(join(scratch, "src/lib/auth/role-capabilities.ts"))).toBe(true);
  });
});
