 
const mockFetchSp = jest.fn();
const mockParseDocx = jest.fn();
const mockGetLatest = jest.fn();
const mockRecordVersion = jest.fn();
const mockSync = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/principles/sharepoint-fetch", () => ({
  fetchSharePointDocx: (...a: any[]) => mockFetchSp(...a),
}));
jest.mock("@/lib/principles/parser", () => ({
  parseDocxBuffer: (...a: any[]) => mockParseDocx(...a),
}));
jest.mock("@/lib/principles/store", () => ({
  getLatestDocVersion: (...a: any[]) => mockGetLatest(...a),
  recordDocVersion: (...a: any[]) => mockRecordVersion(...a),
  syncPrinciplesFromParsed: (...a: any[]) => mockSync(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockFetchSp.mockReset();
  mockParseDocx.mockReset();
  mockGetLatest.mockReset();
  mockRecordVersion.mockReset();
  mockSync.mockReset();
  mockTrack.mockReset();
  process.env.CRON_SECRET = "secret-x";
  process.env.PRINCIPLES_DOC_URL = "https://sharepoint/x";
  process.env.PRINCIPLES_DOC_OWNER_USER_ID = "u-owner";
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function reqWith(auth?: string): NextRequest {
  return new NextRequest("https://wp.test/api/cron/principles-sync", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/cron/principles-sync", () => {
  test("401 without CRON_SECRET match", async () => {
    const res = await GET(reqWith());
    expect(res.status).toBe(401);
  });
  test("401 on wrong secret", async () => {
    const res = await GET(reqWith("Bearer wrong"));
    expect(res.status).toBe(401);
  });
  test("returns not_configured when env unset", async () => {
    delete process.env.PRINCIPLES_DOC_URL;
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.code).toBe("not_configured");
  });
  test("returns ok:false on fetch failure + emits sync_failed", async () => {
    mockFetchSp.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      message: "Files.Read",
    });
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("scope_missing");
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.sync_failed",
      "u-owner",
      "system",
      expect.objectContaining({ stage: "fetch", code: "scope_missing" }),
    );
  });
  test("hash unchanged → unchanged:true, no DB writes", async () => {
    mockFetchSp.mockResolvedValueOnce({
      ok: true,
      bytes: Buffer.from("xx"),
      etag: null,
      webUrl: null,
    });
    mockParseDocx.mockResolvedValueOnce({
      principles: [{ slug: "a" }],
      warnings: [],
      sourceHash: "H",
    });
    mockGetLatest.mockResolvedValueOnce({ docHash: "H" });
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.unchanged).toBe(true);
    expect(mockRecordVersion).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.sync_unchanged",
      "u-owner",
      "system",
      expect.objectContaining({ hash: "H", principle_count: 1 }),
    );
  });
  test("hash changed → record version + sync + sync_completed", async () => {
    mockFetchSp.mockResolvedValueOnce({
      ok: true,
      bytes: Buffer.from("xx"),
      etag: null,
      webUrl: null,
    });
    mockParseDocx.mockResolvedValueOnce({
      principles: [{ slug: "ship-before-perfect" }],
      warnings: ["warn a"],
      sourceHash: "NEW",
    });
    mockGetLatest.mockResolvedValueOnce({ docHash: "OLD" });
    mockRecordVersion.mockResolvedValueOnce({});
    mockSync.mockResolvedValueOnce({
      inserted: [{ slug: "ship-before-perfect" }],
      unchanged: [],
      retired: [{ slug: "abandoned" }],
    });
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.unchanged).toBe(false);
    expect(body.inserted).toEqual(["ship-before-perfect"]);
    expect(body.retired).toEqual(["abandoned"]);
    expect(body.warnings).toEqual(["warn a"]);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.sync_completed",
      "u-owner",
      "system",
      expect.objectContaining({ inserted: 1, retired: 1 }),
    );
  });
  test("sync error returns 500 + emits sync_failed (DB stage)", async () => {
    mockFetchSp.mockResolvedValueOnce({
      ok: true,
      bytes: Buffer.from("xx"),
      etag: null,
      webUrl: null,
    });
    mockParseDocx.mockResolvedValueOnce({
      principles: [{ slug: "x" }],
      warnings: [],
      sourceHash: "NEW",
    });
    mockGetLatest.mockResolvedValueOnce(null);
    mockRecordVersion.mockResolvedValueOnce({});
    mockSync.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(500);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.sync_failed",
      "u-owner",
      "system",
      expect.objectContaining({ stage: "sync" }),
    );
  });
});
