/**
 * Microsoft OneNote integration tests.
 *
 * Covers listNotebooks, listSections, listPages, getPageContent,
 * createPage (audit + analytics + RAG ingest), syncRecentPages, 403
 * scope_missing, cache upsert, 429 retry.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetValidToken = jest.fn();
const mockRecordAudit = jest.fn();
const mockIndexOneNotePage = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAudit(...args),
}));
jest.mock("@/lib/learning/ms-content-ingest", () => ({
  indexOneNotePage: (...args: any[]) => mockIndexOneNotePage(...args),
  indexTeamsMessage: jest.fn(),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok", userEmail: "u@x" });
  mockQuery.mockResolvedValue({ rows: [{ id: "uuid" }] });
  mockRecordAudit.mockResolvedValue({ id: "audit-1", seq: 1, entryHash: "hash" });
  mockIndexOneNotePage.mockResolvedValue(undefined);
});

function okJson(data: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function okText(text: string): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
  };
}
function errResponse(status: number, text = "err", headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  };
}

// ---------------------------------------------------------------------------
// listNotebooks / listSections
// ---------------------------------------------------------------------------

describe("listNotebooks", () => {
  it("calls /me/onenote/notebooks and emits analytics", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ id: "n1", displayName: "Work" }] }));
    const { listNotebooks } = await import("@/lib/integrations/microsoft-onenote");
    const out = await listNotebooks("u");
    expect(out).toHaveLength(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_onenote_notebook_listed",
      "u",
      "system",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("throws OneNoteError when no token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { listNotebooks, OneNoteError } = await import("@/lib/integrations/microsoft-onenote");
    await expect(listNotebooks("u")).rejects.toBeInstanceOf(OneNoteError);
  });
});

describe("listSections", () => {
  it("scopes to the given notebookId", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ id: "s1", displayName: "Notes" }] }));
    const { listSections } = await import("@/lib/integrations/microsoft-onenote");
    const sections = await listSections("u", "notebook-123");
    expect(sections).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain("notebooks/notebook-123/sections");
    expect(sections[0].notebookId).toBe("notebook-123");
  });
});

// ---------------------------------------------------------------------------
// listPages — warms cache
// ---------------------------------------------------------------------------

describe("listPages", () => {
  it("fetches pages + upserts cache shells", async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      value: [{ id: "p1", title: "Hello", lastModifiedDateTime: "2026-04-15T10:00:00Z" }],
    }));
    const { listPages } = await import("@/lib/integrations/microsoft-onenote");
    const out = await listPages("u", "sec-1");
    expect(out.pages).toHaveLength(1);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /ON CONFLICT/i.test(s) && /instinct_onenote_pages/.test(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPageContent
// ---------------------------------------------------------------------------

describe("getPageContent", () => {
  it("returns HTML and emits page_viewed", async () => {
    fetchMock.mockResolvedValueOnce(okText("<html><body>Hi</body></html>"));
    const { getPageContent } = await import("@/lib/integrations/microsoft-onenote");
    const html = await getPageContent("u", "p1");
    expect(html).toContain("Hi");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_onenote_page_viewed",
      "u",
      "system",
      expect.objectContaining({ ms_page_id: "p1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// createPage — audit + analytics + RAG
// ---------------------------------------------------------------------------

describe("createPage", () => {
  it("POSTs envelope, upserts cache, records audit, emits analytics, indexes RAG", async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      id: "p-new",
      title: "Notes",
      links: { oneNoteWebUrl: { href: "https://onenote/p-new" } },
    }));

    const { createPage } = await import("@/lib/integrations/microsoft-onenote");
    const res = await createPage("u", "sec-1", { title: "Notes", html: "<p>Body</p>" });

    expect(res.id).toBe("p-new");
    expect(res.webUrl).toBe("https://onenote/p-new");

    // POST to /me/onenote/sections/sec-1/pages
    const fetchUrl = fetchMock.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("me/onenote/sections/sec-1/pages");

    // Upsert
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /ON CONFLICT/i.test(s) && /instinct_onenote_pages/.test(s))).toBe(true);

    // Audit
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "onenote.page_created",
        resourceType: "onenote_page",
        resourceId: "p-new",
      }),
    );

    // Analytics
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_onenote_page_created",
      "u",
      "system",
      expect.objectContaining({ ms_page_id: "p-new", ms_section_id: "sec-1" }),
    );

    // RAG ingest
    expect(mockIndexOneNotePage).toHaveBeenCalledWith("u", expect.objectContaining({
      msPageId: "p-new",
      title: "Notes",
    }));
  });

  it("continues + emits indexing_failed when RAG ingest fails", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "p1", title: "X" }));
    mockIndexOneNotePage.mockRejectedValueOnce(new Error("qdrant down"));
    const { createPage } = await import("@/lib/integrations/microsoft-onenote");
    const res = await createPage("u", "sec-1", { title: "X", html: "<p>Hi</p>" });
    expect(res.id).toBe("p1");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_teams_sync_indexing_failed",
      "u",
      "system",
      expect.objectContaining({ ms_page_id: "p1", source: "onenote" }),
    );
  });

  it("audit + analytics emit even if cache upsert fails", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "p1", title: "X" }));
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const { createPage } = await import("@/lib/integrations/microsoft-onenote");
    await createPage("u", "sec-1", { title: "X", html: "" });
    expect(mockRecordAudit).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_onenote_page_created",
      "u",
      "system",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// syncRecentPages
// ---------------------------------------------------------------------------

describe("syncRecentPages", () => {
  it("fetches recent pages, upserts, feeds each to RAG", async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      value: [
        { id: "p1", title: "A", lastModifiedDateTime: "2026-04-15T10:00:00Z" },
        { id: "p2", title: "B", lastModifiedDateTime: "2026-04-14T10:00:00Z" },
      ],
    }));
    const { syncRecentPages } = await import("@/lib/integrations/microsoft-onenote");
    const res = await syncRecentPages("u", { top: 10 });
    expect(res.pageCount).toBe(2);
    expect(mockIndexOneNotePage).toHaveBeenCalledTimes(2);
  });

  it("emits system.ms_onenote_failed + re-throws on error", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(500, "boom"));
    const { syncRecentPages, OneNoteError } = await import("@/lib/integrations/microsoft-onenote");
    await expect(syncRecentPages("u")).rejects.toBeInstanceOf(OneNoteError);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_onenote_failed",
      "u",
      "system",
      expect.objectContaining({ op: "sync_recent", http_status: 500 }),
    );
  });
});

// ---------------------------------------------------------------------------
// 429 + 403
// ---------------------------------------------------------------------------

describe("OneNote error handling", () => {
  it("honors 429 Retry-After once", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(okJson({ value: [] }));
    const { listNotebooks } = await import("@/lib/integrations/microsoft-onenote");
    const out = await listNotebooks("u");
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asScopeMissing translates 403", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403, "missing"));
    const { listNotebooks, asScopeMissing } = await import("@/lib/integrations/microsoft-onenote");
    try {
      await listNotebooks("u");
      fail("should throw");
    } catch (err) {
      expect(asScopeMissing(err, "Notes.ReadWrite")).toEqual({
        ok: false,
        code: "scope_missing",
        scope: "Notes.ReadWrite",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Cache reads
// ---------------------------------------------------------------------------

describe("listCachedPages", () => {
  it("filters by sectionId + search", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { listCachedPages } = await import("@/lib/integrations/microsoft-onenote");
    await listCachedPages("u", { sectionId: "s1", search: "budget" });
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/ms_section_id = \$\d+/);
    expect(sql).toMatch(/ILIKE/);
  });
});
