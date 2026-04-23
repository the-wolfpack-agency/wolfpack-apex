/**
 * PUT/DELETE /api/features/[id] route tests.
 *
 * Mirrors knowledge/[id] test style — every server dep is mocked,
 * handlers are imported directly, responses inspected. Covers the
 * auth / owner / admin / 404 / happy-path matrix for PUT + DELETE.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));

const mockGetFeature = jest.fn();
const mockUpdateFeature = jest.fn();
const mockDeleteFeature = jest.fn();
const mockUpdateStatus = jest.fn();
jest.mock("@/lib/feature-requests", () => ({
  getFeatureRequest: (...a: unknown[]) => mockGetFeature(...a),
  updateFeatureRequest: (...a: unknown[]) => mockUpdateFeature(...a),
  deleteFeatureRequest: (...a: unknown[]) => mockDeleteFeature(...a),
  updateFeatureStatus: (...a: unknown[]) => mockUpdateStatus(...a),
}));

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock("@/lib/auth/require-capability", () => ({
  effectiveCapabilitiesFor: jest.fn().mockResolvedValue({
    capabilities: new Set<string>(["features.approve"]),
    overrides: {},
  }),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({}),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

const mockTripleWriteEvent = jest.fn();
jest.mock("@/lib/triple-write", () => ({
  tripleWriteEvent: (...a: unknown[]) => mockTripleWriteEvent(...a),
}));

import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/features/[id]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/features/f-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const OWNER = { id: "u-owner", email: "o@t", name: "Owner", role: "dev", created_at: "" };
const OTHER = { id: "u-other", email: "x@t", name: "Other", role: "dev", created_at: "" };
const ADMIN = { id: "u-admin", email: "a@t", name: "Admin", role: "cto", created_at: "" };

const FEATURE_ROW = {
  id: "f-1",
  title: "Old title",
  description: "Old desc",
  submitted_by: "u-owner",
  status: "submitted",
  priority: "medium",
  target_product: null,
  analysis: {},
  comparisons: [],
  votes: 0,
  comments: [],
  estimated_hours: null,
  estimated_cost: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "a-1", seq: 1, entryHash: "h" });
  mockTripleWriteEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------
describe("PUT /api/features/[id]", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await PUT(req("PUT", { title: "x" }), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockUpdateFeature).not.toHaveBeenCalled();
  });

  it("404 when feature does not exist", async () => {
    mockGetUser.mockReturnValueOnce(OWNER);
    mockGetFeature.mockResolvedValueOnce(null);
    const res = await PUT(req("PUT", { title: "x" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when a non-owner, non-admin tries to edit", async () => {
    mockGetUser.mockReturnValueOnce(OTHER);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    const res = await PUT(req("PUT", { title: "hijack" }), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdateFeature).not.toHaveBeenCalled();
  });

  it("400 when no valid fields are supplied", async () => {
    mockGetUser.mockReturnValueOnce(OWNER);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    const res = await PUT(req("PUT", {}), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 happy-path owner returns { ok, feature } and fires audit + triple-write", async () => {
    mockGetUser.mockReturnValueOnce(OWNER);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    const updated = { ...FEATURE_ROW, title: "New title", description: "New desc" };
    mockUpdateFeature.mockResolvedValueOnce(updated);

    const res = await PUT(
      req("PUT", { title: "New title", description: "New desc", priority: "high" }),
      { params: Promise.resolve({ id: "f-1" }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; feature: { id: string; title: string } };
    expect(body.ok).toBe(true);
    expect(body.feature.id).toBe("f-1");
    expect(body.feature.title).toBe("New title");
    expect(mockUpdateFeature).toHaveBeenCalledWith(
      "f-1",
      expect.objectContaining({
        title: "New title",
        description: "New desc",
        priority: "high",
      }),
      "u-owner",
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "features.edited", resourceId: "f-1" }),
    );
    expect(mockTripleWriteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "features.edited" }),
    );
  });

  it("200 happy-path for admin even when not the submitter", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    mockUpdateFeature.mockResolvedValueOnce({ ...FEATURE_ROW, title: "Admin edit" });

    const res = await PUT(req("PUT", { title: "Admin edit" }), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe("DELETE /api/features/[id]", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockDeleteFeature).not.toHaveBeenCalled();
  });

  it("404 when feature does not exist", async () => {
    mockGetUser.mockReturnValueOnce(OWNER);
    mockGetFeature.mockResolvedValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-owner, non-admin attempts delete", async () => {
    mockGetUser.mockReturnValueOnce(OTHER);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(403);
    expect(mockDeleteFeature).not.toHaveBeenCalled();
  });

  it("200 owner delete returns { ok, id } and fires audit + analytics", async () => {
    mockGetUser.mockReturnValueOnce(OWNER);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    mockDeleteFeature.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "f-1" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("f-1");
    expect(mockDeleteFeature).toHaveBeenCalledWith("f-1", "u-owner");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "features.deleted", resourceId: "f-1" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "features.deleted",
      "u-owner",
      "dev",
      expect.objectContaining({ feature_id: "f-1" }),
    );
  });

  it("200 admin can delete even when not the submitter", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    mockDeleteFeature.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(200);
  });

  it("404 when deleteFeatureRequest returns false", async () => {
    mockGetUser.mockReturnValueOnce(OWNER);
    mockGetFeature.mockResolvedValueOnce(FEATURE_ROW);
    mockDeleteFeature.mockResolvedValueOnce(false);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "f-1" }),
    });
    expect(res.status).toBe(404);
  });
});
