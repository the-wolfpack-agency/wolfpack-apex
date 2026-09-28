/**
 * @jest-environment node
 *
 * Contract for POST /api/github-app/webhook (the Secure Agent PR-gate).
 * Asserts: invalid signature -> 401; a non-pull_request event and a non-code PR
 * action are acknowledged (200) without gating; an unknown installation and an
 * unentitled tenant are acknowledged without a GitHub call; a code PR from an
 * entitled tenant fetches the diff, gates it, posts the Check, and (on a block)
 * comments + records the outcome. Never 500s a delivery. Real HMAC signature so
 * the verifier is exercised end to end; GitHub + gate + ledger are mocked.
 */
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

const SECRET = "hook-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

const mockGetWorkspace = jest.fn();
const mockResolveEntitlement = jest.fn();
const mockClient = jest.fn();
const mockFetchDiff = jest.fn();
const mockCreateCheck = jest.fn();
const mockCreateComment = jest.fn();
const mockGate = jest.fn();
const mockAuthorize = jest.fn();
const mockRecordOutcome = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/github-app/storage", () => ({ getWorkspaceByInstallation: (...a: unknown[]) => mockGetWorkspace(...a) }));
jest.mock("@/lib/tenancy/entitlements", () => ({ resolveEntitlement: (...a: unknown[]) => mockResolveEntitlement(...a) }));
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  fetchPullRequestDiff: (...a: unknown[]) => mockFetchDiff(...a),
  createCheckRun: (...a: unknown[]) => mockCreateCheck(...a),
  createPrComment: (...a: unknown[]) => mockCreateComment(...a),
}));
jest.mock("@/lib/ai-code/pr-gate", () => ({
  PR_GATE_CHECK_NAME: "Secure Agent / gate",
  gatePullRequestDiff: (...a: unknown[]) => mockGate(...a),
}));
jest.mock("@/lib/ogiam/authorize", () => ({ authorize: (...a: unknown[]) => mockAuthorize(...a) }));
jest.mock("@/lib/ogiam/ledger", () => ({ recordActionOutcome: (...a: unknown[]) => mockRecordOutcome(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), extractRequestMetadata: () => ({ ipAddress: "0.0.0.0", userAgent: "test", requestId: "r1" }) }));

import { POST } from "../route";

const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

function post(payload: unknown, event = "pull_request", signWith?: string): NextRequest {
  const body = JSON.stringify(payload);
  return new NextRequest("http://localhost/api/github-app/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signWith ?? sign(body),
    },
    body,
  });
}

const prPayload = (over: Record<string, unknown> = {}) => ({
  action: "opened",
  installation: { id: 77 },
  repository: { full_name: "acme/app" },
  pull_request: { number: 5, head: { sha: "abc123" }, user: { login: "copilot-swe-agent" } },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWorkspace.mockResolvedValue({ workspaceId: "w1", installationId: "77", linkedBy: "u1", accountLogin: "acme", linkedAt: "" });
  mockResolveEntitlement.mockResolvedValue(true);
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockFetchDiff.mockResolvedValue("diff --git a/x b/x\n@@ -0,0 +1 @@\n+ok");
  mockGate.mockResolvedValue({ assessment: { blockedBy: null }, conclusion: "success", title: "Passed", summary: "s" });
  mockCreateCheck.mockResolvedValue({ id: 1 });
  mockCreateComment.mockResolvedValue(undefined);
  mockAuthorize.mockResolvedValue({ recordedSeq: 10, enforced: false, effectiveOutcome: "allow" });
  mockRecordOutcome.mockResolvedValue(undefined);
});

it("rejects an invalid signature with 401", async () => {
  const res = await POST(post(prPayload(), "pull_request", "sha256=bad"));
  expect(res.status).toBe(401);
  expect(mockGate).not.toHaveBeenCalled();
});

it("acknowledges a non-pull_request event without gating", async () => {
  const res = await POST(post({ zen: "hi" }, "ping"));
  expect(res.status).toBe(200);
  expect((await res.json()).ignored).toBe("ping");
  expect(mockFetchDiff).not.toHaveBeenCalled();
});

it("acknowledges a non-code PR action (e.g. labeled) without gating", async () => {
  const res = await POST(post(prPayload({ action: "labeled" })));
  expect(res.status).toBe(200);
  expect((await res.json()).ignored).toBe("pull_request.labeled");
  expect(mockFetchDiff).not.toHaveBeenCalled();
});

