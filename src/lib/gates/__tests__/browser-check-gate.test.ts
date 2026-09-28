/** The browser-check gate: dispatch -> wait -> pass/allow or fail/require_human. */
const mockClient = jest.fn();
const mockHead = jest.fn();
const mockTrigger = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  getBranchHead: (...a: unknown[]) => mockHead(...a),
  triggerWorkflow: (...a: unknown[]) => mockTrigger(...a),
}));
const mockOutcome = jest.fn();
jest.mock("@/lib/ai-code/workflow-outcome", () => ({ readWorkflowOutcome: (...a: unknown[]) => mockOutcome(...a) }));

import { browserCheckGate } from "@/lib/gates/browser-check-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const input = { repo: "o/r", branch: "factory/x", previewUrl: "https://preview" };

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockHead.mockResolvedValue("sha");
  mockTrigger.mockResolvedValue({ run_id: null });
  process.env.BROWSER_CHECK_WORKFLOW = "factory-browser-check.yml";
});
afterEach(() => { delete process.env.BROWSER_CHECK_WORKFLOW; });

it("dispatches with the preview URL when not yet run", async () => {
  mockOutcome.mockResolvedValue({ status: "not_dispatched", failing: [] });
  const r = await runGate(browserCheckGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(mockTrigger).toHaveBeenCalledWith(expect.anything(), "o/r", "factory-browser-check.yml", "factory/x", { url: "https://preview" });
});
it("allow when e2e + a11y pass", async () => {
  mockOutcome.mockResolvedValue({ status: "pass", failing: [] });
  expect((await runGate(browserCheckGate, input, ctx)).verdict).toBe("allow");
});
it("require_human when a browser check fails (broken journey / a11y)", async () => {
  mockOutcome.mockResolvedValue({ status: "fail", failing: ["factory-browser-check"] });
  const r = await runGate(browserCheckGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/broken journey|accessibility/i);
});
it("require_human when not configured", async () => {
  delete process.env.BROWSER_CHECK_WORKFLOW;
  expect((await runGate(browserCheckGate, input, ctx)).verdict).toBe("require_human");
});
