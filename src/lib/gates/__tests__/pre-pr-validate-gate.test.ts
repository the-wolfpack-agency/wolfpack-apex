/** The pre-pr-validate gate with BASELINE ATTRIBUTION:
 *   dispatch -> wait -> pass => allow; fail => attribute against the base branch
 *   and HOLD only on failures the change INTRODUCED (a pre-existing red baseline
 *   never blocks a clean change; fail-closed on anything unattributable). */
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
const mockAttr = jest.fn();
const mockEstablish = jest.fn();
jest.mock("@/lib/ai-code/ci-status", () => ({
  fetchCiAttribution: (...a: unknown[]) => mockAttr(...a),
  establishBaseline: (...a: unknown[]) => mockEstablish(...a),
}));

import { prePrValidateGate } from "@/lib/gates/pre-pr-validate-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const input = { repo: "o/r", branch: "factory-validate/x", base: "main" };

const attribution = (over: Record<string, unknown> = {}) => ({
  introduced: [], preexisting: [], indeterminate: [], fixed: [],
  baselineKnown: true, baselineHealthy: false, clean: true, reason: "attributed", ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockHead.mockResolvedValue("sha");
  mockTrigger.mockResolvedValue({ run_id: null });
  mockEstablish.mockResolvedValue({ dispatched: true, runId: null, workflowFile: "factory-validate.yml" });
  process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
});
afterEach(() => { delete process.env.PREPR_VALIDATE_WORKFLOW; });

it("require_human + dispatches when branch validation is not yet dispatched", async () => {
  mockOutcome.mockResolvedValue({ status: "not_dispatched", failing: [] });
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(mockTrigger).toHaveBeenCalledWith(expect.anything(), "o/r", "factory-validate.yml", "factory-validate/x");
});

it("allow when the branch gate PASSES", async () => {
  mockOutcome.mockResolvedValue({ status: "pass", failing: [] });
  expect((await runGate(prePrValidateGate, input, ctx)).verdict).toBe("allow");
  expect(mockAttr).not.toHaveBeenCalled(); // a clean pass needs no attribution
});

it("branch FAIL + base baseline not yet dispatched -> establishes it + require_human", async () => {
  mockOutcome
    .mockResolvedValueOnce({ status: "fail", failing: ["factory-validate"] }) // branch
    .mockResolvedValueOnce({ status: "not_dispatched", failing: [] });         // base
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(mockEstablish).toHaveBeenCalledWith("o/r", "main", expect.objectContaining({ workflowFile: "factory-validate.yml" }));
  expect(r.reason).toMatch(/baseline/i);
});

it("branch FAIL but the SAME failure is pre-existing on base -> ALLOW (not the change's fault)", async () => {
  mockOutcome
    .mockResolvedValueOnce({ status: "fail", failing: ["factory-validate"] }) // branch
    .mockResolvedValueOnce({ status: "fail", failing: ["factory-validate"] }); // base settled
  mockAttr.mockResolvedValue(attribution({ preexisting: ["factory-validate"], clean: true }));
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.reason).toMatch(/already red|no new failures/i);
});

it("branch FAIL with a NEW failure the change introduced -> require_human", async () => {
  mockOutcome
    .mockResolvedValueOnce({ status: "fail", failing: ["factory-validate"] }) // branch
    .mockResolvedValueOnce({ status: "pass", failing: [] });                   // base settled (green)
  mockAttr.mockResolvedValue(attribution({ introduced: ["factory-validate"], clean: false }));
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/introduced/i);
});

it("fail-closed: a branch failure with no baseline to attribute -> require_human", async () => {
  mockOutcome
    .mockResolvedValueOnce({ status: "fail", failing: ["x"] }) // branch
    .mockResolvedValueOnce({ status: "pass", failing: [] });   // base settled
  mockAttr.mockResolvedValue(attribution({ indeterminate: ["x"], clean: true, baselineKnown: false }));
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
});

it("require_human when not configured (no workflow env)", async () => {
  delete process.env.PREPR_VALIDATE_WORKFLOW;
  const r = await runGate(prePrValidateGate, input, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/not configured/i);
});
