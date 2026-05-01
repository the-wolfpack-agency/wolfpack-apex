/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetNavPrefs = jest.fn();
const mockSetNavPrefs = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x",
};

jest.mock("@/lib/user-nav-prefs", () => ({
  getNavPrefs: (...a: any[]) => mockGetNavPrefs(...a),
  setNavPrefs: (...a: any[]) => mockSetNavPrefs(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET, PUT } from "../route";

beforeEach(() => {
  mockGetNavPrefs.mockReset();
  mockSetNavPrefs.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x" };
});

function req(method: "GET" | "PUT", body?: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://wp.test/api/user-nav-prefs", {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/user-nav-prefs", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(req("GET", undefined, ""));
    expect(res.status).toBe(401);
  });
  test("returns hiddenHrefs from lib", async () => {
    mockGetNavPrefs.mockResolvedValueOnce({
      userId: "u1",
      hiddenHrefs: ["/sites"],
      updatedAt: "2026-05-01",
    });
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hiddenHrefs).toEqual(["/sites"]);
    expect(mockGetNavPrefs).toHaveBeenCalledWith("u1");
  });
});

describe("PUT /api/user-nav-prefs", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await PUT(req("PUT", { hiddenHrefs: [] }, ""));
    expect(res.status).toBe(401);
  });
  test("400 on invalid JSON", async () => {
    const r = new NextRequest("https://wp.test/api/user-nav-prefs", {
      method: "PUT",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "not json",
    });
    const res = await PUT(r);
    expect(res.status).toBe(400);
  });
  test("saves valid hiddenHrefs and emits analytics", async () => {
    mockSetNavPrefs.mockResolvedValueOnce({
      userId: "u1",
      hiddenHrefs: ["/sites"],
      updatedAt: "2026-05-01",
    });
    const res = await PUT(req("PUT", { hiddenHrefs: ["/sites"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hiddenHrefs).toEqual(["/sites"]);
    expect(mockSetNavPrefs).toHaveBeenCalledWith("u1", ["/sites"]);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "user.nav_pref_updated",
      "u1",
      "ceo",
      expect.objectContaining({ hidden_count: 1, hidden_hrefs: "/sites" }),
    );
  });
  test("returns 400 with the validation message on bad input", async () => {
    mockSetNavPrefs.mockRejectedValueOnce(new Error("unknown nav href: /bogus"));
    const res = await PUT(req("PUT", { hiddenHrefs: ["/bogus"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown nav href/);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
  test("treats missing/non-array hiddenHrefs as empty array (no-op save)", async () => {
    mockSetNavPrefs.mockResolvedValueOnce({
      userId: "u1",
      hiddenHrefs: [],
      updatedAt: "2026-05-01",
    });
    const res = await PUT(req("PUT", {}));
    expect(res.status).toBe(200);
    expect(mockSetNavPrefs).toHaveBeenCalledWith("u1", []);
  });
});
