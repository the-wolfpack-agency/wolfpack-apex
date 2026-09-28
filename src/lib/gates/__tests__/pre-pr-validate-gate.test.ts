/** The pre-pr-validate gate: dispatch -> wait -> pass/allow or fail/require_human. */
const mockClient = jest.fn();
const mockHead = jest.fn();
const mockTrigger = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  getBranchHead: (...a: unknown[]) => mockHead(...a),
  triggerWorkflow: (...a: unknown[]) => mockTrigger(...a),
}));
const mockOutcome = jest.fn();
jest.mock("@/lib/ai-code/pre-pr-validation", () => ({ readValidationOutcome: (...a: unknown[]) => mockOutcome(...a) }));

import { prePrValidateGate } from "@/lib/gates/pre-pr-validate-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const input = { repo: "o/r", branch: "factory-validate/x" };

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockHead.mockResolvedValue("sha");
  mockTrigger.mockResolvedValue({ run_id: null });
  process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
});
afterEach(() => { delete process.env.PREPR_VALIDATE_WORKFLOW; });

it("require_human + dispatches when validation is not yet dispatched", async () => {
  mockOutcome.mockResolvedValue({ status: "not_dispatched", failing: [] });
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(mockTrigger).toHaveBeenCalledWith(expect.anything(), "o/r", "factory-validate.yml", "factory-validate/x");
});
it("allow when the authored tests PASS in isolation", async () => {
  mockOutcome.mockResolvedValue({ status: "pass", failing: [] });
  expect((await runGate(prePrValidateGate, input, ctx)).verdict).toBe("allow");
});
it("require_human (self-inconsistent) when the authored tests FAIL - no looping PR", async () => {
  mockOutcome.mockResolvedValue({ status: "fail", failing: ["factory-validate"] });
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/self-inconsistent/i);
});
it("require_human when not configured (no workflow env)", async () => {
  delete process.env.PREPR_VALIDATE_WORKFLOW;
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/not configured/i);
});
