/**
 * /api/groups + /api/groups/sync route tests.
 *
 * Covers auth, rate limit, analytics + audit on mutation, scope_missing
 * translation, 429 passthrough.
 */
 

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

const mockList = jest.fn();
const mockSync = jest.fn();
jest.mock("@/lib/integrations/microsoft-groups", () => ({
  listMyGroups: (...args: unknown[]) => mockList(...args),
  syncGroups: (...args: unknown[]) => mockSync(...args),
}));

import { GET as groupsGET } from "@/app/api/groups/route";
import { POST as syncPOST, _resetRateLimit } from "@/app/api/groups/sync/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string; method?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/groups", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
  _resetRateLimit();
});

describe("GET /api/groups", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await groupsGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns groups + fires page_viewed analytics", async () => {
    mockList.mockResolvedValueOnce({
      groups: [{ id: "g", displayName: "T" }],
      nextCursor: null,
    });
    const res = await groupsGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.groups).toHaveLength(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.page_viewed",
      "u1",
      "cto",
      expect.objectContaining({ endpoint: "groups.list" }),
    );
  });
});

describe("POST /api/groups/sync", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await syncPOST(mkReq({ method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("calls syncGroups + records audit on success", async () => {
    mockSync.mockResolvedValueOnce({ ok: true, value: { count: 3, durationMs: 120 } });
    const res = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(3);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "groups.synced",
      resourceType: "ms_groups",
    }));
  });

  it("403 on scope_missing", async () => {
    mockSync.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Group.Read.All", message: "nope",
    });
    const res = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("429 when called twice within window", async () => {
    mockSync.mockResolvedValue({ ok: true, value: { count: 0, durationMs: 1 } });
    const first = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(first.status).toBe(200);
    const second = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(second.status).toBe(429);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.upload_rate_limited",
      "u1",
      "cto",
      expect.objectContaining({ endpoint: "groups/sync" }),
    );
  });
});
