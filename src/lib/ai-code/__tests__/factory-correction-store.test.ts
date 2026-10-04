/**
 * #3 correction store: record + the per-task-type signal fold over a mocked db.
 * Real-schema landing is in the .db.test.ts.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { recordCorrection, loadCorrectionSignals } from "@/lib/ai-code/factory-correction-store";
import type { CorrectionAnalysis } from "@/lib/ai-code/factory-correction-analysis";

const analysis = (over: Partial<CorrectionAnalysis> = {}): CorrectionAnalysis => ({
  edited: true, categories: ["tests"], humanAdded: 3, humanRemoved: 0, filesTouchedByHuman: 1, ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("recordCorrection", () => {
  it("no-op without approvalId", async () => {
    expect((await recordCorrection({ workspaceId: "w1", approvalId: "", repo: "o/r", taskType: "ui", analysis: analysis() })).written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("inserts ON CONFLICT DO NOTHING with categories + counts", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await recordCorrection({ workspaceId: "w1", approvalId: "a1", repo: "o/r", taskType: "migration", analysis: analysis({ categories: ["tests", "types"], humanAdded: 5 }) });
    expect(r.written).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_factory_corrections/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, approval_id\) DO NOTHING/);
    expect(params).toEqual(["w1", "a1", "o/r", "migration", true, ["tests", "types"], 5, 0]);
  });
  it("never throws on db error", async () => {
    mockQuery.mockRejectedValue(new Error("db"));
    await expect(recordCorrection({ workspaceId: "w1", approvalId: "a1", repo: "r", taskType: "ui", analysis: analysis() })).resolves.toEqual({ written: 0 });
  });
});

describe("loadCorrectionSignals", () => {
  it("computes edit rate + category rates over EDITED rows, strongest first", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [
      { edited: true, categories: ["tests", "error-handling"] },
      { edited: true, categories: ["tests"] },
      { edited: false, categories: [] },
    ] });
    const s = await loadCorrectionSignals("w1", "api");
    expect(s.total).toBe(3);
    expect(s.editRate).toBeCloseTo(2 / 3, 5);
    expect(s.categories[0]).toEqual({ category: "tests", rate: 1 });      // 2/2 edited
    expect(s.categories[1]).toEqual({ category: "error-handling", rate: 0.5 }); // 1/2 edited
  });
  it("empty shape on no rows / on error", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await loadCorrectionSignals("w1", "ui")).toEqual({ taskType: "ui", total: 0, editRate: 0, categories: [] });
    mockSafeQuery.mockRejectedValue(new Error("x"));
    expect((await loadCorrectionSignals("w1", "ui")).total).toBe(0);
  });
});
