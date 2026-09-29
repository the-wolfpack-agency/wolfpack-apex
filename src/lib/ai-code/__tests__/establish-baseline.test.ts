/**
 * establishBaseline: when a repo's base branch has no measured CI, dispatch a
 * workflow on it so a baseline can be measured. Never throws - a dispatch failure
 * is reported, never silently swallowed.
 */
const mockClient = jest.fn();
const mockTrigger = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  triggerWorkflow: (...a: unknown[]) => mockTrigger(...a),
  listCheckRuns: jest.fn(),
  listWorkflowRunChecks: jest.fn(),
}));

import { establishBaseline } from "@/lib/ai-code/ci-status";

beforeEach(() => jest.clearAllMocks());

test("dispatches the factory validate workflow on the base ref by default", async () => {
  mockClient.mockResolvedValue({ token: "t" });
  mockTrigger.mockResolvedValue({ run_id: "99" });
  const r = await establishBaseline("o/r", "main", { workspaceId: "w" });
  expect(mockTrigger).toHaveBeenCalledWith({ token: "t" }, "o/r", "factory-validate.yml", "main");
  expect(r).toEqual({ dispatched: true, runId: "99", workflowFile: "factory-validate.yml" });
});

test("honors a caller-specified workflow file", async () => {
  mockClient.mockResolvedValue({ token: "t" });
  mockTrigger.mockResolvedValue({ run_id: "1" });
  await establishBaseline("o/r", "develop", { workflowFile: "ci.yml", workspaceId: "w" });
  expect(mockTrigger).toHaveBeenCalledWith({ token: "t" }, "o/r", "ci.yml", "develop");
});

test("no credential -> not dispatched, with a reason (never silently 'done')", async () => {
  mockClient.mockResolvedValue({ token: null });
  const r = await establishBaseline("o/r", "main", {});
  expect(r.dispatched).toBe(false);
  expect(r.reason).toMatch(/no GitHub credential/i);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test("a dispatch error is caught and surfaced, not thrown", async () => {
  mockClient.mockResolvedValue({ token: "t" });
  mockTrigger.mockRejectedValue(new Error("workflow_dispatch not enabled"));
  const r = await establishBaseline("o/r", "main", {});
  expect(r.dispatched).toBe(false);
  expect(r.reason).toMatch(/workflow_dispatch not enabled/i);
});
