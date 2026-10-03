/** @jest-environment node
 *
 * Contract tests for the GOVERNANCE-critical approve path with tier-2 pre-PR
 * validation wired in:
 *   - env UNSET  -> flow unchanged: claim (decidePendingApproval) then execute.
 *   - env SET + validation NOT green -> 202, and the approval is LEFT PENDING
 *     (decidePendingApproval + markApprovalExecuted are NEVER called), so the
 *     double-execute guard still runs only on the open-PR path.
 *   - env SET + validation green -> claim + execute as normal.
 */
export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: any[]) => mockRequireCap(...a) }));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue(undefined),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

const safeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => safeQuery(...a) }));

const getPendingApproval = jest.fn();
const decidePendingApproval = jest.fn();
const markApprovalExecuted = jest.fn();
jest.mock("@/lib/agents/approvals/store", () => ({
  getPendingApproval: (...a: any[]) => getPendingApproval(...a),
  decidePendingApproval: (...a: any[]) => decidePendingApproval(...a),
  markApprovalExecuted: (...a: any[]) => markApprovalExecuted(...a),
}));

const getAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({ getAgent: (...a: any[]) => getAgent(...a) }));

jest.mock("@/lib/assistant/tools/create-external-record-tool", () => ({ executeCreateExternalRecord: jest.fn() }));
jest.mock("@/lib/assistant/tools/update-external-record-tool", () => ({ executeUpdateExternalRecord: jest.fn() }));

const executeOpenPr = jest.fn();
const validateBeforePr = jest.fn();
jest.mock("@/lib/ai-code/open-pr-executor", () => ({
  executeOpenPr: (...a: any[]) => executeOpenPr(...a),
  validateBeforePr: (...a: any[]) => validateBeforePr(...a),
}));

import { POST } from "../route";

const CTO = { ok: true, user: { id: "u_cto", role: "cto", workspaceId: "default" } };
const APPROVAL = { status: "pending", tool: "ai_code.open_pr", agentId: "a1", ownerUserId: "u_owner", params: { repo: "the-wolfpack-agency/wolfpack-apex", ref: "t", changes: [{ path: "src/x.ts", content: "x" }] } };

function mkReq(action = "approve"): any {
  return { json: async () => ({ action }), headers: new Headers(), url: "http://x/api/admin/agents/approvals/ap_1" };
}
const route = (id = "ap_1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PREPR_VALIDATE_WORKFLOW;
  mockRequireCap.mockResolvedValue(CTO);
  getPendingApproval.mockResolvedValue({ ...APPROVAL });
  getAgent.mockResolvedValue({ id: "a1", state: "active", workspaceId: "default" });
  safeQuery.mockResolvedValue({ rows: [{ role: "admin", workspace_id: "default" }] });
  decidePendingApproval.mockResolvedValue({ ...APPROVAL, status: "approved" });
  markApprovalExecuted.mockResolvedValue(undefined);
  executeOpenPr.mockResolvedValue({ ok: true, url: "https://github.com/x/y/pull/1", number: 1, branch: "b", files: 1 });
  validateBeforePr.mockResolvedValue({ verdict: "allow", status: "pass", failing: [], branch: "vb" });
});

describe("POST approvals/[id] - pre-PR validation", () => {
  it("env UNSET: claims + executes unchanged (validation never runs)", async () => {
    const res = await POST(mkReq(), route());
    expect(res.status).toBe(200);
    expect(validateBeforePr).not.toHaveBeenCalled();
    expect(decidePendingApproval).toHaveBeenCalledWith("ap_1", "default", "u_cto", "approved");
    expect(executeOpenPr).toHaveBeenCalled();
  });

  it("env SET + validation NOT green: 202 and the approval is LEFT PENDING", async () => {
    process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
    validateBeforePr.mockResolvedValue({ verdict: "require_human", status: "pending", failing: [], branch: "vb", reason: "still validating" });
    const res = await POST(mkReq(), route());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("validating");
    // The guard: the approval must NOT be consumed, so a retry still works.
    expect(decidePendingApproval).not.toHaveBeenCalled();
    expect(markApprovalExecuted).not.toHaveBeenCalled();
    expect(executeOpenPr).not.toHaveBeenCalled();
  });

  it("env SET + validation green: claims + executes", async () => {
    process.env.PREPR_VALIDATE_WORKFLOW = "factory-validate.yml";
    const res = await POST(mkReq(), route());
    expect(res.status).toBe(200);
    expect(validateBeforePr).toHaveBeenCalled();
    expect(decidePendingApproval).toHaveBeenCalled();
    expect(executeOpenPr).toHaveBeenCalled();
  });

  it("reject still records + mutates nothing", async () => {
    decidePendingApproval.mockResolvedValue({ ...APPROVAL, status: "rejected" });
    const res = await POST(mkReq("reject"), route());
    expect(res.status).toBe(200);
    expect(validateBeforePr).not.toHaveBeenCalled();
    expect(executeOpenPr).not.toHaveBeenCalled();
  });
});
