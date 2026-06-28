/**
 * Contract for POST /api/admin/platform-scans/browser/authorize (gate-as-a-service).
 *
 * Dual auth (CI bearer CRON_SECRET OR settings.manage_team admin), body
 * validation, and the delegation into authorizeBrowserAction are exercised with
 * the gate + auth mocked, so no DB/network is touched. Mirrors the ingest route
 * test's mocking idiom.
 *
 * Key contract: an authorization QUERY. A deny is a 200 with { allowed: false,
 * reason }, NOT a 403. 403 is reserved for "you may not ask the gate". The runner
 * branches on `allowed`, never on the status code.
 */
const mockAuthorize = jest.fn();
const mockAuthFn = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => {
    mockAuthFn();
    return mockAuth();
  },
}));
jest.mock("@/lib/platform-scan/browser/gate", () => ({
  authorizeBrowserAction: (...a: unknown[]) => mockAuthorize(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/browser/authorize/route";

const READ_ONLY = {
  platform: "acme",
  action: { kind: "observe", targetUrl: "https://acme.test/dash" },
};
const MUTATING = {
  platform: "acme",
  action: { kind: "submit", targetUrl: "https://acme.test/form", selector: "#go" },
};

const ALLOW_VERDICT = {
  allowed: true,
  decision: {
    ruleId: "rule-1",
    effectiveOutcome: "allow",
    mode: "monitor",
    policyVersion: "v1",
    intendedOutcome: "allow",
    enforced: false,
    riskTier: "low",
    reason: "ok",
    wouldBlock: false,
  },
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/browser/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockAuthorize.mockResolvedValue(ALLOW_VERDICT);
});

it("200 { allowed: true } for an allowed read-only action; echoes a non-secret decision summary", async () => {
  const res = await post(READ_ONLY);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    allowed: true,
    decision: {
      ruleId: "rule-1",
      effectiveOutcome: "allow",
      mode: "monitor",
      policyVersion: "v1",
    },
  });
  // Delegated to the gate with the admin actor + platform folded into the action.
  expect(mockAuthorize).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    action: {
      kind: "observe",
      targetUrl: "https://acme.test/dash",
      platform: "acme",
      selector: undefined,
      mutating: undefined,
    },
    actor: { userId: "admin-1", role: "admin" },
  });
});

it("does NOT echo secret-ish decision fields (no params/host/principal)", async () => {
  const res = await post(READ_ONLY);
  const json = await res.json();
  expect(json.decision).not.toHaveProperty("params");
  expect(json.decision).not.toHaveProperty("reason");
  expect(json.decision).not.toHaveProperty("recordedSeq");
});

it("200 { allowed: false, reason } for a blocked mutating action (a deny is NOT a 403)", async () => {
  mockAuthorize.mockResolvedValue({ allowed: false, reason: "no_active_scope" });
  const res = await post(MUTATING);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ allowed: false, reason: "no_active_scope" });
});

it("200 via bearer CRON_SECRET (agent path): runs as the browser-agent in default ws, no capability check", async () => {
  const res = await post(READ_ONLY, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(mockAuthFn).not.toHaveBeenCalled();
  expect(mockAuthorize).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "default",
      actor: { userId: "browser-agent", role: "agent" },
    }),
  );
});

it("forwards an explicit mutating override to the gate", async () => {
  await post({ platform: "acme", action: { kind: "navigate", targetUrl: "https://acme.test", mutating: true } });
  expect(mockAuthorize).toHaveBeenCalledWith(
    expect.objectContaining({
      action: expect.objectContaining({ kind: "navigate", mutating: true }),
    }),
  );
});

it("401/403s when neither auth path succeeds (gate never consulted)", async () => {
  process.env.CRON_SECRET = ""; // cron disabled
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
  const res = await post(READ_ONLY);
  expect(res.status).toBe(401);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("403 when the admin lacks the capability (a permission error, distinct from a gate deny)", async () => {
  process.env.CRON_SECRET = "";
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await post(READ_ONLY);
  expect(res.status).toBe(403);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("400 when platform / action.kind / action.targetUrl are missing", async () => {
  const auth = { authorization: "Bearer s3cret" };
  expect((await post({ action: { kind: "observe", targetUrl: "https://x.test" } }, auth)).status).toBe(400);
  expect((await post({ platform: "p", action: { targetUrl: "https://x.test" } }, auth)).status).toBe(400);
  expect((await post({ platform: "p", action: { kind: "observe" } }, auth)).status).toBe(400);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("400 on a bad action.kind", async () => {
  const res = await post(
    { platform: "p", action: { kind: "delete", targetUrl: "https://x.test" } },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(400);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("400 on invalid JSON body", async () => {
  const res = await post("{not json", { authorization: "Bearer s3cret" });
  expect(res.status).toBe(400);
  expect(mockAuthorize).not.toHaveBeenCalled();
});
