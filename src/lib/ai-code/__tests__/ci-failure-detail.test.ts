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

import { extractErrorLines, extractFilePaths, buildEnrichedFixPrompt, gatherFailureContext, fetchFilesContent, hasFixAnchor, guardAuthoredFix } from "@/lib/ai-code/ci-failure-detail";

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
  expect(prompt).toMatch(/Never delete, disable, skip, or otherwise weaken a test/i);
  expect(prompt).toMatch(/correct that test.s expected value/i);
});

test("buildEnrichedFixPrompt adds a correct-the-wrong-test hint when an authored test keeps failing", () => {
  const prompt = buildEnrichedFixPrompt({
    repo: "o/r", branch: "factory/x", brief: "unit failed",
    context: { detail: "FAIL x.test.ts\nExpected 194400\nReceived 187200", files: [] },
    authoredTestStillFailing: ["src/lib/__tests__/parseDuration.test.ts"],
  });
  expect(prompt).toContain("STILL failing: src/lib/__tests__/parseDuration.test.ts");
  expect(prompt).toMatch(/correct the expected value/i);
  expect(prompt).toMatch(/"Received" is the source.s actual result/i);
});

test("buildEnrichedFixPrompt degrades gracefully with no context (just the brief)", () => {
  const prompt = buildEnrichedFixPrompt({ repo: "o/r", branch: "factory/x", brief: "unit-tests failed", context: { detail: "", files: [] } });
  expect(prompt).toMatch(/unit-tests failed/);
  expect(prompt).not.toMatch(/ACTUAL CI failure/);
  expect(prompt).not.toMatch(/FILE:/);
});

test("buildEnrichedFixPrompt anchors to the change's files and forbids inventing a new path", () => {
  // Dogfooding regression: with empty failure context the fixer authored a new
  // file at an invented path (src/lib/utils/deepMerge.js) instead of editing the
  // real changed file. The changedFiles anchor must be stated explicitly.
  const prompt = buildEnrichedFixPrompt({
    repo: "o/r",
    branch: "factory/deepmerge",
    brief: "unit-tests failed",
    context: { detail: "", files: [] },
    changedFiles: ["src/lib/deepMerge.ts", "src/lib/__tests__/deepMerge.test.ts"],
  });
  expect(prompt).toMatch(/consists of EXACTLY these file\(s\): src\/lib\/deepMerge\.ts/);
  expect(prompt).toMatch(/Do NOT create a new file at a different path or with a different extension/i);
  expect(prompt).toMatch(/modify it in place/i);
});

test("buildEnrichedFixPrompt omits the changed-files anchor when none are known", () => {
  const prompt = buildEnrichedFixPrompt({ repo: "o/r", branch: "b", brief: "x", context: { detail: "", files: [] }, changedFiles: [] });
  expect(prompt).not.toMatch(/consists of EXACTLY these/i);
});

describe("hasFixAnchor (fail-closed pre-check)", () => {
  it("false when there is no detail, no files, and no known changed files", () => {
    expect(hasFixAnchor({ detail: "", files: [] }, [])).toBe(false);
  });
  it("true from failure detail alone", () => {
    expect(hasFixAnchor({ detail: "FAIL x", files: [] }, [])).toBe(true);
  });
  it("true from the change's file list alone (the empty-log case)", () => {
    expect(hasFixAnchor({ detail: "", files: [] }, ["src/lib/deepMerge.ts"])).toBe(true);
  });
  it("true from fetched file contents alone", () => {
    expect(hasFixAnchor({ detail: "", files: [{ path: "a.ts", content: "x" }] }, [])).toBe(true);
  });
});

