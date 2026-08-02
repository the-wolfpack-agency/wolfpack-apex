/**
 * Microsoft Contacts integration tests — CRUD, sync, mirror correctness, 403.
 */
 

const mockTrackContacts = jest.fn();
const mockQueryContacts = jest.fn();
const mockSafeQueryContacts = jest.fn();
const mockGetValidTokenContacts = jest.fn();
const mockRecordAuditContacts = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackContacts(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryContacts(...args),
  safeQuery: (...args: any[]) => mockSafeQueryContacts(...args),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenContacts(...args),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAuditContacts(...args),
}));

const realFetchContacts = global.fetch;
const fetchMockContacts = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMockContacts; });
afterAll(() => { (global as any).fetch = realFetchContacts; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockContacts.mockReset();
  mockGetValidTokenContacts.mockResolvedValue({ accessToken: "tok" });
  mockRecordAuditContacts.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
  mockQueryContacts.mockResolvedValue({ rows: [{ id: "row-1", synced_at: new Date().toISOString() }] });
  mockSafeQueryContacts.mockResolvedValue({ rows: [] });
});

function okRespCtx(data: unknown): any {
  return { ok: true, status: 200, json: () => Promise.resolve(data), headers: { get: () => null }, text: () => Promise.resolve("") };
}
function errRespCtx(status: number, headers: Record<string, string> = {}): any {
  return { ok: false, status, json: () => Promise.resolve({}), text: () => Promise.resolve(""), headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } };
}

// ---------------------------------------------------------------------------
// createContact
// ---------------------------------------------------------------------------

describe("createContact", () => {
  it("POSTs to /me/contacts, upserts mirror, audits, analytics", async () => {
    fetchMockContacts.mockResolvedValueOnce(okRespCtx({
      id: "ms-c-1",
      displayName: "Alice",
      emailAddresses: [{ address: "a@x" }],
      companyName: "Corp",
    }));
    const { createContact } = await import("@/lib/integrations/microsoft-contacts");
    const out = await createContact("u", { displayName: "Alice", emailAddresses: ["a@x"] });
    expect(out.msContactId).toBe("ms-c-1");
    expect(fetchMockContacts.mock.calls[0][0]).toMatch(/me\/contacts$/);
    expect(mockTrackContacts).toHaveBeenCalledWith(
      "system.ms_contact_created",
      "u",
      "system",
      expect.objectContaining({ contact_id: "ms-c-1" }),
    );
    expect(mockRecordAuditContacts).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contacts.created" }),
    );
  });

  it("bubbles up 403 and records failure analytics", async () => {
    fetchMockContacts.mockResolvedValueOnce(errRespCtx(403));
    const { createContact } = await import("@/lib/integrations/microsoft-contacts");
    await expect(createContact("u", { displayName: "X" })).rejects.toMatchObject({ status: 403 });
    expect(mockTrackContacts).toHaveBeenCalledWith(
      "system.ms_contact_created",
      "u",
      "system",
      expect.objectContaining({ ok: false, http_status: 403 }),
    );
  });
});

// ---------------------------------------------------------------------------
// updateContact
// ---------------------------------------------------------------------------

