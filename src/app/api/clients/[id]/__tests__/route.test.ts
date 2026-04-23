/**
 * PUT/DELETE /api/clients/[id] route tests.
 *
 * requireCapability is mocked per-call to simulate 401 (no token),
 * 403 (forbidden), and ok paths. Every side effect (audit + triple
 * write + analytics) is mocked and asserted on.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockGetClient = jest.fn();
const mockUpdateClient = jest.fn();
const mockDeleteClient = jest.fn();
jest.mock("@/lib/clients", () => ({
  getClient: (...a: unknown[]) => mockGetClient(...a),
  updateClient: (...a: unknown[]) => mockUpdateClient(...a),
  deleteClient: (...a: unknown[]) => mockDeleteClient(...a),
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

import { NextRequest, NextResponse } from "next/server";
import { PUT, DELETE } from "@/app/api/clients/[id]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/clients/c-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function allowAs(role = "sales", userId = "u-sales") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: userId, email: "e@t", name: "E", role, created_at: "" },
    capabilities: new Set<string>(["clients.edit"]),
  });
}

function denyWith(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

const CLIENT_ROW = {
  id: "c-1",
  name: "Acme",
  industry: "tech",
  contact_email: "ops@acme.dev",
  contact_name: "Jane",
  notes: "VIP",
  docs: [],
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
describe("PUT /api/clients/[id]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await PUT(req("PUT", { name: "x" }), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockUpdateClient).not.toHaveBeenCalled();
  });

  it("403 when capability is missing", async () => {
    denyWith(403, "forbidden");
    const res = await PUT(req("PUT", { name: "x" }), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdateClient).not.toHaveBeenCalled();
  });

  it("404 when client does not exist", async () => {
    allowAs();
    mockGetClient.mockResolvedValueOnce(null);
    const res = await PUT(req("PUT", { name: "x" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("400 when no valid fields supplied", async () => {
    allowAs();
    mockGetClient.mockResolvedValueOnce(CLIENT_ROW);
    const res = await PUT(req("PUT", {}), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 happy path returns { ok, client } and fires audit + triple-write", async () => {
    allowAs("sales", "u-sales");
    mockGetClient.mockResolvedValueOnce(CLIENT_ROW);
    const updated = { ...CLIENT_ROW, name: "Acme Corp" };
    mockUpdateClient.mockResolvedValueOnce(updated);

    const res = await PUT(
      req("PUT", { name: "Acme Corp", industry: "tech", contact_email: "ops@acme.dev" }),
      { params: Promise.resolve({ id: "c-1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; client: { id: string; name: string } };
    expect(body.ok).toBe(true);
    expect(body.client.id).toBe("c-1");
    expect(body.client.name).toBe("Acme Corp");
    expect(mockUpdateClient).toHaveBeenCalledWith(
      "c-1",
      expect.objectContaining({ name: "Acme Corp" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "clients.edited", resourceId: "c-1" }),
    );
    expect(mockTripleWriteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "clients.edited" }),
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe("DELETE /api/clients/[id]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockDeleteClient).not.toHaveBeenCalled();
  });

  it("403 when capability is missing", async () => {
    denyWith(403, "forbidden");
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when client does not exist", async () => {
    allowAs();
    mockGetClient.mockResolvedValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 happy path returns { ok, id } and fires audit + analytics", async () => {
    allowAs("sales", "u-sales");
    mockGetClient.mockResolvedValueOnce(CLIENT_ROW);
    mockDeleteClient.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("c-1");
    expect(mockDeleteClient).toHaveBeenCalledWith("c-1", "u-sales");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "clients.deleted", resourceId: "c-1" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "clients.deleted",
      "u-sales",
      "sales",
      expect.objectContaining({ client_id: "c-1" }),
    );
  });

  it("404 when deleteClient returns false", async () => {
    allowAs();
    mockGetClient.mockResolvedValueOnce(CLIENT_ROW);
    mockDeleteClient.mockResolvedValueOnce(false);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "c-1" }),
    });
    expect(res.status).toBe(404);
  });
});
