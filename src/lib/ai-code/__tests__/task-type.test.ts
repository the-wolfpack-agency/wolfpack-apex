/**
 * Task-type classifier (pure, first-match-wins) + the per-(model,task-type) grade
 * read-model over a mocked db.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { classifyTaskType, summarizeTaskTypeGrades, loadTaskTypeGrades } from "@/lib/ai-code/task-type";

beforeEach(() => jest.clearAllMocks());

describe("classifyTaskType", () => {
  it("classifies the common kinds", () => {
    expect(classifyTaskType("Create a migration that adds a quotas table")).toBe("migration");
    expect(classifyTaskType("Write a Playwright e2e for the login flow")).toBe("test");
    expect(classifyTaskType("Add a StatusPill React component")).toBe("ui");
    expect(classifyTaskType("Add an API route handler for /ping")).toBe("api");
    expect(classifyTaskType("Refactor and dedupe the cost helpers")).toBe("refactor");
    expect(classifyTaskType("Update the README and release notes")).toBe("docs");
    expect(classifyTaskType("Do the thing with the stuff")).toBe("other");
  });
  it("is first-match-wins (migration before a generic word)", () => {
    expect(classifyTaskType("add a migration AND a component")).toBe("migration");
  });
});

describe("summarizeTaskTypeGrades", () => {
  it("computes ready-rate per (model, task-type), most runs first", () => {
    const g = summarizeTaskTypeGrades([
      { model: "gpt-a", task_type: "migration", runs: 10, ready: 8 },
      { model: "gpt-b", task_type: "ui", runs: 4, ready: 1 },
    ], 30);
    expect(g.byModelTask[0]).toMatchObject({ model: "gpt-a", taskType: "migration", runs: 10 });
    expect(g.byModelTask[0].readyRate).toBeCloseTo(0.8, 5);
    expect(g.byModelTask[1].readyRate).toBeCloseTo(0.25, 5);
  });
  it("drops zero-run groups", () => {
    expect(summarizeTaskTypeGrades([{ model: "x", task_type: "api", runs: 0, ready: 0 }], 30).byModelTask).toEqual([]);
  });
});

describe("loadTaskTypeGrades", () => {
  it("reads pipeline_run grouped by model+task_type, workspace-scoped", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ model: "gpt-a", task_type: "migration", runs: 3, ready: 2 }] });
    const g = await loadTaskTypeGrades("w1", 30);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["30", "w1"]);
    expect(g.byModelTask[0]).toMatchObject({ model: "gpt-a", taskType: "migration", runs: 3 });
    expect(g.byModelTask[0].readyRate).toBeCloseTo(2 / 3, 5);
  });
});
