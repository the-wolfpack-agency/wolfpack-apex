/**
 * @jest-environment node
 *
 * Contract for POST /api/admin/ai-code/pipeline. The chaining itself is proven
 * in src/lib/ai-code/__tests__/pipeline.test.ts against the real gate; this
 * asserts the ROUTE: auth, body validation, that an off-menu intake answer is a
 * 400 (not a 500), delegation, and that a run is audited + emitted. runPipeline
 * is mocked so the contract does not depend on a live model.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockRunPipeline = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();
const mockCreateApproval = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-code/pipeline", () => ({ runPipeline: (...a: unknown[]) => mockRunPipeline(...a) }));
jest.mock("@/lib/ai-code/repair", () => ({ liveRepairComplete: () => async () => "" }));
jest.mock("@/lib/ai-code/scan", () => ({ runCodeReview: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));
jest.mock("@/lib/agents/approvals/store", () => ({ createPendingApproval: (...a: unknown[]) => mockCreateApproval(...a) }));

import { POST } from "../route";

const OK_USER = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });

const RUN = {
  ref: "pr-1",
  spec: { prompt: "Add a value", answers: { tests: "all" }, createdAtIso: "2026-09-17T00:00:00.000Z", hash: "spec_abc123" },
  openQuestions: [],
  remediation: { status: "clean", diff: "d", attempts: [], review: {}, repairerLineage: null, reason: "ok" },
  review: { ref: "pr-1", author: "a", findings: [], verdict: { outcome: "allow", highestSeverity: "none", reason: "", ruleId: "C-CLEAN-ALLOW" }, bySeverity: {} },
  conformance: { specHash: "spec_abc123", conforms: true, findings: [] },
  status: "ready_for_pr",
  diff: "d",
  reason: "ok",
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/ai-code/pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { ref: "pr-1", prompt: "Add a value", author: "claude", authorModel: "claude-3-5-sonnet", diff: "diff --git a/x b/x\n@@ -1 +1 @@\n+const k = 1;", answers: { tests: "all" } };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK_USER);
  mockRunPipeline.mockResolvedValue(RUN);
  mockRecordAudit.mockResolvedValue({ ok: true });
  mockCreateApproval.mockResolvedValue("appr-1");
});

describe("POST /api/admin/ai-code/pipeline", () => {
  it("401 without a session", async () => {
    mockRequireCapability.mockResolvedValue(deny(401));
    expect((await POST(post(VALID))).status).toBe(401);
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValue(deny(403));
    expect((await POST(post(VALID))).status).toBe(403);
  });

  it("400 when ref, prompt or diff is missing", async () => {
    expect((await POST(post({ ...VALID, ref: "" }))).status).toBe(400);
    expect((await POST(post({ ...VALID, prompt: "" }))).status).toBe(400);
    expect((await POST(post({ ...VALID, diff: "" }))).status).toBe(400);
  });

  it("400 (not 500) on an off-menu intake answer", async () => {
    mockRunPipeline.mockRejectedValue(new Error('unknown option "eventually" for question "tests"'));
    const res = await POST(post({ ...VALID, answers: { tests: "eventually" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown option/i);
  });

  it("200: delegates with the author MODEL and returns the run", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: RUN, approvalId: "appr-1" });
    const args = mockRunPipeline.mock.calls[0][0];
    expect(args.author).toBe("claude-3-5-sonnet");
    expect(args.prompt).toBe("Add a value");
    expect(args.answers).toEqual({ tests: "all" });
  });

  it("audits and emits the run for the learning loop", async () => {
    await POST(post(VALID));
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_code.pipeline_run" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ai_code.pipeline_run",
      "u1",
      "admin",
      expect.objectContaining({ ref: "pr-1", spec_hash: "spec_abc123", status: "ready_for_pr", conforms: true }),
    );
  });

  it("clamps maxAttempts to the ceiling", async () => {
    await POST(post({ ...VALID, maxAttempts: 99 }));
    expect(mockRunPipeline.mock.calls[0][0].maxAttempts).toBe(4);
  });

  it("drops answer keys outside the fixed question set (no remote property injection)", async () => {
    await POST(post({ ...VALID, answers: { tests: "all", __proto__: "x", constructor: "y", bogus: "z" } }));
    // Only the allowlisted question id survives; injected / unknown names are gone.
    expect(mockRunPipeline.mock.calls[0][0].answers).toEqual({ tests: "all" });
  });

  it("a ready-for-PR run CAPTURES a pending approval - it does not open a PR", async () => {
    const res = await POST(post(VALID));
    expect(mockCreateApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ai-code-gate",
        ownerUserId: "u1",
        tool: "ai_code.open_pr",
        params: expect.objectContaining({ ref: "pr-1", spec_hash: "spec_abc123" }),
      }),
    );
    expect((await res.json()).approvalId).toBe("appr-1");
  });

  it("a needs_human run hands off NOTHING (no approval captured, no PR)", async () => {
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "needs_human" });
    const res = await POST(post(VALID));
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect((await res.json()).approvalId).toBeNull();
  });
});
