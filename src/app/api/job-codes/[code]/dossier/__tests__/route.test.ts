/**
 * Contract tests for GET /api/job-codes/[code]/dossier.
 *
 * Locks the auth gate (401/403), the 404 path for unknown codes, the
 * happy-path payload shape, and the analytics emit so a refactor that
 * silently drops one of those fails at PR time.
 */

export {};

const mockRequireCapability = jest.fn();
const mockBuildDossier = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/job-codes/dossier", () => ({
  buildCodeDossier: (...a: unknown[]) => mockBuildDossier(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

function makeReq(code: string): NextRequest {
  return new NextRequest(`https://x.test/api/job-codes/${code}/dossier`, {
    method: "GET",
    headers: { authorization: "Bearer test" },
  });
}

const okAuth = () => ({
  ok: true,
  user: { id: "u-1", role: "cto", workspaceId: "w-1", email: "homyk@thewolfpack.agency" },
  capabilities: new Set(),
});

const sampleDossier = {
  header: {
    code: "WOLFPACK-AUTO",
    description: "x",
    active: true,
    category: "Wolfpack Auto",
    program: null,
    poNumber: null,
    poAmount: "1000",
    poAmountNumeric: 1000,
    lastSeenAt: "2026-05-21T00:00:00.000Z",
    webUrl: null,
  },
  rollups: {
    spendYtd: 100,
    spendMtd: 50,
    spendAllTime: 200,
    receiptCount: 3,
    poRemaining: 800,
    lastActivityAt: "2026-05-21T00:00:00.000Z",
  },
  receipts: [],
  activity: [],
};

beforeEach(() => {
  jest.resetAllMocks();
  mockTrackEvent.mockResolvedValue(undefined);
});

describe("GET /api/job-codes/[code]/dossier", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(makeReq("X"), { params: Promise.resolve({ code: "X" }) });
    expect(res.status).toBe(401);
    expect(mockBuildDossier).not.toHaveBeenCalled();
  });

  it("returns 403 when caller lacks jobcodes.view", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await GET(makeReq("X"), { params: Promise.resolve({ code: "X" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 when code is missing / whitespace", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const res = await GET(makeReq("   "), { params: Promise.resolve({ code: "   " }) });
    expect(res.status).toBe(400);
    expect(mockBuildDossier).not.toHaveBeenCalled();
  });

  it("returns 404 when the code isn't in the cache", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockBuildDossier.mockResolvedValue(null);
    const res = await GET(makeReq("UNKNOWN"), { params: Promise.resolve({ code: "UNKNOWN" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("code_not_found");
  });

  it("200 returns { dossier } and emits the dossier_viewed analytics event", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockBuildDossier.mockResolvedValue(sampleDossier);

    const res = await GET(
      makeReq("WOLFPACK-AUTO"),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dossier.header.code).toBe("WOLFPACK-AUTO");
    expect(body.dossier.rollups.receiptCount).toBe(3);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.job_code_dossier_viewed",
      "u-1",
      "cto",
      expect.objectContaining({
        code: "WOLFPACK-AUTO",
        receipt_count: 3,
        has_po: true,
      }),
    );
  });
});
