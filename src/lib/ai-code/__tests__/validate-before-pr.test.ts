/** @jest-environment node
 *
 * Tier-2 pre-PR validation wiring (validateBeforePr): it must be a no-op "allow"
 * when PREPR_VALIDATE_WORKFLOW is unset (zero regression to the existing flow),
 * push a validation branch + run the repo's own gate when enabled, and map the
 * gate verdict to allow / require_human correctly - never throwing.
 */
const workspaceGithubClient = jest.fn();
const pushValidationBranch = jest.fn();
const runGate = jest.fn();

jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => workspaceGithubClient(...a),
  openPullRequest: jest.fn(),
}));
jest.mock("../pre-pr-validation", () => ({
  pushValidationBranch: (...a: unknown[]) => pushValidationBranch(...a),
}));
jest.mock("@/lib/gates/run-gate", () => ({ runGate: (...a: unknown[]) => runGate(...a) }));

import { validateBeforePr } from "../open-pr-executor";

const ctx = { userId: "u1", userRole: "admin", workspaceId: "w1" };
const params = { repo: "the-wolfpack-agency/wolfpack-apex", ref: "t", changes: [{ path: "src/x.ts", content: "export const x=1;" }] };

beforeEach(() => {
  jest.clearAllMocks();
  workspaceGithubClient.mockResolvedValue({ token: "ghp_test" });
  pushValidationBranch.mockResolvedValue("factory-validate/t-abc12345");
});
afterEach(() => { delete process.env.PREPR_VALIDATE_WORKFLOW; });

describe("validateBeforePr", () => {
  it("is a no-op allow when PREPR_VALIDATE_WORKFLOW is unset (zero regression)", async () => {
    delete process.env.PREPR_VALIDATE_WORKFLOW;
    const r = await validateBeforePr(params as never, ctx);
    expect(r.verdict).toBe("allow");
    expect(r.status).toBe("not_enforced");
    expect(pushValidationBranch).not.toHaveBeenCalled();
    expect(runGate).not.toHaveBeenCalled();
  });

  it("allows the PR when the repo's own gate PASSES", async () => {
    process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
    runGate.mockResolvedValue({ verdict: "allow", reason: "tests pass", output: { status: "pass", failing: [] } });
    const r = await validateBeforePr(params as never, ctx);
    expect(pushValidationBranch).toHaveBeenCalled();
    expect(r.verdict).toBe("allow");
    expect(r.status).toBe("pass");
    expect(r.branch).toBe("factory-validate/t-abc12345");
  });

  it("holds for a human when the change's own tests FAIL", async () => {
    process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
    runGate.mockResolvedValue({ verdict: "require_human", reason: "authored tests fail", output: { status: "fail", failing: ["verify"] } });
    const r = await validateBeforePr(params as never, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.status).toBe("fail");
    expect(r.failing).toEqual(["verify"]);
  });

  it("holds while validation is still running (not green yet)", async () => {
    process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
    runGate.mockResolvedValue({ verdict: "require_human", reason: "still running", output: { status: "pending", failing: [] } });
    const r = await validateBeforePr(params as never, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.status).toBe("pending");
  });

  it("requires a human (never throws) when no GitHub token is configured", async () => {
    process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
    workspaceGithubClient.mockResolvedValue({ token: null });
    const r = await validateBeforePr(params as never, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.status).toBe("no_token");
    expect(pushValidationBranch).not.toHaveBeenCalled();
  });
});
