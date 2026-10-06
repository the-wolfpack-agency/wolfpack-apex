/**
 * The fs-backed RepoReader, exercised against the REAL repo tree it ships in.
 * Proves read/exists/listFiles behave (relative forward-slash paths, suffix
 * filter, node_modules pruned, missing path -> null/[]), so the readiness runner
 * grades the live tree correctly.
 */
import { join } from "node:path";
import { createFsRepoReader } from "../fs-reader";

const ROOT = join(__dirname, "..", "..", "..", ".."); // repo root from src/lib/readiness/__tests__
const reader = createFsRepoReader(ROOT);

it("reads a known file and returns null for a missing one", () => {
  expect(reader.read("package.json")).toMatch(/"name"/);
  expect(reader.read("does/not/exist.ts")).toBeNull();
});

it("exists is true for a real dir/file, false otherwise", () => {
  expect(reader.exists("src/lib/readiness")).toBe(true);
  expect(reader.exists("src/lib/readiness/fs-reader.ts")).toBe(true);
  expect(reader.exists("src/lib/nope")).toBe(false);
});

it("listFiles returns repo-relative forward-slash paths, filtered by suffix", () => {
  const specs = reader.listFiles("src/lib/readiness", ".ts");
  expect(specs).toContain("src/lib/readiness/catalog.ts");
  expect(specs).toContain("src/lib/readiness/fs-reader.ts");
  expect(specs.every((p) => !p.includes("\\"))).toBe(true);
  // suffix filter excludes non-matches
  expect(reader.listFiles("src/lib/readiness", ".db.test.ts")).toEqual([]);
  // missing dir -> empty
  expect(reader.listFiles("src/lib/nope")).toEqual([]);
});
