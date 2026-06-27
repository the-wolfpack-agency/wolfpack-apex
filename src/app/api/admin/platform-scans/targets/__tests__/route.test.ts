/**
 * Contract for /api/admin/platform-scans/targets. GET -> the scan targets that
 * populate the platform selector. POST -> onboard a client target (validate ->
 * save -> analytics + audit). DELETE -> offboard (deactivate). Gated on
 * settings.manage_team. The store, audit log, and analytics are mocked so no
 * DB/network is touched.
 */
const mockList = jest.fn();
const mockValidate = jest.fn();
const mockSave = jest.fn();
const mockRemove = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({ ok: true, user: { id: "a", role: "admin", workspaceId: "ws-1" } });

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/manifests", () => ({ listScanTargets: (...a: unknown[]) => mockList(...a) }));
jest.mock("@/lib/platform-scan/targets-store", () => ({
  validateScanTargetInput: (...a: unknown[]) => mockValidate(...a),
  saveScanTarget: (...a: unknown[]) => mockSave(...a),
  removeScanTarget: (...a: unknown[]) => mockRemove(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => { mockAudit(...a); return Promise.resolve(); },
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "@/app/api/admin/platform-scans/targets/route";

const MANIFEST = { baseUrl: "https://acme.example.com", routes: [] };

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/admin/platform-scans/targets", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
function del(qs: string) {
  return DELETE(new NextRequest(`http://localhost/api/admin/platform-scans/targets${qs}`, { method: "DELETE" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "a", role: "admin", workspaceId: "ws-1" } });
  mockList.mockResolvedValue([{ platform: "wolfpack-auto", baseUrl: "https://x", hasStatic: true }]);
  mockValidate.mockReturnValue({ ok: true, manifest: MANIFEST });
  mockSave.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(true);
});

describe("GET", () => {
  it("returns the scan targets (manifests + connections) for the workspace", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/platform-scans/targets"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targets: [{ platform: "wolfpack-auto", baseUrl: "https://x", hasStatic: true }] });
    expect(mockList).toHaveBeenCalledWith("ws-1");
  });

  it("403s when the capability gate fails", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await GET(new NextRequest("http://localhost/api/admin/platform-scans/targets"));
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("POST (onboard)", () => {
  it("validates, saves, tracks, audits, and returns 201", async () => {
    const res = await post({ platform: "acme", manifest: { baseUrl: "https://acme.example.com" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, platform: "acme" });
    expect(mockSave).toHaveBeenCalledWith("ws-1", "acme", MANIFEST, "a");
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.target_onboarded",
      "a",
      "admin",
      expect.objectContaining({ platform: "acme" }),
    );
    expect(mockAudit).toHaveBeenCalled();
  });

  it("400 platform_required when platform missing, and does not save", async () => {
    const res = await post({ manifest: { baseUrl: "https://acme.example.com" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("platform_required");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("400 with the validation error when the manifest is invalid, and does not save", async () => {
    mockValidate.mockReturnValue({ ok: false, error: "baseUrl_invalid" });
    const res = await post({ platform: "acme", manifest: { baseUrl: "nope" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("baseUrl_invalid");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("403 when unauthorized, and never touches the store", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await post({ platform: "acme", manifest: MANIFEST });
    expect(res.status).toBe(403);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("DELETE (offboard)", () => {
  it("200 ok when an active target was removed", async () => {
    mockRemove.mockResolvedValue(true);
    const res = await del("?platform=acme");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, platform: "acme" });
    expect(mockRemove).toHaveBeenCalledWith("ws-1", "acme");
    expect(mockTrack).toHaveBeenCalledWith("platform.target_offboarded", "a", "admin", { platform: "acme" });
  });

  it("404 when no active target matched", async () => {
    mockRemove.mockResolvedValue(false);
    const res = await del("?platform=missing");
    expect(res.status).toBe(404);
  });

  it("400 platform_required when no platform query param", async () => {
    const res = await del("");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("platform_required");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("403 when unauthorized, and never touches the store", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await del("?platform=acme");
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
