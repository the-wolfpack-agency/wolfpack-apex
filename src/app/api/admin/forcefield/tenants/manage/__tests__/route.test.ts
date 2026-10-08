/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/tenants/manage - the token lifecycle control
 * (kill a leaked token / rotate it). Auth (401/403); invalid action -> 400;
 * disable/enable -> 200 + audited; rotate -> 200 with the new token ONCE + audited
 * (audit never carries the token); unknown id -> 404. Libs mocked; no DB.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockSetStatus = jest.fn();
const mockRotate = jest.fn();
const mockSetPlatform = jest.fn();
const mockRecordAudit = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/forcefield-web/tenants", () => ({
  setTenantStatus: (...a: unknown[]) => mockSetStatus(...a),
  rotateTenantToken: (...a: unknown[]) => mockRotate(...a),
  setTenantSharesIntel: jest.fn(),
  setTenantPlatform: (...a: unknown[]) => mockSetPlatform(...a),
}));
// connectors is pure (no deps); use the REAL isConnectorKey so validation is genuine.
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";

const OK = { ok: true, user: { id: "op-1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const post = (body: unknown) =>
  new NextRequest("http://x/api/admin/forcefield/tenants/manage", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockRecordAudit.mockResolvedValue(undefined); });

it("401/403 when denied, libs untouched", async () => {
  mockRequireCapability.mockResolvedValueOnce(deny(401));
  expect((await POST(post({ id: "t1", action: "disable" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValueOnce(deny(403));
  expect((await POST(post({ id: "t1", action: "rotate" }))).status).toBe(403);
  expect(mockSetStatus).not.toHaveBeenCalled();
  expect(mockRotate).not.toHaveBeenCalled();
});

it("400 on an invalid action", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  expect((await POST(post({ id: "t1", action: "nuke" }))).status).toBe(400);
});

it("disable -> 200, sets disabled, audited (kill a leaked token)", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockSetStatus.mockResolvedValueOnce(true);
  const res = await POST(post({ id: "t1", action: "disable" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, status: "disabled" });
  expect(mockSetStatus).toHaveBeenCalledWith("t1", "disabled");
  expect(mockRecordAudit.mock.calls[0][0].action).toBe("forcefield.tenant_disabled");
});

it("enable -> 200 sets active", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockSetStatus.mockResolvedValueOnce(true);
  const res = await POST(post({ id: "t1", action: "enable" }));
  expect((await res.json()).status).toBe("active");
  expect(mockSetStatus).toHaveBeenCalledWith("t1", "active");
});

it("rotate -> 200 returns the NEW token once, audited WITHOUT the token", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockRotate.mockResolvedValueOnce({ token: "ff_newtoken" });
  const res = await POST(post({ id: "t1", action: "rotate" }));
  expect(res.status).toBe(200);
  expect((await res.json()).token).toBe("ff_newtoken");
  const audit = mockRecordAudit.mock.calls[0][0];
  expect(audit.action).toBe("forcefield.tenant_token_rotated");
  expect(JSON.stringify(audit)).not.toContain("ff_newtoken");
});

it("404 when the tenant does not exist", async () => {
  mockRequireCapability.mockResolvedValue(OK);
  mockSetStatus.mockResolvedValueOnce(false);
  expect((await POST(post({ id: "nope", action: "disable" }))).status).toBe(404);
  mockRotate.mockResolvedValueOnce(null);
  expect((await POST(post({ id: "nope", action: "rotate" }))).status).toBe(404);
});

describe("intel opt-out actions", () => {
  it("intel_off sets shares false + audited", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    const mod = jest.requireMock("@/lib/forcefield-web/tenants") as { setTenantSharesIntel: jest.Mock };
    mod.setTenantSharesIntel.mockResolvedValueOnce(true);
    const res = await POST(post({ id: "t1", action: "intel_off" }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, sharesIntel: false });
    expect(mod.setTenantSharesIntel).toHaveBeenCalledWith("t1", false);
    expect(mockRecordAudit.mock.calls[0][0].action).toBe("forcefield.tenant_intel_updated");
  });
  it("intel_on sets shares true", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    const mod = jest.requireMock("@/lib/forcefield-web/tenants") as { setTenantSharesIntel: jest.Mock };
    mod.setTenantSharesIntel.mockResolvedValueOnce(true);
    expect((await (await POST(post({ id: "t1", action: "intel_on" }))).json()).sharesIntel).toBe(true);
  });
})

describe("set_platform action", () => {
  it("sets a valid platform -> 200, audited, token never involved", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockSetPlatform.mockResolvedValueOnce(true);
    const res = await POST(post({ id: "t1", action: "set_platform", platform: "vercel" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, platform: "vercel" });
    expect(mockSetPlatform).toHaveBeenCalledWith("t1", "vercel");
    expect(mockRecordAudit.mock.calls[0][0].action).toBe("forcefield.tenant_platform_set");
    expect(mockTrack).toHaveBeenCalledWith("forcefield.tenant_platform_set", "op-1", "admin", { tenantId: "t1", platform: "vercel" });
  });

  it("rejects an unknown platform with 400 and never touches the DB", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    const res = await POST(post({ id: "t1", action: "set_platform", platform: "aws" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_platform");
    expect(mockSetPlatform).not.toHaveBeenCalled();
  });

  it("missing platform -> 400 invalid_platform", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    expect((await POST(post({ id: "t1", action: "set_platform" }))).status).toBe(400);
    expect(mockSetPlatform).not.toHaveBeenCalled();
  });

  it("404 when the tenant does not exist", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockSetPlatform.mockResolvedValueOnce(false);
    expect((await POST(post({ id: "nope", action: "set_platform", platform: "hosted" }))).status).toBe(404);
  });
})
