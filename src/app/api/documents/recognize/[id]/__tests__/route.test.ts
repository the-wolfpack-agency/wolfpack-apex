/**
 * Contract tests for GET/PATCH /api/documents/recognize/[id].
 *
 * Pins:
 *   - Workspace scoping (404 when the row belongs to another workspace).
 *   - Auth (401 when requireCapability denies).
 *   - PATCH validates user_corrected_type against the enum (400 if not).
 *   - PATCH fires the corrected analytics event with original + corrected
 *     types so the learning loop can compute classifier accuracy.
 *   - Repeated PATCHes update user_corrected_at every time (not once).
 */

export {};

const mockRequireCapability = jest.fn();
const mockGetRecognition = jest.fn();
const mockRecordUserCorrection = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/document-recognition/persistence", () => ({
  getRecognition: (...a: unknown[]) => mockGetRecognition(...a),
  recordUserCorrection: (...a: unknown[]) => mockRecordUserCorrection(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GET, PATCH } = require("../route");

const okAuth = (over: { workspaceId?: string } = {}) => ({
  ok: true,
  user: {
    id: "u-1",
    role: "cto",
    workspaceId: over.workspaceId ?? "w-1",
    email: "homyk@thewolfpack.agency",
  },
  capabilities: new Set(),
});

const sampleRecognition = (over: Record<string, unknown> = {}) => ({
  id: "rec-1",
  workspaceId: "w-1",
  userId: "u-1",
  sourceFile: { filename: "x.png", mime: "image/png", bytes: 3, sha256: "sha-1" },
  classification: {
    type: "receipt",
    confidence: 0.93,
    alternates: [],
    rationale: "",
    model: "claude",
    latencyMs: 100,
    costCents: 0.1,
  },
  extraction: null,
  piiBlocked: false,
  recognizedAt: "2026-05-22T12:00:00Z",
  ...over,
});

function jsonReq(method: "GET" | "PATCH", body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/documents/recognize/rec-1", {
    method,
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.resetAllMocks();
  mockTrackEvent.mockReturnValue(undefined);
});

/* ---------------------------------- GET --------------------------------- */

describe("GET", () => {
  it("401 when auth fails", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(jsonReq("GET"), paramsFor("rec-1"));
    expect(res.status).toBe(401);
    expect(mockGetRecognition).not.toHaveBeenCalled();
  });

  it("returns the recognition when found", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGetRecognition.mockResolvedValueOnce(sampleRecognition());
    const res = await GET(jsonReq("GET"), paramsFor("rec-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recognition.id).toBe("rec-1");
    expect(mockGetRecognition).toHaveBeenCalledWith("w-1", "rec-1");
  });

  it("404 when the recognition is not in the workspace", async () => {
    mockRequireCapability.mockResolvedValue(okAuth({ workspaceId: "w-other" }));
    mockGetRecognition.mockResolvedValueOnce(null);
    const res = await GET(jsonReq("GET"), paramsFor("rec-1"));
    expect(res.status).toBe(404);
    expect(mockGetRecognition).toHaveBeenCalledWith("w-other", "rec-1");
  });
});

/* --------------------------------- PATCH -------------------------------- */

describe("PATCH", () => {
  it("401 when auth fails", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await PATCH(
      jsonReq("PATCH", { user_corrected_type: "invoice" }),
      paramsFor("rec-1"),
    );
    expect(res.status).toBe(401);
    expect(mockRecordUserCorrection).not.toHaveBeenCalled();
  });

  it("400 when user_corrected_type is missing", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const res = await PATCH(jsonReq("PATCH", {}), paramsFor("rec-1"));
    expect(res.status).toBe(400);
  });

  it("400 when user_corrected_type is not in the enum", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const res = await PATCH(
      jsonReq("PATCH", { user_corrected_type: "passport" }),
      paramsFor("rec-1"),
    );
    expect(res.status).toBe(400);
    expect(mockRecordUserCorrection).not.toHaveBeenCalled();
  });

  it("404 when the recognition isn't in this workspace", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGetRecognition.mockResolvedValueOnce(null);
    const res = await PATCH(
      jsonReq("PATCH", { user_corrected_type: "invoice" }),
      paramsFor("rec-missing"),
    );
    expect(res.status).toBe(404);
  });

  it("updates and fires the corrected analytics event with original + corrected types", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGetRecognition.mockResolvedValueOnce(sampleRecognition());
    mockRecordUserCorrection.mockResolvedValueOnce(
      sampleRecognition({ classification: { ...sampleRecognition().classification, type: "receipt" } }),
    );
    const res = await PATCH(
      jsonReq("PATCH", { user_corrected_type: "invoice" }),
      paramsFor("rec-1"),
    );
    expect(res.status).toBe(200);
    expect(mockRecordUserCorrection).toHaveBeenCalledWith({
      workspaceId: "w-1",
      id: "rec-1",
      correctedType: "invoice",
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.document_recognition_corrected",
      "u-1",
      "cto",
      expect.objectContaining({
        recognition_id: "rec-1",
        original_type: "receipt",
        corrected_type: "invoice",
      }),
    );
  });

  it("PATCH twice: each call records a correction (no only-once short-circuit)", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGetRecognition.mockResolvedValueOnce(sampleRecognition());
    mockRecordUserCorrection.mockResolvedValueOnce(sampleRecognition());
    await PATCH(
      jsonReq("PATCH", { user_corrected_type: "invoice" }),
      paramsFor("rec-1"),
    );
    mockGetRecognition.mockResolvedValueOnce(sampleRecognition());
    mockRecordUserCorrection.mockResolvedValueOnce(sampleRecognition());
    await PATCH(
      jsonReq("PATCH", { user_corrected_type: "tax_w2" }),
      paramsFor("rec-1"),
    );
    expect(mockRecordUserCorrection).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
  });

  it("invalid_json body returns 400", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    /* Send a request with no body. NextRequest.json() will reject. */
    const req = new NextRequest("https://x.test/api/documents/recognize/rec-1", {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
    });
    const res = await PATCH(req, paramsFor("rec-1"));
    expect(res.status).toBe(400);
  });
});
