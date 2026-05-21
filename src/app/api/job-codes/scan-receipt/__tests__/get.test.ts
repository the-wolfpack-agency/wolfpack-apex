/**
 * Contract tests for GET /api/job-codes/scan-receipt/[id].
 *
 * Pins:
 *   - jobcodes.refresh capability is required (401/403 surface).
 *   - workspace_id is part of the WHERE clause — a row from another
 *     workspace returns 404 (never confirm existence cross-tenant).
 *   - 200 happy path returns the persisted fields + scan_id +
 *     original_filename + applied_* columns so the downstream apply
 *     modal can fully rehydrate.
 *   - 404 when the row doesn't exist (or belongs to another workspace).
 */

export {};

const mockRequireCapability = jest.fn();
const mockQuery = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../[id]/route";

const okAuth = (workspaceId = "w-1") => ({
  ok: true,
  user: {
    id: "u-1",
    role: "cto",
    workspaceId,
    email: "homyk@thewolfpack.agency",
  },
  capabilities: new Set(),
});

function mkReq(id: string): NextRequest {
  return new NextRequest(`https://x.test/api/job-codes/scan-receipt/${id}`, {
    method: "GET",
    headers: { authorization: "Bearer test" },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("GET /api/job-codes/scan-receipt/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(mkReq("scan-x"), { params: Promise.resolve({ id: "scan-x" }) });
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 403 when caller lacks jobcodes.refresh", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: "forbidden", capability: "jobcodes.refresh" },
        { status: 403 },
      ),
    });
    const res = await GET(mkReq("scan-x"), { params: Promise.resolve({ id: "scan-x" }) });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 200 with rehydrated fields on a workspace-owned scan", async () => {
    mockRequireCapability.mockResolvedValue(okAuth("w-99"));
    const fields = {
      merchantName: "Acme Hardware",
      transactionDate: "2026-05-21",
      total: 124.5,
      subtotal: null,
      tax: null,
      currency: "USD",
      items: [],
      documentConfidence: 0.92,
      rawText: "",
    };
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "scan-abc",
          fields,
          original_filename: "receipt.png",
          uploaded_at: "2026-05-21T10:00:00.000Z",
          applied_to_code: null,
          applied_at: null,
        },
      ],
    });
    const res = await GET(mkReq("scan-abc"), { params: Promise.resolve({ id: "scan-abc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scan_id).toBe("scan-abc");
    expect(body.fields.merchantName).toBe("Acme Hardware");
    expect(body.original_filename).toBe("receipt.png");
    /* workspace_id MUST be in the WHERE clause — that's the cross-
       tenant guard we're pinning. */
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(["scan-abc", "w-99"]);
  });

  it("returns 404 when the scan does not exist in the caller's workspace", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await GET(mkReq("missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("scan_not_found");
  });

  it("returns 400 when id param is empty", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const res = await GET(mkReq(""), { params: Promise.resolve({ id: "" }) });
    expect(res.status).toBe(400);
  });
});