it("acknowledges an unknown installation without a GitHub call", async () => {
  mockGetWorkspace.mockResolvedValue(null);
  const res = await POST(post(prPayload()));
  expect(res.status).toBe(200);
  expect((await res.json()).ignored).toBe("unknown_installation");
  expect(mockClient).not.toHaveBeenCalled();
});

it("acknowledges an unentitled tenant without gating", async () => {
  mockResolveEntitlement.mockResolvedValue(false);
  const res = await POST(post(prPayload()));
  expect(res.status).toBe(200);
  expect((await res.json()).ignored).toBe("not_entitled");
  expect(mockFetchDiff).not.toHaveBeenCalled();
});

it("gates a code PR: posts a success check, tracks the event, records the outcome", async () => {
  const res = await POST(post(prPayload()));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.conclusion).toBe("success");
  expect(mockCreateCheck).toHaveBeenCalledWith(expect.anything(), "acme/app", expect.objectContaining({ headSha: "abc123", conclusion: "success", name: "Secure Agent / gate" }));
  expect(mockCreateComment).not.toHaveBeenCalled(); // no comment on a pass
  expect(mockTrack).toHaveBeenCalledWith("ai_code.pr_gated", "u1", "system", expect.objectContaining({ repo: "acme/app", conclusion: "success", author_login: "copilot-swe-agent" }));
  expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ ok: true, code: "pr_pass", decisionSeq: 10 }));
});

it("on a block: posts action_required + a visible comment + records a block outcome", async () => {
  mockGate.mockResolvedValue({ assessment: { blockedBy: "deep-scan" }, conclusion: "action_required", title: "Blocked", summary: "secret" });
  const res = await POST(post(prPayload()));
  expect(res.status).toBe(200);
  expect(mockCreateCheck).toHaveBeenCalledWith(expect.anything(), "acme/app", expect.objectContaining({ conclusion: "action_required" }));
  expect(mockCreateComment).toHaveBeenCalledWith(expect.anything(), "acme/app", 5, expect.stringContaining("blocked"));
  expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "pr_block" }));
});

it("never 500s when the GitHub call throws", async () => {
  mockFetchDiff.mockRejectedValue(new Error("boom"));
  const res = await POST(post(prPayload()));
  expect(res.status).toBe(200);
  expect((await res.json()).error).toBe("gate_error");
  expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ code: "gate_error" }));
});

describe("self-host (our own repo) graduated rollout", () => {
  const ourPr = () => prPayload({ repository: { full_name: "the-wolfpack-agency/wolfpack-apex" } });
  const orig = process.env.SELFHOST_GATE_MODE;
  afterEach(() => { if (orig === undefined) delete process.env.SELFHOST_GATE_MODE; else process.env.SELFHOST_GATE_MODE = orig; });

  it("off (default): our own PR is skipped entirely - no check posted", async () => {
    delete process.env.SELFHOST_GATE_MODE;
    const res = await POST(post(ourPr()));
    expect((await res.json()).ignored).toBe("selfhost_off");
    expect(mockCreateCheck).not.toHaveBeenCalled();
  });

  it("comment: posts a NEUTRAL (non-blocking) check + a comment, even on a would-be block", async () => {
    process.env.SELFHOST_GATE_MODE = "comment";
    mockGate.mockResolvedValue({ assessment: { blockedBy: "security" }, conclusion: "action_required", title: "Blocked", summary: "secret" });
    await POST(post(ourPr()));
    expect(mockCreateCheck).toHaveBeenCalledWith(expect.anything(), "the-wolfpack-agency/wolfpack-apex", expect.objectContaining({ conclusion: "neutral" })); // never blocks
    expect(mockCreateComment).toHaveBeenCalled(); // the observe comment is always posted
  });

  it("enforce: our own PR gates for real (action_required on a block, like a client repo)", async () => {
    process.env.SELFHOST_GATE_MODE = "enforce";
    mockGate.mockResolvedValue({ assessment: { blockedBy: "security" }, conclusion: "action_required", title: "Blocked", summary: "secret" });
    await POST(post(ourPr()));
    expect(mockCreateCheck).toHaveBeenCalledWith(expect.anything(), "the-wolfpack-agency/wolfpack-apex", expect.objectContaining({ conclusion: "action_required" }));
  });

  it("a CLIENT repo is unaffected by the self-host flag (always enforces)", async () => {
    process.env.SELFHOST_GATE_MODE = "off";
    await POST(post(prPayload())); // acme/app
    expect(mockCreateCheck).toHaveBeenCalledWith(expect.anything(), "acme/app", expect.objectContaining({ conclusion: "success" }));
  });
});

