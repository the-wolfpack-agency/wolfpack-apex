/**
 * The CI-fixer's failure-context parsers: pull the real error lines out of an
 * Actions job log (stripping the timestamp prefix), find the files the error
 * points at, and build an enriched re-author prompt. This is what lets the fixer
 * author a REAL fix instead of guessing from a check name.
 */
const mockListRuns = jest.fn();
const mockListJobs = jest.fn();
const mockLog = jest.fn();
const mockFile = jest.fn();
jest.mock("@/lib/github-client", () => ({
  listWorkflowRunsRaw: (...a: unknown[]) => mockListRuns(...a),
  listRunJobs: (...a: unknown[]) => mockListJobs(...a),
  fetchJobLogText: (...a: unknown[]) => mockLog(...a),
  fetchFileContent: (...a: unknown[]) => mockFile(...a),
}));

import { extractErrorLines, extractFilePaths, buildEnrichedFixPrompt, gatherFailureContext } from "@/lib/ai-code/ci-failure-detail";

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

describe("gatherFailureContext scopes to introduced runs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRuns.mockResolvedValue([
      { id: 1, name: "agenticqa-full-pipeline", conclusion: "failure" },
      { id: 2, name: "e2e", conclusion: "failure" },
    ]);
    mockListJobs.mockResolvedValue([{ id: 10, name: "test", conclusion: "failure" }]);
    mockLog.mockResolvedValue("2026-09-27T00:00:00Z FAIL src/lib/__tests__/readingTime.test.ts");
    mockFile.mockResolvedValue("export function readingTime(){}");
  });

  it("gathers ONLY the introduced run when onlyRunNames is given (skips pre-existing e2e)", async () => {
    await gatherFailureContext({} as never, "o/r", "sha", "ref", { onlyRunNames: ["agenticqa-full-pipeline"] });
    // Jobs fetched only for the introduced run id (1), never the pre-existing e2e run (2).
    expect(mockListJobs).toHaveBeenCalledWith(expect.anything(), "o/r", 1);
    expect(mockListJobs).not.toHaveBeenCalledWith(expect.anything(), "o/r", 2);
  });

  it("gathers all failing runs when onlyRunNames is empty/absent (baseline-unaware)", async () => {
    await gatherFailureContext({} as never, "o/r", "sha", "ref");
    expect(mockListJobs).toHaveBeenCalledWith(expect.anything(), "o/r", 1);
    expect(mockListJobs).toHaveBeenCalledWith(expect.anything(), "o/r", 2);
  });
});

describe("extractFailingTestFiles", () => {
  const { extractFailingTestFiles } = jest.requireActual("@/lib/ai-code/ci-failure-detail");
  it("pulls the FAIL <path> test files, deduped", () => {
    const log = "FAIL src/lib/__tests__/averageWordLength.test.ts\n  some detail\nFAIL src/lib/__tests__/averageWordLength.test.ts\nPASS src/lib/__tests__/ok.test.ts";
    const out = extractFailingTestFiles(log);
    expect(out).toEqual(["src/lib/__tests__/averageWordLength.test.ts"]);
  });
  it("returns [] when nothing failed", () => {
    expect(extractFailingTestFiles("all green, no FAIL lines")).toEqual([]);
  });
});
