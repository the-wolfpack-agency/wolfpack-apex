/**
 * @jest-environment node
 *
 * Contract for POST /api/admin/ai-code/remediate. The re-route loop itself is
 * proven in src/lib/ai-code/__tests__/repair.test.ts against the real gate; this
 * asserts the ROUTE: auth, body validation, that it delegates to remediateDiff,
 * and that a remediation is audited + emitted. remediateDiff is mocked here so
 * the contract does not depend on a live model.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockRemediate = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-code/repair", () => ({
  remediateDiff: (...a: unknown[]) => mockRemediate(...a),
  liveRepairComplete: () => async () => "",
}));
jest.mock("@/lib/ai-code/scan", () => ({ runCodeReview: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { POST } from "../route";

const OK_USER = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({
  ok: false,
  response: new Response(JSON.stringify({ error: "no" }), { status }),
});

const CLEAN_RESULT = {
  status: "clean",
  diff: "diff --git a/x b/x\n@@ -1 +1 @@\n+const a = process.env.A;",
  attempts: [{ n: 1, tier: "standard", outcomeBefore: "block", outcomeAfter: "allow", findingsBefore: 1, findingsAfter: 0, accepted: true }],
  review: { ref: "r", author: "a", findings: [], verdict: { outcome: "allow", highestSeverity: "none", reason: "", ruleId: "C-CLEAN-ALLOW" }, bySeverity: {} },
  repairerLineage: "openai",
  reason: "repaired to a passing diff in 1 attempt(s)",
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/ai-code/remediate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK_USER);
  mockRemediate.mockResolvedValue(CLEAN_RESULT);
  mockRecordAudit.mockResolvedValue({ ok: true });
});

const VALID = { ref: "pr-1", author: "claude", authorModel: "claude-3-5-sonnet", diff: "diff --git a/x b/x\n@@ -1 +1 @@\n+const k = \"secret12345\";" };

describe("POST /api/admin/ai-code/remediate", () => {
  it("401 without a session", async () => {
    mockRequireCapability.mockResolvedValue(deny(401));
    expect((await POST(post(VALID))).status).toBe(401);
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValue(deny(403));
    expect((await POST(post(VALID))).status).toBe(403);
  });

  it("400 when ref or diff is missing", async () => {
    expect((await POST(post({ diff: VALID.diff }))).status).toBe(400);
    expect((await POST(post({ ref: "pr-1" }))).status).toBe(400);
  });

  it("200: delegates to remediateDiff with the author MODEL for lineage independence", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: CLEAN_RESULT });

    const args = mockRemediate.mock.calls[0][0];
    expect(args.author).toBe("claude-3-5-sonnet"); // authorModel, not the display author
    expect(args.diff).toBe(VALID.diff);
    expect(typeof args.review).toBe("function");
    expect(typeof args.repair).toBe("function");
  });

  it("audits and emits the remediation for the learning loop", async () => {
    await POST(post(VALID));
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_code.remediated" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ai_code.remediated",
      "u1",
      "admin",
      expect.objectContaining({ ref: "pr-1", status: "clean", final_outcome: "allow" }),
    );
  });

  it("caps maxAttempts and floors it at 1", async () => {
    await POST(post({ ...VALID, maxAttempts: 99 }));
    expect(mockRemediate.mock.calls[0][0].maxAttempts).toBe(4);
    mockRemediate.mockClear();
    await POST(post({ ...VALID, maxAttempts: 0 }));
    expect(mockRemediate.mock.calls[0][0].maxAttempts).toBe(1);
  });

  it("returns needs_human verbatim (never auto-merges a still-failing diff)", async () => {
    mockRemediate.mockResolvedValue({ ...CLEAN_RESULT, status: "needs_human", review: { ...CLEAN_RESULT.review, verdict: { outcome: "block", highestSeverity: "critical", reason: "", ruleId: "C-CRITICAL-BLOCK" } } });
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect((await res.json()).result.status).toBe("needs_human");
  });
});
