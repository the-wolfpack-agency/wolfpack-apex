/**
 * The CI-fixer's failure-context parsers: pull the real error lines out of an
 * Actions job log (stripping the timestamp prefix), find the files the error
 * points at, and build an enriched re-author prompt. This is what lets the fixer
 * author a REAL fix instead of guessing from a check name.
 */
import { extractErrorLines, extractFilePaths, buildEnrichedFixPrompt } from "@/lib/ai-code/ci-failure-detail";

// A slice of a real jest job log (with the ISO timestamp prefix Actions adds).
const LOG = [
  "2026-09-27T22:38:37.0Z Run npm test",
  "2026-09-27T22:38:37.0834705Z FAIL src/lib/__tests__/readingTime.test.ts",
  "2026-09-27T22:38:37.0836086Z   ● readingTime › should throw error for invalid inputs",
  "2026-09-27T22:38:37.0842291Z     Expected substring: \"Invalid input to readingTime function\"",
  "2026-09-27T22:38:37.085Z     Received function did not throw",
  "2026-09-27T22:38:37.32Z PASS src/lib/__tests__/slug.test.ts",
  "2026-09-27T22:38:37.44Z ##[error]Process completed with exit code 1.",
].join("\n");

test("extractErrorLines keeps the failure lines and strips the timestamp prefix", () => {
  const err = extractErrorLines(LOG);
  expect(err).toMatch(/FAIL src\/lib\/__tests__\/readingTime\.test\.ts/);
  expect(err).toMatch(/should throw error for invalid inputs/);
  expect(err).toMatch(/Expected substring/);
  expect(err).toMatch(/exit code 1/);
  expect(err).not.toMatch(/2026-09-27T/); // timestamps stripped
  expect(err).not.toMatch(/PASS /); // passing lines dropped
});

test("extractFilePaths finds the source/test files referenced, deduped", () => {
  const err = extractErrorLines(LOG);
  const files = extractFilePaths(err + "\n at src/lib/readingTime.ts:10");
  expect(files).toContain("src/lib/__tests__/readingTime.test.ts");
  expect(files).toContain("src/lib/readingTime.ts");
  // deduped
  expect(new Set(files).size).toBe(files.length);
});

test("extractFilePaths is capped and empty when no code paths appear", () => {
  expect(extractFilePaths("no files here, just prose")).toEqual([]);
});

test("buildEnrichedFixPrompt carries the error detail + file contents + a fix-the-source instruction", () => {
  const prompt = buildEnrichedFixPrompt({
    repo: "o/r",
    branch: "factory/x",
    brief: "unit-tests failed",
    context: {
      detail: "FAIL readingTime.test.ts: Received function did not throw",
      files: [{ path: "src/lib/readingTime.ts", content: "export function readingTime(){}" }],
    },
  });
  expect(prompt).toMatch(/ACTUAL CI failure/);
  expect(prompt).toMatch(/did not throw/);
  expect(prompt).toMatch(/FILE: src\/lib\/readingTime\.ts/);
  expect(prompt).toMatch(/export function readingTime/);
  expect(prompt).toMatch(/do NOT weaken, delete, or trivially satisfy any test/i);
});

test("buildEnrichedFixPrompt degrades gracefully with no context (just the brief)", () => {
  const prompt = buildEnrichedFixPrompt({ repo: "o/r", branch: "factory/x", brief: "unit-tests failed", context: { detail: "", files: [] } });
  expect(prompt).toMatch(/unit-tests failed/);
  expect(prompt).not.toMatch(/ACTUAL CI failure/);
  expect(prompt).not.toMatch(/FILE:/);
});

describe("source-of-failing-test derivation", () => {
  const { deriveSourcePaths, withSourcePaths } = jest.requireActual("@/lib/ai-code/ci-failure-detail");

  it("derives the source path from a __tests__ jest test path", () => {
    expect(deriveSourcePaths("src/lib/__tests__/readingTime.test.ts")).toContain("src/lib/readingTime.ts");
  });

  it("derives the source from a same-dir .test/.spec file", () => {
    expect(deriveSourcePaths("src/components/Card.test.tsx")).toContain("src/components/Card.tsx");
    expect(deriveSourcePaths("src/lib/x.spec.ts")).toContain("src/lib/x.ts");
  });

  it("returns [] for a non-test path", () => {
    expect(deriveSourcePaths("src/lib/readingTime.ts")).toEqual([]);
  });

  it("withSourcePaths includes the test AND its source (so the fixer sees the code)", () => {
    const out = withSourcePaths(["src/lib/__tests__/readingTime.test.ts"]);
    expect(out).toContain("src/lib/__tests__/readingTime.test.ts");
    expect(out).toContain("src/lib/readingTime.ts");
  });
});
