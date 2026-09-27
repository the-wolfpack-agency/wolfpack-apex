/**
 * CI read falls back to the Actions API when the token cannot read the Checks
 * API. The shared factory token has Actions but "Checks" is not even a grantable
 * permission on it (confirmed by dogfooding), so check-runs 403s; we then read
 * GitHub Actions workflow runs, which the Actions permission allows.
 */
const mockClient = jest.fn();
const mockListCheckRuns = jest.fn();
const mockListWorkflowRunChecks = jest.fn();

jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  listCheckRuns: (...a: unknown[]) => mockListCheckRuns(...a),
  listWorkflowRunChecks: (...a: unknown[]) => mockListWorkflowRunChecks(...a),
}));

import { fetchCiStatus } from "@/lib/ai-code/ci-status";

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
});

test("falls back to Actions workflow runs when check-runs is forbidden", async () => {
  mockListCheckRuns.mockRejectedValue(new Error("github GET /commits/x/check-runs → 403: Resource not accessible"));
  mockListWorkflowRunChecks.mockResolvedValue([
    { name: "unit-tests", status: "completed", conclusion: "failure" },
    { name: "e2e", status: "completed", conclusion: "success" },
  ]);
  const ci = await fetchCiStatus("o/r", "factory/x-abc", "w1");
  expect(mockListWorkflowRunChecks).toHaveBeenCalledWith(expect.anything(), "o/r", "factory/x-abc");
  expect(ci.readable).toBe(true);
  expect(ci.total).toBe(2);
  expect(ci.failed).toBe(1);
  expect(ci.failedChecks).toEqual(["unit-tests"]);
});

test("uses check-runs directly when the token CAN read them (no fallback)", async () => {
  mockListCheckRuns.mockResolvedValue([{ name: "unit-tests", status: "completed", conclusion: "success" }]);
  const ci = await fetchCiStatus("o/r", "factory/x-abc", "w1");
  expect(mockListWorkflowRunChecks).not.toHaveBeenCalled();
  expect(ci.readable).toBe(true);
  expect(ci.total).toBe(1);
  expect(ci.failed).toBe(0);
});

test("both reads failing -> unreadable with the RAW reason (not a guess)", async () => {
  mockListCheckRuns.mockRejectedValue(new Error("403 checks forbidden"));
  mockListWorkflowRunChecks.mockRejectedValue(new Error("403 actions forbidden"));
  const ci = await fetchCiStatus("o/r", "factory/x-abc", "w1");
  expect(ci.readable).toBe(false);
  expect(ci.unreadableReason).toMatch(/cannot read CI/i);
  expect(ci.unreadableReason).toMatch(/403 checks forbidden/); // the real error, surfaced
});

test("no token -> unreadable, never a silent zero", async () => {
  mockClient.mockResolvedValue({ token: "", fetch: jest.fn() });
  const ci = await fetchCiStatus("o/r", "main", "w1");
  expect(ci.readable).toBe(false);
  expect(ci.unreadableReason).toMatch(/no GitHub credential/i);
});
