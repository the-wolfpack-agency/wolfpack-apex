 
const mockResolve = jest.fn();
const mockFetch = jest.fn();
const mockParse = jest.fn();
const mockSync = jest.fn();
const mockGetLatest = jest.fn();
const mockRecord = jest.fn();
const mockTrack = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u-cto",
  role: "cto",
  name: "Nick",
  email: "n@x",
};

jest.mock("@/lib/principles/config", () => ({
  resolvePrinciplesConfig: (...a: any[]) => mockResolve(...a),
}));
jest.mock("@/lib/principles/sharepoint-fetch", () => ({
  fetchSharePointDocx: (...a: any[]) => mockFetch(...a),
}));
jest.mock("@/lib/principles/parser", () => ({
  parseDocxBuffer: (...a: any[]) => mockParse(...a),
}));
jest.mock("@/lib/principles/store", () => ({
  syncPrinciplesFromParsed: (...a: any[]) => mockSync(...a),
  recordDocVersion: (...a: any[]) => mockRecord(...a),
  getLatestDocVersion: (...a: any[]) => mockGetLatest(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

beforeEach(() => {
  mockResolve.mockReset();
  mockFetch.mockReset();
  mockParse.mockReset();
  mockSync.mockReset();
  mockGetLatest.mockReset();
  mockRecord.mockReset();
  mockTrack.mockReset();
  authUser = { id: "u-cto", role: "cto", name: "Nick", email: "n@x" };
});

const req = () =>
  new NextRequest("https://wp.test/api/principles/sync-now", {
    method: "POST",
    headers: { authorization: "Bearer x" },
  });

describe("POST /api/principles/sync-now", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    expect((await POST(req())).status).toBe(401);
  });
  test("403 non-leadership", async () => {
    authUser = { id: "u1", role: "sales", name: "x", email: "x" };
    expect((await POST(req())).status).toBe(403);
  });
  test("not_configured when no config", async () => {
    mockResolve.mockResolvedValueOnce(null);
    const body = await (await POST(req())).json();
    expect(body.code).toBe("not_configured");
  });
  test("hash unchanged → unchanged: true, no record/sync", async () => {
    mockResolve.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: "u",
      ownerAutoDetected: false,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      bytes: Buffer.from("xx"),
      etag: null,
      webUrl: null,
    });
    mockParse.mockResolvedValueOnce({
      principles: [{ slug: "x" }],
      warnings: [],
      sourceHash: "H",
    });
    mockGetLatest.mockResolvedValueOnce({ docHash: "H" });
    const body = await (await POST(req())).json();
    expect(body.unchanged).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });
  test("changed → records + syncs + emits sync_completed", async () => {
    mockResolve.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: "u",
      ownerAutoDetected: false,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      bytes: Buffer.from("xx"),
      etag: null,
      webUrl: null,
    });
    mockParse.mockResolvedValueOnce({
      principles: [{ slug: "respect-off-hours" }],
      warnings: [],
      sourceHash: "NEW",
    });
    mockGetLatest.mockResolvedValueOnce({ docHash: "OLD" });
    mockRecord.mockResolvedValueOnce({});
    mockSync.mockResolvedValueOnce({
      inserted: [{ slug: "respect-off-hours" }],
      unchanged: [],
      retired: [],
    });
    const body = await (await POST(req())).json();
    expect(body.ok).toBe(true);
    expect(body.inserted).toEqual(["respect-off-hours"]);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.sync_completed",
      "u-cto",
      "cto",
      expect.objectContaining({ inserted: 1, triggered: "manual" }),
    );
  });
  test("fetch failure surfaces code + emits sync_failed", async () => {
    mockResolve.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: "u",
      ownerAutoDetected: false,
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      message: "Files.Read",
    });
    const body = await (await POST(req())).json();
    expect(body.code).toBe("scope_missing");
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.sync_failed",
      "u-cto",
      "cto",
      expect.objectContaining({ stage: "fetch" }),
    );
  });
});
