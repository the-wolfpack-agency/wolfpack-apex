/**
 * POST /api/features + GET /api/features/[id] response-shape contract.
 *
 * Both answer with the row wrapped as { feature }, never a bare row. Two
 * consumers read a top-level `id` instead (the assistant form executor and
 * the feature-requests data-flow E2E spec), so the id was lost on every
 * successful submit. This pins the shape both consumers now rely on.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));

const mockSubmit = jest.fn();
jest.mock("@/lib/feature-requests", () => ({
  getFeatureRequests: jest.fn().mockResolvedValue([]),
  submitFeatureRequest: (...a: unknown[]) => mockSubmit(...a),
  getFeatureRequest: jest.fn(),
  updateFeatureRequest: jest.fn(),
  deleteFeatureRequest: jest.fn(),
  updateFeatureStatus: jest.fn(),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

jest.mock("@/lib/auth/require-capability", () => ({
  effectiveCapabilitiesFor: jest.fn().mockResolvedValue({ capabilities: new Set(), overrides: {} }),
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: jest.fn(), extractRequestMetadata: () => ({}) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/triple-write", () => ({ tripleWriteEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/features/route";
import { GET as GET_BY_ID } from "@/app/api/features/[id]/route";

const USER = { id: "u-1", email: "u@t", name: "U", role: "dev", created_at: "" };
const ROW = { id: "fr-1", title: "Dark mode", description: "Please", submitted_by: "u-1" };

function post(body: unknown): NextRequest {
  return new NextRequest("http://test/api/features", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue(USER);
});

describe("POST /api/features", () => {
  it("answers 201 with the inserted row under `feature` (no top-level id)", async () => {
    mockSubmit.mockResolvedValueOnce(ROW);
    const res = await POST(post({ title: "Dark mode", description: "Please", priority: "low" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.feature).toEqual(ROW);
    expect(body.id).toBeUndefined();
  });

  it("401 without a user, 400 without title/description", async () => {
    mockGetUser.mockReturnValueOnce(null);
    expect((await POST(post({ title: "x", description: "y" }))).status).toBe(401);
    const res = await POST(post({ title: "", description: "" }));
    expect(res.status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe("GET /api/features/[id]", () => {
  it("answers 200 { feature } for an existing row", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [ROW] });
    const res = await GET_BY_ID(
      new NextRequest("http://test/api/features/fr-1", { headers: { authorization: "Bearer t" } }),
      { params: Promise.resolve({ id: "fr-1" }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).feature).toEqual(ROW);
  });

  it("answers 404 when the row is absent", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const res = await GET_BY_ID(
      new NextRequest("http://test/api/features/nope", { headers: { authorization: "Bearer t" } }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(404);
  });
});
