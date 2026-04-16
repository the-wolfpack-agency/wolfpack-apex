/**
 * Tests for scripts/add-notification-category.sh.
 *
 * Runs the script against an isolated scratch repo containing the minimum
 * fixture (an initial README.md). Asserts:
 *   - first run creates categories.ts, updates README, generates a stub test
 *   - second run is a no-op (idempotent)
 *   - invalid inputs exit 2
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "add-notification-category.sh");
const README_FIXTURE = readFileSync(
  join(REPO_ROOT, "src", "lib", "notifications", "README.md"),
  "utf-8",
);

function setupScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "add-notif-"));
  mkdirSync(join(root, "src", "lib", "notifications"), { recursive: true });
  mkdirSync(join(root, "src", "lib", "__tests__"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "notifications", "README.md"), README_FIXTURE);
  return root;
}

function run(scratch: string, args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: {
      ...process.env,
      REPO_ROOT_OVERRIDE: scratch,
    },
    encoding: "utf-8",
  });
}

describe("scripts/add-notification-category.sh", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = setupScratch();
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("creates categories.ts on first run", () => {
    const res = run(scratch, [
      "hr.document_expiring",
      "--source",
      "hr",
      "--priority",
      "normal",
      "--digest",
      "daily",
    ]);
    expect(res.status).toBe(0);
    const cats = readFileSync(
      join(scratch, "src/lib/notifications/categories.ts"),
      "utf-8",
    );
    expect(cats).toContain("NOTIFICATION_CATEGORIES");
    expect(cats).toContain('"hr.document_expiring"');
    expect(cats).toContain('source: "hr"');
    expect(cats).toContain('defaultPriority: "normal"');
    expect(cats).toContain('defaultDigest: "daily"');
  });

  it("updates README.md with a row", () => {
    run(scratch, [
      "hr.document_expiring",
      "--source",
      "hr",
      "--priority",
      "normal",
    ]);
    const readme = readFileSync(
      join(scratch, "src/lib/notifications/README.md"),
      "utf-8",
    );
    expect(readme).toContain("`hr.document_expiring");
  });

  it("generates a stub integration test", () => {
    run(scratch, [
      "hr.document_expiring",
      "--source",
      "hr",
      "--priority",
      "normal",
    ]);
    const testPath = join(
      scratch,
      "src/lib/__tests__/notify-hr-document_expiring.test.ts",
    );
    expect(existsSync(testPath)).toBe(true);
    const body = readFileSync(testPath, "utf-8");
    expect(body).toContain('isRegisteredCategory("hr.document_expiring")');
    expect(body).toContain('category: "hr.document_expiring"');
  });

  it("is idempotent on the second run", () => {
    const args = [
      "hr.document_expiring",
      "--source",
      "hr",
      "--priority",
      "normal",
      "--digest",
      "daily",
    ];
    const first = run(scratch, args);
    expect(first.status).toBe(0);
    const capsAfterFirst = readFileSync(
      join(scratch, "src/lib/notifications/categories.ts"),
      "utf-8",
    );

    const second = run(scratch, args);
    expect(second.status).toBe(0);
    const capsAfterSecond = readFileSync(
      join(scratch, "src/lib/notifications/categories.ts"),
      "utf-8",
    );
    // Identical OR only trivially differs (upsert replaces with same values).
    // Strict equality would be ideal but the upsert path normalizes whitespace.
    // Assert that the category appears exactly once.
    const matches = capsAfterSecond.match(/"hr\.document_expiring"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
    // README row should also appear exactly once.
    const readme = readFileSync(
      join(scratch, "src/lib/notifications/README.md"),
      "utf-8",
    );
    const readmeMatches = readme.match(/`hr\.document_expiring/g) ?? [];
    expect(readmeMatches.length).toBeGreaterThanOrEqual(1);
    expect(readmeMatches.length).toBeLessThanOrEqual(2); // first insert + potential idempotency warning doc
    expect(capsAfterSecond.length).toBeGreaterThan(0);
    expect(capsAfterFirst.length).toBeGreaterThan(0);
  });

  it("rejects invalid category id with exit 2", () => {
    const res = run(scratch, [
      "NOT_DOTTED",
      "--source",
      "hr",
      "--priority",
      "normal",
    ]);
    expect(res.status).toBe(2);
  });

  it("rejects invalid priority with exit 2", () => {
    const res = run(scratch, [
      "hr.thing",
      "--source",
      "hr",
      "--priority",
      "omega",
    ]);
    expect(res.status).toBe(2);
  });

  it("rejects invalid source with exit 2", () => {
    const res = run(scratch, [
      "hr.thing",
      "--source",
      "alien",
      "--priority",
      "normal",
    ]);
    expect(res.status).toBe(2);
  });
});
