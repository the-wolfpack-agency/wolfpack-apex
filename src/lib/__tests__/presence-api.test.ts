/**
 * /api/presence/me route tests.
 */
 

const mockGetUserPres = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUserPres(...a),
}));

const mockGetOwnPresence = jest.fn();
jest.mock("@/lib/integrations/microsoft-presence", () => ({
  getOwnPresence: (...a: unknown[]) => mockGetOwnPresence(...a),
}));

import { GET as presenceGET } from "@/app/api/presence/me/route";

function mkReq(auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://test/api/presence/me", { method: "GET", headers }) as any;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/presence/me", () => {
  it("401 without auth", async () => {
    mockGetUserPres.mockReturnValue(null);
    const res = await presenceGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("200 with presence + Cache-Control 30s", async () => {
    mockGetUserPres.mockReturnValue({ id: "u", role: "cto" });
    mockGetOwnPresence.mockResolvedValue({ availability: "Available", activity: "Available", statusMessage: null, fetchedAt: new Date().toISOString() });
    const res = await presenceGET(mkReq("Bearer x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    const data = await res.json();
    expect(data.presence.availability).toBe("Available");
  });

  it("200 with null presence passes through", async () => {
    mockGetUserPres.mockReturnValue({ id: "u", role: "cto" });
    mockGetOwnPresence.mockResolvedValue(null);
    const res = await presenceGET(mkReq("Bearer x"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.presence).toBeNull();
  });
});