describe("updateContact", () => {
  it("PATCHes + audits with before/after", async () => {
    mockSafeQueryContacts.mockResolvedValueOnce({
      rows: [{ display_name: "Old", email_addresses: "[]", company_name: null, job_title: null }],
    });
    fetchMockContacts.mockResolvedValueOnce(okRespCtx({
      id: "ms-c-1", displayName: "New", emailAddresses: [{ address: "n@x" }],
    }));
    const { updateContact } = await import("@/lib/integrations/microsoft-contacts");
    await updateContact("u", "ms-c-1", { displayName: "New" });
    expect(fetchMockContacts.mock.calls[0][1].method).toBe("PATCH");
    expect(mockRecordAuditContacts).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contacts.updated", resourceId: "ms-c-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// deleteContact
// ---------------------------------------------------------------------------

describe("deleteContact", () => {
  it("sends DELETE, removes mirror row, audits", async () => {
    fetchMockContacts.mockResolvedValueOnce({ ok: true, status: 204, json: () => ({}), text: () => Promise.resolve(""), headers: { get: () => null } });
    mockQueryContacts.mockResolvedValueOnce({
      rows: [{ id: "row-1", display_name: "Alice", email_addresses: "[]", phone_numbers: "[]", company_name: null, job_title: null, etag: null, synced_at: new Date().toISOString() }],
    });
    const { deleteContact } = await import("@/lib/integrations/microsoft-contacts");
    await deleteContact("u", "ms-c-1");
    expect(mockRecordAuditContacts).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contacts.deleted" }),
    );
    expect(mockTrackContacts).toHaveBeenCalledWith(
      "system.ms_contact_deleted",
      "u",
      "system",
      expect.objectContaining({ contact_id: "ms-c-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// syncAllContacts — delta + full variants
// ---------------------------------------------------------------------------

describe("syncAllContacts", () => {
  it("full sync: iterates pages until deltaLink, upserts, emits analytics", async () => {
    // No prior delta token — full list path.
    mockSafeQueryContacts.mockResolvedValueOnce({ rows: [] });
    fetchMockContacts
      .mockResolvedValueOnce(okRespCtx({
        value: [{ id: "c1", displayName: "A" }, { id: "c2", displayName: "B" }],
        "@odata.nextLink": "https://graph/next",
      }))
      .mockResolvedValueOnce(okRespCtx({
        value: [{ id: "c3", displayName: "C" }],
        "@odata.deltaLink": "https://graph/delta",
      }));

    const { syncAllContacts } = await import("@/lib/integrations/microsoft-contacts");
    const res = await syncAllContacts("u");
    expect(res.synced).toBe(3);
    expect(res.deleted).toBe(0);
    expect(res.deltaToken).toBe("https://graph/delta");
    expect(mockTrackContacts).toHaveBeenCalledWith(
      "system.ms_contacts_sync",
      "u",
      "system",
      expect.objectContaining({ synced: 3 }),
    );
  });

  it("delta sync: honors @removed rows", async () => {
    mockSafeQueryContacts.mockResolvedValueOnce({ rows: [{ etag: "https://graph/prior" }] });
    fetchMockContacts.mockResolvedValueOnce(okRespCtx({
      value: [{ id: "c-del", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": "https://graph/delta2",
    }));
    const { syncAllContacts } = await import("@/lib/integrations/microsoft-contacts");
    const res = await syncAllContacts("u");
    expect(res.synced).toBe(0);
    expect(res.deleted).toBe(1);
  });

  it("on 403, tracks failure and rethrows", async () => {
    mockSafeQueryContacts.mockResolvedValueOnce({ rows: [] });
    fetchMockContacts.mockResolvedValueOnce(errRespCtx(403));
    const { syncAllContacts } = await import("@/lib/integrations/microsoft-contacts");
    await expect(syncAllContacts("u")).rejects.toMatchObject({ status: 403 });
    expect(mockTrackContacts).toHaveBeenCalledWith(
      "system.ms_contacts_sync",
      "u",
      "system",
      expect.objectContaining({ ok: false, http_status: 403 }),
    );
  });
});

// ---------------------------------------------------------------------------
// listContacts — reads from mirror only
// ---------------------------------------------------------------------------

describe("listContacts", () => {
  it("returns mirror rows with pagination", async () => {
    mockSafeQueryContacts.mockResolvedValueOnce({
      rows: Array.from({ length: 3 }).map((_, i) => ({
        id: `r${i}`, user_id: "u", ms_contact_id: `c${i}`, display_name: `N${i}`,
        email_addresses: "[]", phone_numbers: "[]",
        company_name: null, job_title: null, etag: null, synced_at: new Date().toISOString(),
      })),
    });
    const { listContacts } = await import("@/lib/integrations/microsoft-contacts");
    const out = await listContacts("u", { limit: 10 });
    expect(out.contacts).toHaveLength(3);
    expect(out.nextCursor).toBeNull();
  });
});
