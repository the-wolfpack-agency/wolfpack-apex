/**
 * The SharePoint provider: their files, in one list with everything else.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It drives the real provider and the
 * real integration with the Graph token lookup stubbed, so it catches the
 * things that break silently: a result shape misread, a failure rendered as an
 * empty library, a missing account spending a Graph call to find out.
 *
 * It does NOT prove Microsoft answers us. This machine has no MS_CLIENT_ID, so
 * getValidToken short-circuits and every account reports not connected. A green
 * run here is not a working integration. The live proof is
 * scripts/sharepoint-search-check.ts, which exits non-zero on zero hits
 * precisely so it cannot be mistaken for one.
 */
import { sharepointProvider } from "@/lib/search/providers/sharepoint";

const mockGetValidToken = jest.fn();
const mockSearchSharePoint = jest.fn();
const mockTrackFailure = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

jest.mock("@/lib/integrations/microsoft-sharepoint", () => ({
  searchSharePoint: (...a: unknown[]) => mockSearchSharePoint(...a),
  trackSharePointLookupFailure: (...a: unknown[]) => mockTrackFailure(...a),
}));

const ctx = { userId: "u1", workspaceId: "default" };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok", userEmail: "a@b.co" });
});

describe("what it contributes to the result list", () => {
  it("returns their files, linked to the original rather than to a copy", async () => {
    mockSearchSharePoint.mockResolvedValue({
      ok: true,
      value: {
        hits: [
          {
            title: "Coaching Calls.xlsx",
            url: "https://contoso.sharepoint.com/sites/X/Coaching.xlsx",
            snippet: "coaching call notes for August",
            modifiedAt: "2026-08-20T10:00:00Z",
            source_kind: "sharepoint_doc",
            driveItemId: "01ABC",
            driveId: "b!xyz",
          },
        ],
        total: 1,
        took_ms: 12,
        query_string_sent: "coaching calls",
      },
    });

    const out = await sharepointProvider.search("coaching calls", 5, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("sharepoint");
    expect(out[0].title).toBe("Coaching Calls.xlsx");
    /* The link goes to THEIR SharePoint. Nothing was downloaded to link to. */
    expect(out[0].url).toContain("contoso.sharepoint.com");
    expect(out[0].id).toBe("01ABC");
  });

  /* A list item or a site has no driveItemId and still has to be addressable,
     or it silently drops out of a list it was ranked into. */
  it("falls back to the URL as an id when there is no drive item", async () => {
    mockSearchSharePoint.mockResolvedValue({
      ok: true,
      value: {
        hits: [
          {
            title: "Team site",
            url: "https://contoso.sharepoint.com/sites/Team",
            snippet: "",
            modifiedAt: "",
            source_kind: "sharepoint_page",
          },
        ],
        total: 1,
        took_ms: 5,
        query_string_sent: "team",
      },
    });

    const out = await sharepointProvider.search("team", 5, ctx);
    expect(out[0].id).toBe("https://contoso.sharepoint.com/sites/Team");
  });

  it("passes the caller's limit through rather than deciding its own", async () => {
    mockSearchSharePoint.mockResolvedValue({
      ok: true,
      value: { hits: [], total: 0, took_ms: 1, query_string_sent: "q" },
    });
    await sharepointProvider.search("q", 7, ctx);
    expect(mockSearchSharePoint).toHaveBeenCalledWith("tok", { query: "q", topN: 7 });
  });
});

describe("a failure is never an empty library", () => {
  /* THE ASSERTION THIS FILE EXISTS FOR. Each of these contributes NO results,
     which the fan-out treats as this provider not participating. What it must
     never do is contribute a confident zero to a count somebody reads as a
     fact about their own SharePoint. */
  it.each(["scope_missing", "not_connected", "rate_limited", "internal"])(
    "contributes nothing on %s, and records it where health reporting sees it",
    async (code) => {
      mockSearchSharePoint.mockResolvedValue({ ok: false, code, message: "x" });

      const out = await sharepointProvider.search("anything", 5, ctx);
      expect(out).toEqual([]);
      expect(mockTrackFailure).toHaveBeenCalledTimes(1);
    },
  );

  /* No account connected is not a failure worth reporting, it is the ordinary
     state of a workspace that has not finished setup. Spending a Graph call to
     discover it would be the waste. */
  it("does not call Graph at all when there is no token", async () => {
    mockGetValidToken.mockResolvedValue(null);
    const out = await sharepointProvider.search("anything", 5, ctx);
    expect(out).toEqual([]);
    expect(mockSearchSharePoint).not.toHaveBeenCalled();
  });

  it("does not call Graph for an empty query", async () => {
    const out = await sharepointProvider.search("   ", 5, ctx);
    expect(out).toEqual([]);
    expect(mockSearchSharePoint).not.toHaveBeenCalled();
  });

  /* A provider that throws would take the whole fan-out's result down with it
     on a bad day at Microsoft. */
  it("survives the token lookup throwing", async () => {
    mockGetValidToken.mockRejectedValue(new Error("db down"));
    await expect(sharepointProvider.search("anything", 5, ctx)).resolves.toEqual([]);
  });
});
