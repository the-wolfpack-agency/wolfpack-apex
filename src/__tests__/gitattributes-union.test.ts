/**
 * Guard for the append-only union merge strategy (.gitattributes).
 *
 * These registry files (analytics event union, the audit allowlist, the e2e
 * soft-spec list) are append-only and every feature branch adds to them, so they
 * are configured `merge=union` to auto-resolve the trivial insert-vs-insert
 * conflicts that otherwise pile up across simultaneous PRs. If that mapping is
 * dropped (or someone unions the GENERATED tenant baseline, which would corrupt
 * its JSON), the churn quietly returns. This pins the invariant.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const attrs = fs.readFileSync(path.join(REPO_ROOT, ".gitattributes"), "utf8");

/** Files that MUST be union-merged (append-only, line-oriented registries). */
const UNION_FILES = [
  "src/lib/analytics.ts",
  "src/__tests__/AUDIT_ALLOWLIST.ts",
  ".github/workflows/e2e-reality-check.yml",
];

/** A line that maps `file` to `merge=union`, tolerant of the column whitespace. */
function hasUnion(file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s+merge=union\\s*$`, "m").test(attrs);
}

test("every append-only registry file is configured merge=union", () => {
  const missing = UNION_FILES.filter((f) => !hasUnion(f));
  expect(missing).toEqual([]);
});

test("every union-mapped file actually exists (no stale path)", () => {
  const stale = UNION_FILES.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  expect(stale).toEqual([]);
});

test("the GENERATED tenant-isolation baseline is NOT union-merged (union corrupts JSON)", () => {
  // It must be regenerated on conflict, never line-merged.
  expect(attrs).not.toMatch(/tenant-isolation-baseline\.json\s+merge=union/);
});
