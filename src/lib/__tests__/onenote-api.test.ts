/**
 * /api/onenote route tests — auth, rate limit, audit on mutation,
 * scope_missing, analytics.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockListNotebooks = jest.fn();
const mockListSections = jest.fn();
const mockListCachedPages = jest.fn();
const mockCreatePage = jest.fn();
const mockGetPageContent = jest.fn();
const mockSyncRecent = jest.fn();
const mockAsScopeMissing = jest.fn();

class FakeOneNoteError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, msg: string, retryAfter?: number) {
    super(msg);
    this.name = "OneNoteError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

jest.mock("@/lib/integrations/microsoft-onenote", () => ({
  listNotebooks: (...a: unknown[]) => mockListNotebooks(...a),
  listSections: (...a: unknown[]) => mockListSections(...a),
  listCachedPages: (...a: unknown[]) => mockListCachedPages(...a),
  createPage: (...a: unknown[]) => mockCreatePage(...a),
  getPageContent: (...a: unknown[]) => mockGetPageContent(...a),
  syncRecentPages: (...a: unknown[]) => mockSyncRecent(...a),
  asScopeMissing: (...a: unknown[]) => mockAsScopeMissing(...a),
  OneNoteError: FakeOneNoteError,
}));

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
  query: jest.fn(),
}));

import { GET as notebooksGET } from "@/app/api/onenote/notebooks/route";
import { GET as sectionsGET } from "@/app/api/onenote/sections/route";
import {
  GET as pagesGET,
  POST as pagesPOST,
} from "@/app/api/onenote/pages/route";
import { GET as pageContentGET } from "@/app/api/onenote/pages/[id]/route";
import {
  POST as syncPOST,
  _resetRateLimit as resetOneNoteRate,
} from "@/app/api/onenote/sync/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string; method?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/onenote/notebooks", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOneNoteRate();
  mockAsScopeMissing.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// notebooks
// ---------------------------------------------------------------------------

describe("GET /api/onenote/notebooks", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await notebooksGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns notebooks", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListNotebooks.mockResolvedValue([{ id: "n1", displayName: "Work" }]);
    const res = await notebooksGET(mkReq({ auth: "Bearer x" }));
    const data = await res.json();
    expect(data.notebooks).toHaveLength(1);
  });

  it("403 scope_missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListNotebooks.mockRejectedValue(new FakeOneNoteError(403, "missing"));
    mockAsScopeMissing.mockReturnValueOnce({ ok: false, code: "scope_missing", scope: "Notes.ReadWrite" });
    const res = await notebooksGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
  });
});

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

describe("GET /api/onenote/sections", () => {
  it("passes notebookId to listSections", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListSections.mockResolvedValue([]);
    await sectionsGET(mkReq({ auth: "Bearer x", url: "http://test/api/onenote/sections?notebookId=n1" }));
    expect(mockListSections).toHaveBeenCalledWith("u", "n1");
  });
});

// ---------------------------------------------------------------------------
// pages GET + POST
// ---------------------------------------------------------------------------

describe("GET /api/onenote/pages", () => {
  it("returns cached pages", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListCachedPages.mockResolvedValue({ pages: [{ id: "p1" }], nextCursor: null });
    const res = await pagesGET(mkReq({ auth: "Bearer x", url: "http://test/api/onenote/pages?sectionId=s1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pages).toHaveLength(1);
  });
});

describe("POST /api/onenote/pages", () => {
  it("400 when body missing sectionId/title", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    const res = await pagesPOST(mkReq({ method: "POST", auth: "Bearer x", body: { title: "x" } }));
    expect(res.status).toBe(400);
  });

  it("creates and returns page", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreatePage.mockResolvedValue({ id: "p1", webUrl: "https://x" });
    const res = await pagesPOST(mkReq({
      method: "POST", auth: "Bearer x",
      body: { sectionId: "s1", title: "New", html: "<p>Hi</p>" },
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.page.id).toBe("p1");
  });

  it("403 scope_missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreatePage.mockRejectedValue(new FakeOneNoteError(403, "missing"));
    mockAsScopeMissing.mockReturnValueOnce({ ok: false, code: "scope_missing", scope: "Notes.ReadWrite" });
    const res = await pagesPOST(mkReq({
      method: "POST", auth: "Bearer x",
      body: { sectionId: "s1", title: "t" },
    }));
    expect(res.status).toBe(403);
  });

  it("502 on graph 500", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreatePage.mockRejectedValue(new FakeOneNoteError(500, "boom"));
    const res = await pagesPOST(mkReq({
      method: "POST", auth: "Bearer x",
      body: { sectionId: "s1", title: "t" },
    }));
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// page content
// ---------------------------------------------------------------------------

describe("GET /api/onenote/pages/[id]", () => {
  it("returns raw HTML body", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetPageContent.mockResolvedValue("<html>ok</html>");
    const res = await pageContentGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

// ---------------------------------------------------------------------------
// onenote sync
// ---------------------------------------------------------------------------

describe("POST /api/onenote/sync", () => {
  it("runs + returns result", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncRecent.mockResolvedValue({ pageCount: 5, durationMs: 50 });
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(200);
  });

  it("rate-limited after first call", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncRecent.mockResolvedValue({ pageCount: 0, durationMs: 1 });
    await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(429);
  });
});