describe("guardAuthoredFix (anti-hallucination)", () => {
  it("rejects a fix that edits none of the change's files and only invents new paths", () => {
    // The exact dogfooding failure: change is deepMerge.ts, fix wrote utils/*.js.
    const r = guardAuthoredFix({
      changes: [{ path: "src/lib/utils/deepMerge.js" }, { path: "src/lib/utils/deepMerge.test.js" }],
      authorError: null,
      changedFiles: ["src/lib/deepMerge.ts", "src/lib/__tests__/deepMerge.test.ts"],
    });
    expect(r.changes).toEqual([]);
    expect(r.error).toMatch(/refusing to commit a parallel file/i);
    expect(r.error).toMatch(/src\/lib\/utils\/deepMerge\.js/);
  });

  it("accepts a fix that edits a real changed file (and keeps any added helper)", () => {
    const r = guardAuthoredFix({
      changes: [{ path: "src/lib/deepMerge.ts" }, { path: "src/lib/deepMerge.helper.ts" }],
      authorError: null,
      changedFiles: ["src/lib/deepMerge.ts"],
    });
    expect(r.changes.map((c) => c.path)).toEqual(["src/lib/deepMerge.ts", "src/lib/deepMerge.helper.ts"]);
    expect(r.error).toBeNull();
  });

  it("passes through when the change's files are unknown (no anchor to enforce)", () => {
    const r = guardAuthoredFix({ changes: [{ path: "anything.ts" }], authorError: null, changedFiles: [] });
    expect(r.changes.map((c) => c.path)).toEqual(["anything.ts"]);
    expect(r.error).toBeNull();
  });

  it("propagates an author error and drops changes", () => {
    const r = guardAuthoredFix({ changes: [{ path: "a.ts" }], authorError: "model failed", changedFiles: ["a.ts"] });
    expect(r.changes).toEqual([]);
    expect(r.error).toBe("model failed");
  });
});

describe("fetchFilesContent", () => {
  beforeEach(() => mockFile.mockReset());

  it("fetches content for each path, caps per-file length, and skips 404s", async () => {
    mockFile.mockImplementation((_c, _r, path: string) =>
      path === "gone.ts" ? Promise.reject(new Error("404")) : Promise.resolve("X".repeat(9000)),
    );
    const files = await fetchFilesContent({} as never, "o/r", ["a.ts", "gone.ts", "b.ts"], "branch", { maxCharsPerFile: 100 });
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]); // 404 skipped
    expect(files[0].content.length).toBe(100); // capped
  });

  it("respects the maxFiles cap", async () => {
    mockFile.mockResolvedValue("ok");
    const files = await fetchFilesContent({} as never, "o/r", ["a", "b", "c", "d"], "branch", { maxFiles: 2 });
    expect(files).toHaveLength(2);
  });
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

  it("reads a failing job even when the workflow RUN name differs from the CHECK name (the apex bug #986 did not fix)", async () => {
    // Real repos name the workflow RUN differently from the CHECK: a run "Verify"
    // contains a failing "lint-types" job. onlyRunNames holds CHECK/job names, so
    // scoping by run name alone excluded everything -> detailChars:0 and a blind
    // fixer. This is the red-before-green reproducing test: it FAILS on the code
    // that only matches run names, and PASSES once job names are matched too.
    mockListRuns.mockResolvedValue([{ id: 5, name: "Verify", conclusion: "failure" }]);
    mockListJobs.mockResolvedValue([{ id: 50, name: "lint-types", conclusion: "failure" }]);
    mockLog.mockResolvedValue("2026-09-29T00:00:00Z ##[error]src/lib/ogiam/policy.ts(162,7): error TS1005: '}' expected.");
    const r = await gatherFailureContext({} as never, "o/r", "sha", "ref", { onlyRunNames: ["lint-types"] });
    expect(mockListJobs).toHaveBeenCalledWith(expect.anything(), "o/r", 5); // the run was NOT excluded by its name
    expect(r.detail).toMatch(/error TS1005/); // its failing lint-types job's log was read
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

describe("subtype-aware fix prompt", () => {
  it("adds a TYPE-error hint that forbids casting to any", () => {
    const p = buildEnrichedFixPrompt({ repo: "o/r", branch: "b", brief: "x", context: { detail: "error TS2322", files: [] }, subtype: "type" });
    expect(p).toMatch(/TYPE error/);
    expect(p).toMatch(/do not cast to any/i);
  });
  it("adds an IMPORT hint", () => {
    const p = buildEnrichedFixPrompt({ repo: "o/r", branch: "b", brief: "x", context: { detail: "Cannot find module", files: [] }, subtype: "import" });
    expect(p).toMatch(/IMPORT \/ module-resolution/);
  });
  it("no hint for a plain test subtype", () => {
    const p = buildEnrichedFixPrompt({ repo: "o/r", branch: "b", brief: "x", context: { detail: "", files: [] }, subtype: "test" });
    expect(p).not.toMatch(/TYPE error|IMPORT \//);
  });
});
