/**
 * Contract for the automation-recommendations route. Auth (settings.manage_team),
 * the generate -> save -> Brain ingest -> analytics -> audit handoff on POST, the
 * filtered list on GET, and triage (valid / invalid status / not-found) on PATCH,
 * with all I/O mocked so no network/DB is touched.
 */
const mockSave = jest.fn();
const mockList = jest.fn();
const mockTriage = jest.fn();
const mockIngest = jest.fn();
const mockListFindings = jest.fn();
const mockListScans = jest.fn();
const mockGetProfile = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/store", () => ({
  listFindings: (...a: unknown[]) => mockListFindings(...a),
  listScans: (...a: unknown[]) => mockListScans(...a),
}));
jest.mock("@/lib/platform-scan/profile/store", () => ({ getSystemProfile: (...a: unknown[]) => mockGetProfile(...a) }));
jest.mock("@/lib/platform-scan/recommend/store", () => ({
  saveRecommendations: (...a: unknown[]) => mockSave(...a),
  listRecommendations: (...a: unknown[]) => mockList(...a),
  triageRecommendation: (...a: unknown[]) => mockTriage(...a),
}));
jest.mock("@/lib/platform-scan/recommend/brain-ingest", () => ({ ingestRecommendation: (...a: unknown[]) => mockIngest(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => { mockAudit(...a); return Promise.resolve(); },
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST, GET, PATCH } from "@/app/api/admin/platform-scans/recommendations/route";

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/admin/platform-scans/recommendations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
function patch(body: unknown) {
  return PATCH(new NextRequest("http://localhost/api/admin/platform-scans/recommendations", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockGetProfile.mockResolvedValue(null);
  mockListFindings.mockResolvedValue([]);
  mockListScans.mockResolvedValue([]);
  mockSave.mockResolvedValue(0);
  mockIngest.mockResolvedValue(undefined);
});

it("POST generates, saves, Brain-ingests, tracks, audits, and returns the recommendations", async () => {
  const res = await post({ platform: "acme" });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.ok).toBe(true);
  expect(Array.isArray(json.recommendations)).toBe(true);
  // The engine always emits the operational recs, so there is something to save.
  expect(json.recommendations.length).toBeGreaterThan(0);
  expect(mockSave).toHaveBeenCalledWith("ws-1", "acme", expect.any(Array));
  expect(mockIngest).toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.recommendations_generated",
    "admin-1",
    "admin",
    expect.objectContaining({ platform: "acme" }),
  );
  expect(mockAudit).toHaveBeenCalled();
});

it("POST 400 when platform missing and never saves", async () => {
  const res = await post({});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("platform_required");
  expect(mockSave).not.toHaveBeenCalled();
});

it("GET 200 lists recommendations with the status/platform filter", async () => {
  mockList.mockResolvedValue([{ id: "rec-1", key: "operational:sast", priority: "medium" }]);
  const res = await GET(new NextRequest("http://localhost/api/admin/platform-scans/recommendations?platform=acme&status=proposed"));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.recommendations).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith("ws-1", { platform: "acme", status: "proposed" });
});

it("PATCH 200 triages and tracks the triage event", async () => {
  mockTriage.mockResolvedValue({ id: "rec-1", key: "operational:sast", status: "accepted" });
  const res = await patch({ id: "rec-1", status: "accepted" });
  expect(res.status).toBe(200);
  expect(mockTriage).toHaveBeenCalledWith("ws-1", "rec-1", "accepted", "admin-1");
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.recommendation_triaged",
    "admin-1",
    "admin",
    expect.objectContaining({ status: "accepted" }),
  );
});

it("PATCH 400 on an invalid status", async () => {
  const res = await patch({ id: "rec-1", status: "bogus" });
  expect(res.status).toBe(400);
  expect(mockTriage).not.toHaveBeenCalled();
});

it("PATCH 404 when the recommendation does not exist", async () => {
  mockTriage.mockResolvedValue(null);
  const res = await patch({ id: "missing", status: "accepted" });
  expect(res.status).toBe(404);
});

it("refuses an unauthorized caller and never saves", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await post({ platform: "acme" });
  expect(res.status).toBe(403);
  expect(mockSave).not.toHaveBeenCalled();
});
