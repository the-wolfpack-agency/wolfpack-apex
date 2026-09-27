/**
 * listPipelineRuns maps the ai_code.pipeline_run event stream (workspace-scoped)
 * to run summaries; toRunRecords flips to oldest-first grader records. db mocked.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { listPipelineRuns, toRunRecords } from "@/lib/ai-code/runs";

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
