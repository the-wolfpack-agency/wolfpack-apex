/**
 * #10 exemplar store: pure clamp + grounding block, plus the never-throwing
 * record/mark/load over a mocked db. Real-schema landing + the merged-flip is in
 * the .db.test.ts.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import {
  clampPrompt, buildExemplarBlock, recordExemplar, markExemplarMerged, loadExemplars,
  MAX_EXEMPLAR_PROMPT, EXEMPLAR_LIMIT, type Exemplar,
} from "@/lib/ai-code/factory-exemplar-store";

beforeEach(() => jest.clearAllMocks());

describe("clampPrompt", () => {
  it("trims and caps to MAX_EXEMPLAR_PROMPT", () => {
    expect(clampPrompt("  hi  ")).toBe("hi");
    expect(clampPrompt("x".repeat(MAX_EXEMPLAR_PROMPT + 50)).length).toBe(MAX_EXEMPLAR_PROMPT);
  });
});

describe("buildExemplarBlock", () => {
  it("is empty with no exemplars (adds nothing to the prompt)", () => {
    expect(buildExemplarBlock([])).toBe("");
  });
  it("renders one line per exemplar with task type + model", () => {
    const ex: Exemplar[] = [{ repo: "o/r", taskType: "migration", prompt: "Add a quotas table\n  with RLS", model: "gpt-4o-mini" }];
    const block = buildExemplarBlock(ex);
    expect(block).toMatch(/SHIPPED EXAMPLES/);
    expect(block).toMatch(/\[migration\] shipped via gpt-4o-mini/);
    expect(block).toMatch(/Add a quotas table with RLS/); // whitespace collapsed
  });
});

describe("recordExemplar", () => {
  it("no-op without an approvalId (no query)", async () => {
    expect((await recordExemplar({ workspaceId: "w1", approvalId: "", repo: "o/r", taskType: "ui", prompt: "p", model: "m" })).written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("inserts ON CONFLICT DO NOTHING, clamps the prompt, defaults task/model", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await recordExemplar({ workspaceId: "w1", approvalId: "appr1", repo: "o/r", taskType: "", prompt: "  hello  ", model: "" });
    expect(r.written).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_factory_exemplars/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, approval_id\) DO NOTHING/);
    expect(params).toEqual(["w1", "appr1", "o/r", "other", "hello", ""]);
  });
  it("never throws on a db error", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(recordExemplar({ workspaceId: "w1", approvalId: "a", repo: "r", taskType: "ui", prompt: "p", model: "m" })).resolves.toEqual({ written: 0 });
  });
});

describe("markExemplarMerged", () => {
  it("flips only a not-yet-merged row; returns the count", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await markExemplarMerged("w1", "appr1");
    expect(r).toEqual({ merged: 1 });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_factory_exemplars/);
    expect(sql).toMatch(/merged = true/);
    expect(sql).toMatch(/AND merged = false/);
  });
  it("no-op + never throws without approvalId / on error", async () => {
    expect(await markExemplarMerged("w1", "")).toEqual({ merged: 0 });
    mockQuery.mockRejectedValue(new Error("x"));
    expect(await markExemplarMerged("w1", "a")).toEqual({ merged: 0 });
  });
});

describe("loadExemplars", () => {
  it("reads merged exemplars for a task type, workspace scoped, clamped limit", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ repo: "o/r", task_type: "api", prompt: "add route", model: "m" }] });
    const ex = await loadExemplars("w1", "api", 999); // over cap -> default
    expect(ex).toEqual([{ repo: "o/r", taskType: "api", prompt: "add route", model: "m" }]);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/merged = true/);
    expect(sql).toMatch(new RegExp(`LIMIT ${EXEMPLAR_LIMIT}`));
    expect(params).toEqual(["w1", "api"]);
  });
});
