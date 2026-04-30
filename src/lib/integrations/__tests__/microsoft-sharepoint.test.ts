/**
 * microsoft-sharepoint integration tests.
 *
 * Covers searchSharePoint shape mapping + topN cap, getSharePointFileText
 * decoding + truncation flag, and 403 -> typed scope_missing (never throws).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = realFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
});

function ok(data: unknown, headers: Record<string, string> = {}, status = 200): any {
  return {
    ok: true,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}
function okBytes(buf: ArrayBuffer, headers: Record<string, string> = {}, status = 200): any {
  return {
    ok: true,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: () => Promise.resolve(buf),
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(""),
  };
}
function err(status: number, body: any = {}, headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

// ---------------------------------------------------------------------------
// searchSharePoint
// ---------------------------------------------------------------------------

describe("toWebViewerUrl", () => {
  /* Late require so the module is loaded with the mocked analytics import. */
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { toWebViewerUrl } = require("@/lib/integrations/microsoft-sharepoint");

  test.each([
    ["https://wpa.sharepoint.com/sites/x/Shared%20Documents/file.docx",
     "https://wpa.sharepoint.com/sites/x/Shared%20Documents/file.docx?web=1"],
    ["https://wpa.sharepoint.com/sites/x/Shared%20Documents/file.xlsx",
     "https://wpa.sharepoint.com/sites/x/Shared%20Documents/file.xlsx?web=1"],
    ["https://wpa.sharepoint.com/sites/x/Shared%20Documents/file.pptx",
     "https://wpa.sharepoint.com/sites/x/Shared%20Documents/file.pptx?web=1"],
  ])("%p forces SharePoint online viewer", (input, expected) => {
    expect(toWebViewerUrl(input)).toBe(expected);
  });

  test("appends with & when URL already has a query string", () => {
    expect(
      toWebViewerUrl(
        "https://wpa.sharepoint.com/sites/x/file.docx?source=share",
      ),
    ).toBe("https://wpa.sharepoint.com/sites/x/file.docx?source=share&web=1");
  });

  test("idempotent — never adds web=1 twice", () => {
    const u =
      "https://wpa.sharepoint.com/sites/x/file.docx?source=share&web=1";
    expect(toWebViewerUrl(u)).toBe(u);
  });

  test("non-Office files (PDF, page links) pass through unchanged", () => {
    expect(toWebViewerUrl("https://wpa.sharepoint.com/sites/x/file.pdf"))
      .toBe("https://wpa.sharepoint.com/sites/x/file.pdf");
    expect(toWebViewerUrl("https://wpa.sharepoint.com/sites/x/SitePages/Home.aspx"))
      .toBe("https://wpa.sharepoint.com/sites/x/SitePages/Home.aspx");
  });

  test("preserves URL fragments", () => {
    expect(
      toWebViewerUrl("https://wpa.sharepoint.com/sites/x/file.docx#page=2"),
    ).toBe("https://wpa.sharepoint.com/sites/x/file.docx?web=1#page=2");
  });

  test("empty string returns empty", () => {
    expect(toWebViewerUrl("")).toBe("");
  });
});

