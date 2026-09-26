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
const mockGate = jest.fn();
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }) }));

import { POST } from "../route";

const AUTHORED_DIFF = "diff --git a/src/k.ts b/src/k.ts\n--- /dev/null\n+++ b/src/k.ts\n@@ -0,0 +1 @@\n+export const k = 1;";
const authorResp = (content: string) => ({ content, model_used: "azure-gpt-4o", provider_used: "azure-openai", input_tokens: 1, output_tokens: 1, cost_usd: 0.0001, latency_ms: 100 });

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
  mockGate.mockResolvedValue(null); // secure_agent entitled by default
  mockRunPipeline.mockResolvedValue(RUN);
  mockRecordAudit.mockResolvedValue({ ok: true });
  mockCreateApproval.mockResolvedValue("appr-1");
  mockComplete.mockResolvedValue(authorResp("```diff\n" + AUTHORED_DIFF + "\n```"));
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

  it("400 when ref or prompt is missing", async () => {
    expect((await POST(post({ ...VALID, ref: "" }))).status).toBe(400);
    expect((await POST(post({ ...VALID, prompt: "" }))).status).toBe(400);
  });

  it("authors the diff from the prompt when none is supplied (executor stage)", async () => {
    const res = await POST(post({ ref: "pr-2", prompt: "add k", answers: { tests: "all" }, executorProviderPin: "azure-openai" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executor.author).toBe("azure-gpt-4o");
    expect(body.executor.provider).toBe("azure-openai");
    // runPipeline governs the AUTHORED diff, attributed to the executor model so
    // the repairer is guaranteed a different lineage.
    const call = mockRunPipeline.mock.calls[0][0];
    expect(call.diff).toContain("export const k");
    expect(call.author).toBe("azure-gpt-4o");
  });

  it("422 (fail-closed) when the executor produces no diff - never a fabricated one", async () => {
    mockComplete.mockResolvedValue(authorResp("I would add a function called k."));
    const res = await POST(post({ ref: "pr-3", prompt: "add k", answers: { tests: "all" } }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/no diff/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
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
    const body = await res.json();
    expect(body.run).toEqual(RUN);
    expect(body.approvalId).toBe("appr-1"); // clean diff (no added deps) -> handed off
    expect(body.executor).toBeNull();
    expect(body.invariants.wouldBlock).toBe(false);
    const args = mockRunPipeline.mock.calls[0][0];
    expect(args.author).toBe("claude-3-5-sonnet");
    expect(args.prompt).toBe("Add a value");
    expect(args.answers).toEqual({ tests: "all" });
  });

  it("withholds PR handoff when an invariant blocks, even if the security gate allowed", async () => {
    // Security gate allows (ready_for_pr), but the diff adds a runtime dependency,
    // which the OGIAM registry escalates -> no approval is captured.
    const DEP_DIFF = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,6 +5,7 @@",
      '   "dependencies": {',
      '+    "left-pad": "^1.3.0",',
      '     "react": "19.0.0"',
      "   },",
    ].join("\n");
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: DEP_DIFF });
    const res = await POST(post(VALID));
    const body = await res.json();
    expect(body.invariants.ruleId).toBe("R-DEPENDENCY-ADDED-ESCALATE");
    expect(body.invariants.wouldBlock).toBe(true);
    expect(body.approvalId).toBeNull(); // NOT handed off
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(body.changeFacts.dependencyDelta).toBe(1);
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

describe("entitlement gate", () => {
  it("403 when the secure_agent product is not entitled for the workspace", async () => {
    mockGate.mockResolvedValue(new Response(JSON.stringify({ entitled: false, feature: "secure_agent" }), { status: 403 }));
    expect((await POST(post(VALID))).status).toBe(403);
    expect(mockRunPipeline).not.toHaveBeenCalled(); // gated before the pipeline runs
  });
});
