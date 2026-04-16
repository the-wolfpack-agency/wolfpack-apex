/**
 * Mailbox API routes — auth, rate limit, audit on refresh.
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

const mockGetCachedOOO = jest.fn();
const mockRefreshOOO = jest.fn();
jest.mock("@/lib/integrations/microsoft-mailbox", () => ({
  getCachedOOOState: (...a: unknown[]) => mockGetCachedOOO(...a),
  refreshOwnOOOState: (...a: unknown[]) => mockRefreshOOO(...a),
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
// GET /api/mailbox/me/ooo
// ---------------------------------------------------------------------------

describe("GET /api/mailbox/me/ooo", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/mailbox/me/ooo/route");
    const res = await GET(mkReq("/api/mailbox/me/ooo"));
    expect(res.status).toBe(401);
  });

  it("returns cached state + cache-control", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedOOO.mockResolvedValue({ userId: "u", isEnabled: true, scope: "external" });
    const { GET } = await import("@/app/api/mailbox/me/ooo/route");
    const res = await GET(mkReq("/api/mailbox/me/ooo", "GET", "Bearer x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    const body = await res.json();
    expect(body.ooo.isEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mailbox/me/refresh-ooo
// ---------------------------------------------------------------------------

describe("POST /api/mailbox/me/refresh-ooo", () => {
  beforeEach(async () => {
    const mod = await import("@/app/api/mailbox/me/refresh-ooo/route");
    mod._resetRateLimit();
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/mailbox/me/refresh-ooo/route");
    const res = await POST(mkReq("/api/mailbox/me/refresh-ooo", "POST"));
    expect(res.status).toBe(401);
  });

  it("refreshes, records audit with before/after, returns state", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedOOO.mockResolvedValueOnce({ isEnabled: false, scope: "none" });
    mockRefreshOOO.mockResolvedValue({ userId: "u", isEnabled: true, scope: "all" });
    const { POST } = await import("@/app/api/mailbox/me/refresh-ooo/route");
    const res = await POST(mkReq("/api/mailbox/me/refresh-ooo", "POST", "Bearer x"));
    expect(res.status).toBe(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mailbox.ooo_refreshed",
        beforeState: { is_enabled: false, scope: "none" },
        afterState: { is_enabled: true, scope: "all" },
      }),
    );
  });

  it("rate limits second refresh", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedOOO.mockResolvedValue(null);
    mockRefreshOOO.mockResolvedValue(null);
    const { POST } = await import("@/app/api/mailbox/me/refresh-ooo/route");
    const first = await POST(mkReq("/api/mailbox/me/refresh-ooo", "POST", "Bearer x"));
    expect(first.status).toBe(200);
    const second = await POST(mkReq("/api/mailbox/me/refresh-ooo", "POST", "Bearer x"));
    expect(second.status).toBe(429);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.upload_rate_limited",
      "u",
      "cto",
      expect.objectContaining({ endpoint: "mailbox/refresh-ooo" }),
    );
  });
});