describe("searchSharePoint", () => {
  it("maps Graph /search/query response to SharePointSearchHit[] with correct kinds", async () => {
    fetchMock.mockResolvedValueOnce(ok({
      value: [{
        hitsContainers: [{
          total: 2,
          hits: [
            {
              hitId: "h1",
              summary: "<b>HR</b> handbook 2026 - PTO policy section.",
              resource: {
                "@odata.type": "#microsoft.graph.driveItem",
                id: "drive-item-1",
                name: "HR Handbook 2026.docx",
                webUrl: "https://contoso.sharepoint.com/Shared%20Documents/HR%20Handbook.docx",
                lastModifiedDateTime: "2026-04-01T00:00:00Z",
                parentReference: { driveId: "b!drive-1" },
              },
            },
            {
              hitId: "h2",
              summary: "Pricing FAQ updated April 2026",
              resource: {
                "@odata.type": "#microsoft.graph.listItem",
                id: "list-item-2",
                title: "Pricing FAQ",
                webUrl: "https://contoso.sharepoint.com/Lists/FAQ/Item.aspx",
                lastModifiedDateTime: "2026-04-15T00:00:00Z",
              },
            },
          ],
        }],
      }],
    }));

    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await searchSharePoint("tok", { query: "PTO" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.hits).toHaveLength(2);
    expect(r.value.total).toBe(2);

    const doc = r.value.hits[0];
    expect(doc.title).toBe("HR Handbook 2026.docx");
    expect(doc.source_kind).toBe("sharepoint_doc");
    expect(doc.driveItemId).toBe("drive-item-1");
    expect(doc.driveId).toBe("b!drive-1");
    // HTML in summary should be stripped.
    expect(doc.snippet).not.toContain("<b>");
    expect(doc.snippet).toContain("HR");

    const listItem = r.value.hits[1];
    expect(listItem.source_kind).toBe("sharepoint_list_item");
    expect(listItem.driveItemId).toBeUndefined();
  });

  it("caps results at topN", async () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({
      hitId: `h${i}`,
      summary: `summary ${i}`,
      resource: {
        "@odata.type": "#microsoft.graph.driveItem",
        id: `id${i}`,
        name: `file ${i}`,
        webUrl: `https://contoso.sharepoint.com/${i}`,
        parentReference: { driveId: "d1" },
      },
    }));
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ hitsContainers: [{ total: 30, hits }] }],
    }));
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await searchSharePoint("tok", { query: "x", topN: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.hits).toHaveLength(5);
  });

  it("clamps caller-supplied topN to the cap", async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: [{ hitsContainers: [{ hits: [] }] }] }));
    const { searchSharePoint, __internal } = await import("@/lib/integrations/microsoft-sharepoint");
    await searchSharePoint("tok", { query: "x", topN: 999 });
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The size sent to Graph should never exceed TOP_N_CAP.
    expect(sentBody.requests[0].size).toBeLessThanOrEqual(__internal.TOP_N_CAP);
  });

  it("rejects empty query as invalid_input", async () => {
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await searchSharePoint("tok", { query: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns scope_missing on 403 with Sites.Read.All scope, never throws", async () => {
    fetchMock.mockResolvedValueOnce(err(403, {
      error: { code: "AccessDenied", message: "missing permission" },
    }));
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await searchSharePoint("tok", { query: "anything" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("scope_missing");
    expect(r.scope).toBe("Sites.Read.All");
  });

  it("returns not_connected on 401", async () => {
    fetchMock.mockResolvedValueOnce(err(401, {}));
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await searchSharePoint("tok", { query: "anything" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("not_connected");
  });

  it("returns rate_limited on 429 honoring Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(err(429, {}, { "retry-after": "3" }));
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await searchSharePoint("tok", { query: "anything" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("rate_limited");
    expect(r.retryAfter).toBe(3);
  });

  it("scopes query when siteId is provided", async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: [{ hitsContainers: [{ hits: [] }] }] }));
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    await searchSharePoint("tok", { query: "policy", siteId: "contoso.sharepoint.com,abc,def" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.requests[0].query.queryString).toContain("site:");
    expect(body.requests[0].query.queryString).toContain("contoso.sharepoint.com");
  });
});

// ---------------------------------------------------------------------------
// getSharePointFileText
// ---------------------------------------------------------------------------

describe("getSharePointFileText", () => {
  it("decodes UTF-8 bytes and reports truncated=false for short content", async () => {
    const text = "Hello, SharePoint world.\nLine two.";
    const buf = new TextEncoder().encode(text).buffer;
    fetchMock.mockResolvedValueOnce(okBytes(buf));
    const { getSharePointFileText } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await getSharePointFileText("tok", "drive-1", "item-1");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.text).toContain("SharePoint world");
    expect(r.value.truncated).toBe(false);
  });

  it("flags truncated=true when server returns 206 Partial Content", async () => {
    const buf = new TextEncoder().encode("partial...").buffer;
    fetchMock.mockResolvedValueOnce(okBytes(buf, { "content-range": "bytes 0-9/100000" }, 206));
    const { getSharePointFileText } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await getSharePointFileText("tok", "d", "i");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.truncated).toBe(true);
  });

  it("hard-caps to FILE_TEXT_BYTE_CAP when server ignores Range", async () => {
    const { __internal } = await import("@/lib/integrations/microsoft-sharepoint");
    const huge = new Uint8Array(__internal.FILE_TEXT_BYTE_CAP * 2).fill(65); // 'A'
    fetchMock.mockResolvedValueOnce(okBytes(huge.buffer));
    const { getSharePointFileText } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await getSharePointFileText("tok", "d", "i");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.text.length).toBeLessThanOrEqual(__internal.FILE_TEXT_BYTE_CAP);
    expect(r.value.truncated).toBe(true);
  });

  it("returns scope_missing on 403 with Files.Read.All scope, never throws", async () => {
    fetchMock.mockResolvedValueOnce(err(403, {
      error: { code: "AccessDenied", message: "no scope" },
    }));
    const { getSharePointFileText } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await getSharePointFileText("tok", "d", "i");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("scope_missing");
    expect(r.scope).toBe("Files.Read.All");
  });

  it("returns invalid_input when drive/item missing", async () => {
    const { getSharePointFileText } = await import("@/lib/integrations/microsoft-sharepoint");
    const r = await getSharePointFileText("tok", "", "");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("invalid_input");
  });
});
