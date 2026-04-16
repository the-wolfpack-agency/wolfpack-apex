/**
 * /api/contacts + /api/contacts/[id] + /api/contacts/sync route tests.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGetUserContacts = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUserContacts(...a),
}));

const mockTrackApi = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackApi(...a),
}));

const mockListC = jest.fn();
const mockCreateC = jest.fn();
const mockUpdateC = jest.fn();
const mockDeleteC = jest.fn();
const mockSyncC = jest.fn();
class FakeGraphContactsErr extends Error {
  status: number; retryAfter?: number;
  constructor(s: number, m: string, ra?: number) { super(m); this.name = "GraphContactsError"; this.status = s; this.retryAfter = ra; }
}
jest.mock("@/lib/integrations/microsoft-contacts", () => ({
  listContacts: (...a: unknown[]) => mockListC(...a),
  createContact: (...a: unknown[]) => mockCreateC(...a),
  updateContact: (...a: unknown[]) => mockUpdateC(...a),
  deleteContact: (...a: unknown[]) => mockDeleteC(...a),
  syncAllContacts: (...a: unknown[]) => mockSyncC(...a),
  GraphContactsError: FakeGraphContactsErr,
}));

import { GET as contactsGET, POST as contactsPOST } from "@/app/api/contacts/route";
import { PATCH as contactPATCH, DELETE as contactDELETE } from "@/app/api/contacts/[id]/route";
import { POST as syncPOST, _resetContactsSyncRateLimit } from "@/app/api/contacts/sync/route";

function mkReq(opts: { auth?: string; url?: string; method?: string; body?: unknown } = {}): any {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/contacts", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetContactsSyncRateLimit();
});

// ---------------------------------------------------------------------------
// GET /api/contacts
// ---------------------------------------------------------------------------

describe("GET /api/contacts", () => {
  it("401 without auth", async () => {
    mockGetUserContacts.mockReturnValue(null);
    const res = await contactsGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns contacts + nextCursor from mirror", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockListC.mockResolvedValue({ contacts: [{ id: "c1" }], nextCursor: "c1" });
    const res = await contactsGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.contacts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/contacts
// ---------------------------------------------------------------------------

describe("POST /api/contacts", () => {
  it("400 when displayName missing", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    const res = await contactsPOST(mkReq({ auth: "Bearer x", body: {} }));
    expect(res.status).toBe(400);
  });

  it("201 on success", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockCreateC.mockResolvedValue({ id: "row", msContactId: "ms-c" });
    const res = await contactsPOST(mkReq({ auth: "Bearer x", body: { displayName: "Alice" } }));
    expect(res.status).toBe(201);
  });

  it("403 on scope_missing", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockCreateC.mockRejectedValue(new FakeGraphContactsErr(403, "no"));
    const res = await contactsPOST(mkReq({ auth: "Bearer x", body: { displayName: "X" } }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.scope).toBe("Contacts.ReadWrite");
  });

  it("400 on non-array emailAddresses", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    const res = await contactsPOST(mkReq({ auth: "Bearer x", body: { displayName: "A", emailAddresses: "a@x" } }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/contacts/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/contacts/[id]", () => {
  it("200 on success", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockUpdateC.mockResolvedValue({ id: "row" });
    const res = await contactPATCH(
      mkReq({ auth: "Bearer x", method: "PATCH", body: { displayName: "Z" } }),
      { params: Promise.resolve({ id: "ms-c" }) },
    );
    expect(res.status).toBe(200);
  });

  it("404 on not-found", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockUpdateC.mockRejectedValue(new FakeGraphContactsErr(404, "no"));
    const res = await contactPATCH(
      mkReq({ auth: "Bearer x", method: "PATCH", body: { displayName: "Z" } }),
      { params: Promise.resolve({ id: "ms-c" }) },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/contacts/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/contacts/[id]", () => {
  it("200 on success", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockDeleteC.mockResolvedValue(undefined);
    const res = await contactDELETE(
      mkReq({ auth: "Bearer x", method: "DELETE" }),
      { params: Promise.resolve({ id: "ms-c" }) },
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/contacts/sync — rate limit
// ---------------------------------------------------------------------------

describe("POST /api/contacts/sync", () => {
  it("first call runs sync; second call hits rate limit", async () => {
    mockGetUserContacts.mockReturnValue({ id: "u", role: "cto" });
    mockSyncC.mockResolvedValue({ synced: 5, deleted: 0, durationMs: 1, deltaToken: null });
    const res1 = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(res1.status).toBe(200);
    const res2 = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(res2.status).toBe(429);
    expect(res2.headers.get("retry-after")).toBeTruthy();
  });

  it("401 without auth", async () => {
    mockGetUserContacts.mockReturnValue(null);
    const res = await syncPOST(mkReq({ method: "POST" }));
    expect(res.status).toBe(401);
  });
});
