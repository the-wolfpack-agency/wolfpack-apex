export {};
/**
 * microsoft-directory.ts — listUsers, getUser, getManager, getDirectReports,
 * syncDirectory (delta token roundtrip + 403 scope_missing).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetValidToken = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok", userEmail: "u@x" });
  mockQuery.mockResolvedValue({ rows: [{ id: "uuid-x" }] });
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

function okResponse(data: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResponse(status: number, headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ error: "err" }),
    text: () => Promise.resolve("err"),
  };
}

// ---------------------------------------------------------------------------

describe("listUsers", () => {
  it("returns cached rows + nextCursor when pagination overflows", async () => {
    const rows = Array.from({ length: 3 }).map((_, i) => ({
      id: `u${i}`,
      ms_user_id: `ms${i}`,
      user_principal_name: `u${i}@x`,
      display_name: `User ${i}`,
      given_name: null,
      surname: null,
      mail: null,
      job_title: null,
      department: null,
      office_location: null,
      business_phones: "[]",
      mobile_phone: null,
      manager_ms_id: null,
      account_enabled: true,
      on_premises_sync_enabled: null,
      created_at: null,
      etag: null,
      synced_at: new Date().toISOString(),
    }));
    mockSafeQuery.mockResolvedValueOnce({ rows, fromCache: false });
    const { listUsers } = await import("@/lib/integrations/microsoft-directory");
    const result = await listUsers("caller", { top: 2 });
    expect(result.users).toHaveLength(2);
    expect(result.nextCursor).toBe("u1");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_directory_user_fetched",
      "caller",
      "system",
      expect.objectContaining({ mode: "list" }),
    );
  });

  it("applies search + department filters", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { listUsers } = await import("@/lib/integrations/microsoft-directory");
    await listUsers("caller", { search: "engineer", department: "R&D" });
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/ILIKE/);
    expect(sql).toMatch(/department = /);
    expect(params).toContain("%engineer%");
    expect(params).toContain("R&D");
  });
});

describe("getUser", () => {
  it("cache hit skips Graph", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "uu", ms_user_id: "ms1", user_principal_name: "u@x", display_name: "U",
        given_name: null, surname: null, mail: null, job_title: null, department: null,
        office_location: null, business_phones: "[]", mobile_phone: null,
        manager_ms_id: null, account_enabled: true, on_premises_sync_enabled: null,
        created_at: null, etag: null, synced_at: new Date().toISOString(),
      }],
      fromCache: false,
    });
    const { getUser } = await import("@/lib/integrations/microsoft-directory");
    const u = await getUser("caller", "ms1");
    expect(u?.msUserId).toBe("ms1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_directory_user_fetched",
      "caller",
      "system",
      expect.objectContaining({ mode: "cache_hit" }),
    );
  });

  it("cache miss fetches Graph + upserts + re-reads", async () => {
    // First safeQuery: cache lookup (empty). Second safeQuery: re-read post upsert.
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({
        rows: [{
          id: "uu", ms_user_id: "ms-graph", user_principal_name: null,
          display_name: "Graph U", given_name: null, surname: null, mail: null,
          job_title: null, department: null, office_location: null,
          business_phones: "[]", mobile_phone: null, manager_ms_id: null,
          account_enabled: true, on_premises_sync_enabled: null, created_at: null,
          etag: null, synced_at: new Date().toISOString(),
        }],
        fromCache: false,
      });
    fetchMock.mockResolvedValueOnce(okResponse({ id: "ms-graph", displayName: "Graph U" }));
    const { getUser } = await import("@/lib/integrations/microsoft-directory");
    const u = await getUser("caller", "ms-graph");
    expect(u?.msUserId).toBe("ms-graph");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalled(); // upsert
  });

  it("returns null on 403 and does not throw", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    fetchMock.mockResolvedValueOnce(errResponse(403));
    const { getUser } = await import("@/lib/integrations/microsoft-directory");
    const u = await getUser("caller", "whoever");
    expect(u).toBeNull();
  });

  it("returns null on 404", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    fetchMock.mockResolvedValueOnce(errResponse(404));
    const { getUser } = await import("@/lib/integrations/microsoft-directory");
    expect(await getUser("caller", "missing")).toBeNull();
  });
});

describe("getManager", () => {
  it("upserts manager + patches subject + re-reads manager row", async () => {
    // Upsert uses mockQuery; post-upsert re-read uses safeQuery; return one row.
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "uu", ms_user_id: "mgr1", user_principal_name: null,
        display_name: "Boss", given_name: null, surname: null, mail: null,
        job_title: null, department: null, office_location: null,
        business_phones: "[]", mobile_phone: null, manager_ms_id: null,
        account_enabled: true, on_premises_sync_enabled: null, created_at: null,
        etag: null, synced_at: new Date().toISOString(),
      }],
      fromCache: false,
    });
    fetchMock.mockResolvedValueOnce(okResponse({ id: "mgr1", displayName: "Boss" }));
    const { getManager } = await import("@/lib/integrations/microsoft-directory");
    const m = await getManager("caller", "subject");
    expect(m?.msUserId).toBe("mgr1");
    // One upsert on the manager, one UPDATE patching subject
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(404));
    const { getManager } = await import("@/lib/integrations/microsoft-directory");
    expect(await getManager("caller", "subject")).toBeNull();
  });
});

describe("getDirectReports", () => {
  it("upserts + re-reads each report", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      value: [
        { id: "r1", displayName: "R1" },
        { id: "r2", displayName: "R2" },
      ],
    }));
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{
          id: "u1", ms_user_id: "r1", user_principal_name: null,
          display_name: "R1", given_name: null, surname: null, mail: null,
          job_title: null, department: null, office_location: null,
          business_phones: "[]", mobile_phone: null, manager_ms_id: "subject",
          account_enabled: true, on_premises_sync_enabled: null, created_at: null,
          etag: null, synced_at: new Date().toISOString(),
        }],
        fromCache: false,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "u2", ms_user_id: "r2", user_principal_name: null,
          display_name: "R2", given_name: null, surname: null, mail: null,
          job_title: null, department: null, office_location: null,
          business_phones: "[]", mobile_phone: null, manager_ms_id: "subject",
          account_enabled: true, on_premises_sync_enabled: null, created_at: null,
          etag: null, synced_at: new Date().toISOString(),
        }],
        fromCache: false,
      });
    const { getDirectReports } = await import("@/lib/integrations/microsoft-directory");
    const reports = await getDirectReports("caller", "subject");
    expect(reports.map((r) => r.msUserId)).toEqual(["r1", "r2"]);
  });

  it("empty on 403", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403));
    const { getDirectReports } = await import("@/lib/integrations/microsoft-directory");
    expect(await getDirectReports("caller", "subject")).toEqual([]);
  });
});

describe("syncDirectory", () => {
  it("performs delta sync, upserts users, handles @removed, persists token", async () => {
    // No prior token.
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    fetchMock.mockResolvedValueOnce(okResponse({
      value: [
        { id: "ms1", displayName: "One" },
        { id: "ms2", displayName: "Two", "@removed": { reason: "changed" } },
      ],
      "@odata.deltaLink":
        "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=ABC123",
    }));
    const { syncDirectory } = await import("@/lib/integrations/microsoft-directory");
    const result = await syncDirectory("caller");
    // scope_missing discriminator NOT present
    expect("ok" in result && result.ok === false).toBe(false);
    if (!("synced" in result)) throw new Error("expected SyncResult");
    expect(result.synced).toBe(1); // one upsert, one delete
    expect(result.nextDeltaToken).toBe("ABC123");
    // Should have persisted: upsert (1) + delete (1) + token persist (1) = 3
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_directory_synced",
      "caller",
      "system",
      expect.objectContaining({ synced: 1, had_previous_token: 0 }),
    );
  });

  it("reuses persisted delta token when not provided", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ delta_token: "PREV" }],
      fromCache: false,
    });
    fetchMock.mockResolvedValueOnce(okResponse({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=NEXT",
    }));
    const { syncDirectory } = await import("@/lib/integrations/microsoft-directory");
    const result = await syncDirectory("caller");
    if (!("synced" in result)) throw new Error("expected SyncResult");
    expect(result.nextDeltaToken).toBe("NEXT");
    // First fetch call should have used the stored PREV token.
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain("PREV");
  });

  it("walks nextLink pages until deltaLink", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    fetchMock
      .mockResolvedValueOnce(okResponse({
        value: [{ id: "p1", displayName: "P1" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/delta?$skiptoken=NEXT",
      }))
      .mockResolvedValueOnce(okResponse({
        value: [{ id: "p2", displayName: "P2" }],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=DONE",
      }));
    const { syncDirectory } = await import("@/lib/integrations/microsoft-directory");
    const result = await syncDirectory("caller");
    if (!("synced" in result)) throw new Error("expected SyncResult");
    expect(result.synced).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns scope_missing on 403", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    fetchMock.mockResolvedValueOnce(errResponse(403));
    const { syncDirectory } = await import("@/lib/integrations/microsoft-directory");
    const result = await syncDirectory("caller");
    expect(result).toMatchObject({
      ok: false,
      code: "scope_missing",
      scope: "User.Read.All",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_directory_sync_failed",
      "caller",
      "system",
      expect.objectContaining({ reason: "scope_missing" }),
    );
  });

  it("emits sync_failed on other Graph errors", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    fetchMock.mockResolvedValueOnce(errResponse(500));
    const { syncDirectory, DirectoryError } = await import("@/lib/integrations/microsoft-directory");
    await expect(syncDirectory("caller")).rejects.toBeInstanceOf(DirectoryError);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_directory_sync_failed",
      "caller",
      "system",
      expect.objectContaining({ http_status: 500 }),
    );
  });
});
