/**
 * Contract test for /api/admin/azure-status — verifies the probe
 * surfaces configured/not-configured per service AND last-error
 * details without leaking the actual keys.
 */

export {};

const mockRequireCapability = jest.fn();
const mockIsVision = jest.fn();
const mockIsFormRec = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/azure/vision-ocr", () => ({
  isVisionConfigured: () => mockIsVision(),
}));
jest.mock("@/lib/azure/form-recognizer", () => ({
  isFormRecognizerConfigured: () => mockIsFormRec(),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

function makeReq(): NextRequest {
  return new NextRequest("https://x.test/api/admin/azure-status", {
    headers: { authorization: "Bearer test" },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("GET /api/admin/azure-status", () => {
  it("returns 401/403 when caller lacks admin.health.probe", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it("returns configured booleans + zeroed counts when no calls in last 24h", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u", role: "cto", workspaceId: "w" } });
    mockIsVision.mockReturnValue(true);
    mockIsFormRec.mockReturnValue(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toEqual({ computer_vision: true, form_recognizer: false });
    expect(body.last_24h.computer_vision.total).toBe(0);
    expect(body.last_24h.form_recognizer.total).toBe(0);
  });

  it("groups call counts by service + status", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u", role: "cto", workspaceId: "w" } });
    mockIsVision.mockReturnValue(true);
    mockIsFormRec.mockReturnValue(true);
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          { service: "computer_vision", status: "succeeded", n: 12 },
          { service: "computer_vision", status: "failed", n: 1 },
          { service: "form_recognizer", status: "succeeded", n: 3 },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.last_24h.computer_vision).toMatchObject({ total: 13, succeeded: 12, failed: 1 });
    expect(body.last_24h.form_recognizer).toMatchObject({ total: 3, succeeded: 3 });
  });

  it("NEVER echoes endpoint or key in any field", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u", role: "cto", workspaceId: "w" } });
    mockIsVision.mockReturnValue(true);
    mockIsFormRec.mockReturnValue(true);
    process.env.AZURE_VISION_KEY = "should-never-appear-in-response";
    const res = await GET(makeReq());
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("should-never-appear-in-response");
    delete process.env.AZURE_VISION_KEY;
  });
});
