const mockRuns = jest.fn();
jest.mock("@/lib/github-client", () => ({ listWorkflowRunsRaw: (...a: unknown[]) => mockRuns(...a) }));
import { readWorkflowOutcome } from "@/lib/ai-code/workflow-outcome";
const run = (name: string, conclusion: string | null) => ({ id: 1, name, conclusion, runAttempt: 1 });
beforeEach(() => jest.clearAllMocks());
it.each([
  ["not_dispatched", [run("ci", "failure")]],
  ["pending", [run("factory-browser-check", null)]],
  ["pass", [run("factory-browser-check", "success")]],
  ["fail", [run("factory-browser-check", "failure")]],
])("status %s", async (expected, runs) => {
  mockRuns.mockResolvedValue(runs);
  expect((await readWorkflowOutcome({} as never, "o/r", "sha", "factory-browser-check")).status).toBe(expected);
});
it("unknown on a read error", async () => {
  mockRuns.mockRejectedValue(new Error("x"));
  expect((await readWorkflowOutcome({} as never, "o/r", "sha", "w")).status).toBe("unknown");
});
