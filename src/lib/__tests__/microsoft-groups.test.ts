/**
 * Microsoft Groups integration tests — listMyGroups + syncGroups.
 *
 * Exercises: cache reads, scope_missing (403), rate-limit backoff (429),
 * cache upsert on successful sync.
 */
 

// Make this file a module (not a script) so top-level `const` declarations
// stay file-scoped under tsconfig's `isolatedModules`.
export {};

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
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = realFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@example.com" });
});

function ok(data: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function err(status: number, body: any = {}, headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// listMyGroups (cache read)
// ---------------------------------------------------------------------------

describe("listMyGroups", () => {
  it("returns rows from cache with cursor paging", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "a", user_id: "u", ms_group_id: "g1", display_name: "Team A", description: null,
          mail_enabled: true, group_types: ["Unified"], visibility: "Private",
          created_at: new Date().toISOString(), synced_at: new Date().toISOString() },
      ],
    });
    const { listMyGroups } = await import("@/lib/integrations/microsoft-groups");
    const out = await listMyGroups("u", { limit: 10 });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].displayName).toBe("Team A");
    expect(out.nextCursor).toBeNull();
  });

  it("builds ILIKE filter when search is provided", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { listMyGroups } = await import("@/lib/integrations/microsoft-groups");
    await listMyGroups("u", { search: "team" });
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/display_name ILIKE/);
  });
});

// ---------------------------------------------------------------------------
// syncGroups — happy path + 403 + 429
// ---------------------------------------------------------------------------

describe("syncGroups", () => {
  it("pulls groups from Graph, upserts, emits system.ms_groups_synced", async () => {
    fetchMock.mockResolvedValueOnce(ok({
      value: [
        { id: "g1", displayName: "Team A", mailEnabled: true, groupTypes: ["Unified"] },
        { id: "g2", displayName: "Team B", mailEnabled: false, groupTypes: [] },
      ],
    }));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "local-a" }] })
      .mockResolvedValueOnce({ rows: [{ id: "local-b" }] });

    const { syncGroups } = await import("@/lib/integrations/microsoft-groups");
    const res = await syncGroups("u");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value.count).toBe(2);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_groups_synced",
      "u",
      "system",
      expect.objectContaining({ count: 2 }),
    );
  });

  it("returns scope_missing on 403 without throwing", async () => {
    fetchMock.mockResolvedValueOnce(err(403, {
      error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" },
    }));
    const { syncGroups } = await import("@/lib/integrations/microsoft-groups");
    const res = await syncGroups("u");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("scope_missing");
    expect(res.scope).toBe("Group.Read.All");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_groups_sync_failed",
      "u",
      "system",
      expect.objectContaining({ code: "scope_missing" }),
    );
  });

  it("honors Retry-After on 429 and retries once", async () => {
    fetchMock
      .mockResolvedValueOnce(err(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(ok({ value: [] }));
    const { syncGroups } = await import("@/lib/integrations/microsoft-groups");
    const res = await syncGroups("u");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns not_connected when token unavailable", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { syncGroups } = await import("@/lib/integrations/microsoft-groups");
    const res = await syncGroups("u");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("not_connected");
  });

  it("follows @odata.nextLink pagination", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({
        value: [{ id: "g1", displayName: "A" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group?$skiptoken=XYZ",
      }))
      .mockResolvedValueOnce(ok({ value: [{ id: "g2", displayName: "B" }] }));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "a" }] })
      .mockResolvedValueOnce({ rows: [{ id: "b" }] });

    const { syncGroups } = await import("@/lib/integrations/microsoft-groups");
    const res = await syncGroups("u");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value.count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
