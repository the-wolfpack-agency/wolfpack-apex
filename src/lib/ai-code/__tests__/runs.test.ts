/**
 * listPipelineRuns maps the ai_code.pipeline_run event stream (workspace-scoped)
 * to run summaries; toRunRecords flips to oldest-first grader records. db mocked.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { listPipelineRuns, toRunRecords, listRunRepos } from "@/lib/ai-code/runs";

beforeEach(() => jest.clearAllMocks());

test("maps metadata rows to run summaries, newest-first", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { metadata: { workspace_id: "w1", ref: "pr-2", model: "gpt-4o-mini", status: "ready_for_pr", attempts: 0, final_outcome: "allow", deep_scan_critical: 0, conforms: true }, timestamp: "2026-09-27T10:00:00Z" },
      { metadata: JSON.stringify({ workspace_id: "w1", ref: "pr-1", model: "claude", status: "needs_human", attempts: 2, final_outcome: "block", deep_scan_critical: 1, conforms: false }), timestamp: "2026-09-27T09:00:00Z" },
    ],
  });
  const runs = await listPipelineRuns("w1", 50);
  expect(mockSafeQuery).toHaveBeenCalledWith(expect.stringContaining("metadata->>'workspace_id' = $1"), ["w1"]);
  expect(runs[0]).toMatchObject({ ref: "pr-2", model: "gpt-4o-mini", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", conforms: true });
  expect(runs[1]).toMatchObject({ ref: "pr-1", status: "needs_human", attempts: 2, finalOutcome: "block", deepScanCritical: 1, conforms: false });
});

test("maps the persisted diff, truncation flag, and verdict reason for the history code view", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { metadata: { workspace_id: "w1", ref: "pr-3", model: "gpt-4o-mini", status: "ready_for_pr", final_outcome: "allow", diff: "diff --git a/x b/x\n+const k=1;", diff_truncated: true, verdict_reason: "no findings" }, timestamp: "2026-09-27T11:00:00Z" },
      { metadata: { workspace_id: "w1", ref: "pr-old", model: "claude", status: "ready_for_pr", final_outcome: "allow" }, timestamp: "2026-09-27T08:00:00Z" },
    ],
  });
  const runs = await listPipelineRuns("w1", 50);
  expect(runs[0]).toMatchObject({ ref: "pr-3", diff: expect.stringContaining("const k=1;"), diffTruncated: true, reason: "no findings" });
  // A run recorded before diffs were persisted carries no diff (undefined, not "").
  expect(runs[1].diff).toBeUndefined();
  expect(runs[1].diffTruncated).toBeUndefined();
});

test("returns [] on a read failure (never throws)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  expect(await listPipelineRuns("w1")).toEqual([]);
});

test("toRunRecords flips to oldest-first with parsed ts", () => {
  const recs = toRunRecords([
    { ref: "b", model: "m", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", deepScanCritical: 0, conforms: true, createdAt: "2026-09-27T10:00:00Z" },
    { ref: "a", model: "m", status: "ready_for_pr", attempts: 1, finalOutcome: "allow", deepScanCritical: 0, conforms: true, createdAt: "2026-09-27T09:00:00Z" },
  ]);
  expect(recs.map((r) => r.attempts)).toEqual([1, 0]); // oldest (a) first
  expect(recs[0].ts).toBe(Date.parse("2026-09-27T09:00:00Z"));
});

test("attributes each run to its target repo; missing repo is null (pre-attribution)", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { metadata: { workspace_id: "w1", ref: "pr-ford", repo: "the-wolfpack-agency/wolfpack-ford", status: "ready_for_pr", final_outcome: "allow" }, timestamp: "2026-09-30T10:00:00Z" },
      { metadata: { workspace_id: "w1", ref: "pr-self", status: "ready_for_pr", final_outcome: "allow" }, timestamp: "2026-09-30T09:00:00Z" },
    ],
  });
  const runs = await listPipelineRuns("w1", 50);
  expect(runs[0].repo).toBe("the-wolfpack-agency/wolfpack-ford");
  expect(runs[1].repo).toBeNull();
});

test("a repo filter scopes the query to one site (adds the repo predicate + param)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  await listPipelineRuns("w1", 50, "the-wolfpack-agency/wolfpack-ford");
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toContain("metadata->>'repo' = $2");
  expect(params).toEqual(["w1", "the-wolfpack-agency/wolfpack-ford"]);
});

test("no repo filter omits the repo predicate (all sites)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  await listPipelineRuns("w1", 50);
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).not.toContain("metadata->>'repo'");
  expect(params).toEqual(["w1"]);
});

test("listRunRepos returns the distinct sites, self-default surfaced as (self), sorted", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [{ repo: "the-wolfpack-agency/wolfpack-ford" }, { repo: null }, { repo: "the-wolfpack-agency/wolfpack-cayenne-e4" }],
  });
  const repos = await listRunRepos("w1");
  expect(repos).toEqual([
    "(self)",
    "the-wolfpack-agency/wolfpack-cayenne-e4",
    "the-wolfpack-agency/wolfpack-ford",
  ]);
});

test("listRunRepos never throws on a read failure", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  expect(await listRunRepos("w1")).toEqual([]);
});
