/**
 * /api/figma/import — route contract tests.
 *
 * Auth, role gate, dispatch, and status-code mapping for the Figma URL
 * importer endpoint. The library is mocked so we only prove the route
 * does its job.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
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
jest.mock("@/lib/figma-import", () => ({
  importFromFigmaUrl: (...args: unknown[]) => mockImport(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/figma/import/route";

const USER = { id: "u_1", role: "sales", name: "u", email: "u@x" };

function makeReq(body: unknown, auth = "Bearer t"): NextRequest {
  return new NextRequest("http://test/api/figma/import", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/figma/import", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(401);
    expect(mockImport).not.toHaveBeenCalled();
  });

  test("403 without sales role", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "unknown" });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(403);
    expect(mockImport).not.toHaveBeenCalled();
  });

  test("400 when URL missing from body", async () => {
    mockGetUser.mockReturnValue(USER);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(mockImport).not.toHaveBeenCalled();
  });

  test("400 on non-JSON body", async () => {
    mockGetUser.mockReturnValue(USER);
    const req = new NextRequest("http://test/api/figma/import", {
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

  test("400 when library says invalid_url", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "invalid_url",
      scraped: null,
      briefSuggestion: null,
    });
    const res = await POST(makeReq({ url: "not a url" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_url");
  });

  test("503 when library says not_configured (missing env var)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "not_configured",
      scraped: null,
      briefSuggestion: null,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/FIGMA_ACCESS_TOKEN/);
  });

  test("403 when library says unauthorized (token rejected)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "unauthorized",
      scraped: null,
      briefSuggestion: null,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(403);
  });

  test("404 when library says file_not_found", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "file_not_found",
      scraped: null,
      briefSuggestion: null,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/MISSING/slug" }),
    );
    expect(res.status).toBe(404);
  });

  test("429 with Retry-After when library says rate_limited", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "rate_limited",
      scraped: null,
      briefSuggestion: null,
      retryAfterSeconds: 42,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
  });

  test("504 when library says timeout", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "timeout",
      scraped: null,
      briefSuggestion: null,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(504);
  });

  test("502 when library says fetch_failed", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "fetch_failed",
      scraped: null,
      briefSuggestion: null,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(502);
  });

  test("200 on happy path — library result passthrough", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: true,
      reason: "ok",
      scraped: {
        fileKey: "ABC",
        fileName: "Acme",
        lastModified: "2026-04-19T00:00:00Z",
        topLevelFrames: [],
        colors: ["#ff8800"],
        fonts: [{ family: "Inter", weights: [400, 700] }],
        suggestedBriefPages: [],
        latencyMs: 100,
      },
      briefSuggestion: {
        theme: { colors: { primary: "#ff8800" }, font: { family: "Inter" } },
        pages: [],
      },
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scraped.fileKey).toBe("ABC");
    expect(body.briefSuggestion.theme.font.family).toBe("Inter");
    expect(mockImport).toHaveBeenCalledWith(
      { url: "https://www.figma.com/file/ABC/slug" },
      expect.objectContaining({ user: { id: "u_1", role: "sales" } }),
    );
  });

  test("200 on empty_result soft failure (UI handles the copy)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockImport.mockResolvedValue({
      ok: false,
      reason: "empty_result",
      scraped: {
        fileKey: "ABC",
        fileName: "Blank",
        lastModified: "",
        topLevelFrames: [],
        colors: [],
        fonts: [],
        suggestedBriefPages: [],
        latencyMs: 10,
      },
      briefSuggestion: null,
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty_result");
  });

  test("ceo role also authorised", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "ceo" });
    mockImport.mockResolvedValue({
      ok: true,
      reason: "ok",
      scraped: null,
      briefSuggestion: {},
    });
    const res = await POST(
      makeReq({ url: "https://www.figma.com/file/ABC/slug" }),
    );
    expect(res.status).toBe(200);
  });
});
