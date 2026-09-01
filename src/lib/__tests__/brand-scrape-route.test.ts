/**
 * /api/brand/scrape — route contract tests.
 *
 * Auth / role gate / dispatch / status-code mapping for the brand URL
 * importer endpoint. The library is mocked so we only prove the route
 * does its job (validate, auth, map result → HTTP).
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  // Real role logic — the route calls hasRole and we want the real levels.
  hasRole: (role: string, required: string) => {
    const level: Record<string, number> = {
      ceo: 5,
      cto: 5,
      hr: 4,
      dev: 3,
      ops: 2,
      sales: 1,
    };
    return (level[role] ?? 0) >= (level[required] ?? 0);
  },
}));

const mockImport = jest.fn();
jest.mock("@/lib/brand-url-import", () => ({
  importFromBrandUrl: (...args: unknown[]) => mockImport(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/brand/scrape/route";

const USER = { id: "u_1", role: "sales", name: "u", email: "u@x" };

function makeReq(body: unknown, auth = "Bearer t"): NextRequest {
  return new NextRequest("http://test/api/brand/scrape", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/brand/scrape", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(makeReq({ url: "https://x" }));
    expect(res.status).toBe(401);
    expect(mockImport).not.toHaveBeenCalled();
  });

  test("403 without sales role", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "unknown" });
    const res = await POST(makeReq({ url: "https://x" }));
    expect(res.status).toBe(403);
    expect(mockImport).not.toHaveBeenCalled();
  });

  test("400 when URL missing from body", async () => {
    mockGetUser.mockReturnValue(USER);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(mockImport).not.toHaveBeenCalled();
  });

  test("400 on invalid body (non-JSON parse)", async () => {
    mockGetUser.mockReturnValue(USER);
    const req = new NextRequest("http://test/api/brand/scrape", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test("200 on happy path — library result passthrough", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: true,
      reason: "ok",
      scraped: {
        url: "https://example.com/",
        title: "Example",
        description: null,
        ogImage: null,
        faviconUrl: null,
        themeColor: null,
        cssPalette: ["#abcdef"],
        imagePalette: [],
        fontFamilies: ["Inter"],
        latencyMs: 50,
      },
      themeSuggestion: {
        colors: { primary: "#abcdef" },
        font: { family: "Inter" },
      },
    });
    const res = await POST(makeReq({ url: "https://example.com/" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scraped.title).toBe("Example");
    expect(body.themeSuggestion.font.family).toBe("Inter");
    expect(mockImport).toHaveBeenCalledWith(
      { url: "https://example.com/" },
      expect.objectContaining({
        user: { id: "u_1", role: "sales" },
      }),
    );
  });

  test("400 when lib says invalid_url", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "invalid_url",
      scraped: null,
      themeSuggestion: null,
    });
    const res = await POST(makeReq({ url: "not a url" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_url");
  });

  test("504 when lib returns timeout reason", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "timeout",
      scraped: null,
      themeSuggestion: null,
    });
    const res = await POST(makeReq({ url: "https://slow.example/" }));
    expect(res.status).toBe(504);
  });

  test("200 (not 5xx) on library soft failures like empty_result", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "empty_result",
      scraped: {
        url: "https://meh.example/",
        title: null,
        description: null,
        ogImage: null,
        faviconUrl: null,
        themeColor: null,
        cssPalette: [],
        imagePalette: [],
        fontFamilies: [],
        latencyMs: 10,
      },
      themeSuggestion: null,
    });
    const res = await POST(makeReq({ url: "https://meh.example/" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty_result");
  });

  test("passes user-id + role into lib for analytics attribution", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: true,
      reason: "ok",
      scraped: null,
      themeSuggestion: {},
    });
    await POST(makeReq({ url: "https://example.com/" }));
    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/" }),
      expect.objectContaining({
        user: { id: "u_1", role: "sales" },
      }),
    );
  });

  test("ceo role also authorized", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "ceo" });
    mockImport.mockResolvedValue({
      ok: true,
      reason: "ok",
      scraped: null,
      themeSuggestion: {},
    });
    const res = await POST(makeReq({ url: "https://example.com/" }));
    expect(res.status).toBe(200);
  });

  test("ops role (level=2, >= sales) authorized", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "ops" });
    mockImport.mockResolvedValue({
      ok: true,
      reason: "ok",
      scraped: null,
      themeSuggestion: {},
    });
    const res = await POST(makeReq({ url: "https://example.com/" }));
    expect(res.status).toBe(200);
  });
});
