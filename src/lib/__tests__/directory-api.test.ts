/**
 * Directory API routes — auth, rate limit, audit on sync, analytics.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

const mockRecordAudit = jest.fn();
const mockExtractMeta = jest.fn(() => ({}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: (...a: unknown[]) => mockExtractMeta(...a),
}));

const mockListUsers = jest.fn();
const mockGetUserDir = jest.fn();
const mockGetManager = jest.fn();
const mockGetDirectReports = jest.fn();
const mockSyncDirectory = jest.fn();
jest.mock("@/lib/integrations/microsoft-directory", () => {
  class DirectoryError extends Error {
    status: number;
    retryAfter?: number;
    constructor(status: number, msg: string, retryAfter?: number) {
      super(msg);
      this.status = status;
      this.retryAfter = retryAfter;
    }
  }
  return {
    listUsers: (...a: unknown[]) => mockListUsers(...a),
    getUser: (...a: unknown[]) => mockGetUserDir(...a),
    getManager: (...a: unknown[]) => mockGetManager(...a),
    getDirectReports: (...a: unknown[]) => mockGetDirectReports(...a),
    syncDirectory: (...a: unknown[]) => mockSyncDirectory(...a),
    DirectoryError,
    asScopeMissing: (err: unknown, scope: string) =>
      err instanceof DirectoryError && err.status === 403
        ? { ok: false, code: "scope_missing", scope }
        : null,
  };
});

const mockGetCachedOOO = jest.fn();
jest.mock("@/lib/integrations/microsoft-mailbox", () => ({
  getCachedOOOState: (...a: unknown[]) => mockGetCachedOOO(...a),
}));

function mkReq(path: string, method = "GET", auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method, headers }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/directory/users
// ---------------------------------------------------------------------------

describe("GET /api/directory/users", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/directory/users/route");
    const res = await GET(mkReq("/api/directory/users"));
    expect(res.status).toBe(401);
  });

  it("returns users + nextCursor + 30s cache-control", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListUsers.mockResolvedValue({ users: [{ id: "a" }], nextCursor: null });
    const { GET } = await import("@/app/api/directory/users/route");
    const res = await GET(mkReq("/api/directory/users?search=eng&department=R%26D", "GET", "Bearer x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(mockListUsers).toHaveBeenCalledWith(
      "u",
      expect.objectContaining({ search: "eng", department: "R&D" }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/directory/users/[id]
// ---------------------------------------------------------------------------

describe("GET /api/directory/users/[id]", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/directory/users/[id]/route");
    const res = await GET(mkReq("/api/directory/users/ms1"), { params: Promise.resolve({ id: "ms1" }) });
    expect(res.status).toBe(401);
  });

  it("404 when user not found", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetUserDir.mockResolvedValue(null);
    const { GET } = await import("@/app/api/directory/users/[id]/route");
    const res = await GET(mkReq("/api/directory/users/ms1", "GET", "Bearer x"), {
      params: Promise.resolve({ id: "ms1" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 with user detail", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetUserDir.mockResolvedValue({ msUserId: "ms1", displayName: "One" });
    const { GET } = await import("@/app/api/directory/users/[id]/route");
    const res = await GET(mkReq("/api/directory/users/ms1", "GET", "Bearer x"), {
      params: Promise.resolve({ id: "ms1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.msUserId).toBe("ms1");
  });
});

// ---------------------------------------------------------------------------
// GET /api/directory/users/[id]/manager + direct-reports
// ---------------------------------------------------------------------------

describe("manager + direct-reports", () => {
  it("manager: 200 null when missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetManager.mockResolvedValue(null);
    const { GET } = await import("@/app/api/directory/users/[id]/manager/route");
    const res = await GET(mkReq("/api/directory/users/ms1/manager", "GET", "Bearer x"), {
      params: Promise.resolve({ id: "ms1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).manager).toBeNull();
  });

  it("direct-reports: returns array", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetDirectReports.mockResolvedValue([{ msUserId: "r1" }]);
    const { GET } = await import("@/app/api/directory/users/[id]/direct-reports/route");
    const res = await GET(mkReq("/api/directory/users/ms1/direct-reports", "GET", "Bearer x"), {
      params: Promise.resolve({ id: "ms1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/directory/users/[id]/ooo (cache-only)
// ---------------------------------------------------------------------------

describe("GET /api/directory/users/[id]/ooo", () => {
  it("returns cached state or null; never hits Graph", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedOOO.mockResolvedValueOnce({ userId: "u2", isEnabled: true, scope: "all" });
    const { GET } = await import("@/app/api/directory/users/[id]/ooo/route");
    const res = await GET(mkReq("/api/directory/users/u2/ooo", "GET", "Bearer x"), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ooo.isEnabled).toBe(true);
    expect(mockGetCachedOOO).toHaveBeenCalledWith("u2");
  });
});

// ---------------------------------------------------------------------------
// POST /api/directory/sync
// ---------------------------------------------------------------------------

describe("POST /api/directory/sync", () => {
  beforeEach(async () => {
    const mod = await import("@/app/api/directory/sync/route");
    mod._resetRateLimit();
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/directory/sync/route");
    const res = await POST(mkReq("/api/directory/sync", "POST"));
    expect(res.status).toBe(401);
  });

  it("syncs, emits audit, returns result", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncDirectory.mockResolvedValue({ synced: 7, durationMs: 200 });
    const { POST } = await import("@/app/api/directory/sync/route");
    const res = await POST(mkReq("/api/directory/sync", "POST", "Bearer x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBe(7);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "directory.synced",
        resourceType: "ms_directory",
        afterState: { count: 7, duration_ms: 200 },
      }),
    );
  });

  it("rate limits subsequent requests", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncDirectory.mockResolvedValue({ synced: 1, durationMs: 10 });
    const { POST } = await import("@/app/api/directory/sync/route");
    const first = await POST(mkReq("/api/directory/sync", "POST", "Bearer x"));
    expect(first.status).toBe(200);
    const second = await POST(mkReq("/api/directory/sync", "POST", "Bearer x"));
    expect(second.status).toBe(429);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.upload_rate_limited",
      "u",
      "cto",
      expect.objectContaining({ endpoint: "directory/sync" }),
    );
  });

  it("forwards scope_missing 403 from library", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncDirectory.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "User.Read.All",
    });
    const { POST } = await import("@/app/api/directory/sync/route");
    const res = await POST(mkReq("/api/directory/sync", "POST", "Bearer x"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
    expect(body.scope).toBe("User.Read.All");
  });
});
