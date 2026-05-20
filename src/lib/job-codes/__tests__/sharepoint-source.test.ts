/**
 * Unit tests for sharepoint-source.ts.
 *
 * Two layers:
 *   1. `parseUsedRange` — pure-fn parser fed synthetic usedRange shapes.
 *      Verifies header tolerance, dedup, missing-column behavior, etc.
 *   2. `fetchJobCodesFromSharePoint` — full Graph round-trip with `fetch`
 *      mocked. Asserts the discovered/hint paths, error mapping, and
 *      sheet-selection logic.
 */

import {
  parseUsedRange,
  fetchJobCodesFromSharePoint,
  encodeShareUrl,
  acquireSharePointToken,
} from "@/lib/job-codes/sharepoint-source";

jest.mock("@/lib/microsoft-graph", () => ({
  getAppOnlyToken: jest.fn(),
  getValidToken: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn().mockResolvedValue(undefined),
}));

import { getAppOnlyToken, getValidToken } from "@/lib/microsoft-graph";

describe("parseUsedRange", () => {
  it("returns [] when given fewer than 2 rows", () => {
    expect(parseUsedRange([], "Sheet1")).toEqual([]);
    expect(parseUsedRange([["Code", "Description"]], "Sheet1")).toEqual([]);
  });

  it("parses canonical Code/Description headers", () => {
    const rows = parseUsedRange(
      [
        ["Code", "Description"],
        ["WOLFPACK-AUTO", "Dealer DOS engineering"],
        ["CLIENT-ACME", "Acme retainer billable"],
      ],
      "Job Codes",
    );
    expect(rows.length).toBe(2);
    expect(rows[0].code).toBe("WOLFPACK-AUTO");
    expect(rows[0].description).toBe("Dealer DOS engineering");
    expect(rows[0].sheetName).toBe("Job Codes");
    expect(rows[0].active).toBe(true);
  });

  it("tolerates header variants (Job Code / Job_Code / Name)", () => {
    const a = parseUsedRange(
      [
        ["Job Code", "Name"],
        ["X-1", "Alpha"],
      ],
      "S",
    );
    expect(a[0]).toMatchObject({ code: "X-1", description: "Alpha" });

    const b = parseUsedRange(
      [
        ["job_code", "desc"],
        ["X-2", "Beta"],
      ],
      "S",
    );
    expect(b[0]).toMatchObject({ code: "X-2", description: "Beta" });
  });

  it("returns [] when no code-like column exists", () => {
    const rows = parseUsedRange(
      [
        ["Unrelated", "Other"],
        ["foo", "bar"],
      ],
      "S",
    );
    expect(rows).toEqual([]);
  });

  it("dedups by lowercased code (first wins)", () => {
    const rows = parseUsedRange(
      [
        ["Code", "Description"],
        ["A-1", "First"],
        ["a-1", "Second"], // duplicate
        ["B-2", "Third"],
      ],
      "S",
    );
    expect(rows.map((r) => r.code)).toEqual(["A-1", "B-2"]);
    expect(rows[0].description).toBe("First");
  });

  it("skips blank code cells (so trailing empty rows don't pollute)", () => {
    const rows = parseUsedRange(
      [
        ["Code", "Description"],
        ["A-1", "x"],
        ["", ""],
        [null, "y"] as Array<string | number | boolean | null>,
        ["B-2", "z"],
      ],
      "S",
    );
    expect(rows.map((r) => r.code)).toEqual(["A-1", "B-2"]);
  });

  it("handles a code-only sheet (description column missing)", () => {
    const rows = parseUsedRange(
      [
        ["Code"],
        ["A-1"],
        ["B-2"],
      ],
      "S",
    );
    expect(rows.map((r) => r.code)).toEqual(["A-1", "B-2"]);
    expect(rows.every((r) => r.description === "")).toBe(true);
  });
});

describe("acquireSharePointToken (token-acquisition strategy)", () => {
  beforeEach(() => {
    /* Reset both mocks so each test sets its own resolution exactly —
       the outer beforeEach() seeds getAppOnlyToken with a default
       "test-token" for the fetch-flow tests, which would mask
       null-fallback assertions here. */
    (getAppOnlyToken as jest.Mock).mockReset();
    (getValidToken as jest.Mock).mockReset();
  });

  it("prefers the user's delegated token when preferUserId is supplied", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce("delegated-tok");
    (getAppOnlyToken as jest.Mock).mockResolvedValueOnce("app-tok");
    const out = await acquireSharePointToken("u-1");
    expect(out).toEqual({ token: "delegated-tok", kind: "delegated" });
    expect(getAppOnlyToken).not.toHaveBeenCalled();
  });

  it("falls back to app-only when delegated lookup returns null", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce(null);
    (getAppOnlyToken as jest.Mock).mockResolvedValueOnce("app-tok");
    const out = await acquireSharePointToken("u-1");
    expect(out).toEqual({ token: "app-tok", kind: "app_only" });
  });

  it("falls back to app-only when delegated lookup throws (stale row, etc.)", async () => {
    (getValidToken as jest.Mock).mockRejectedValueOnce(new Error("DB down"));
    (getAppOnlyToken as jest.Mock).mockResolvedValueOnce("app-tok");
    const out = await acquireSharePointToken("u-1");
    expect(out).toEqual({ token: "app-tok", kind: "app_only" });
  });

  it("returns null when both paths fail (caller surfaces not_configured)", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce(null);
    (getAppOnlyToken as jest.Mock).mockResolvedValueOnce(null);
    const out = await acquireSharePointToken("u-1");
    expect(out).toBeNull();
  });

  it("skips delegated entirely when no preferUserId", async () => {
    (getAppOnlyToken as jest.Mock).mockResolvedValueOnce("app-tok");
    const out = await acquireSharePointToken(null);
    expect(out).toEqual({ token: "app-tok", kind: "app_only" });
    expect(getValidToken).not.toHaveBeenCalled();
  });
});

describe("fetchJobCodesFromSharePoint", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    (getAppOnlyToken as jest.Mock).mockResolvedValue("test-token");
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.resetAllMocks();
  });

  function mockFetchSequence(
    responses: Array<{ ok: boolean; status?: number; body?: unknown; text?: string; headers?: Record<string, string> }>,
  ) {
    let i = 0;
    global.fetch = jest.fn(async () => {
      const r = responses[i++] ?? responses[responses.length - 1];
      const headers = new Headers(r.headers ?? {});
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        headers,
        json: async () => r.body ?? {},
        text: async () => r.text ?? "",
      } as unknown as Response;
    }) as jest.Mock;
  }

  it("returns not_configured when no app-only token is available", async () => {
    (getAppOnlyToken as jest.Mock).mockResolvedValue(null);
    const res = await fetchJobCodesFromSharePoint();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_configured");
  });

  it("happy path: search → list worksheets → usedRange → parse", async () => {
    mockFetchSequence([
      /* /search/query response */
      {
        ok: true,
        body: {
          value: [
            {
              hitsContainers: [
                {
                  hits: [
                    {
                      resource: {
                        name: "Wolfpack_2026_Job Codes.xlsx",
                        webUrl: "https://example.sharepoint.com/x.xlsx",
                        parentReference: { driveId: "drv-1" },
                        id: "itm-1",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      /* worksheets list */
      { ok: true, body: { value: [{ name: "Job Codes" }, { name: "Notes" }] } },
      /* usedRange */
      {
        ok: true,
        body: {
          values: [
            ["Code", "Description"],
            ["WOLFPACK-AUTO", "Dealer DOS"],
          ],
        },
      },
    ]);
    const res = await fetchJobCodesFromSharePoint();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows.length).toBe(1);
    expect(res.value.rows[0].code).toBe("WOLFPACK-AUTO");
    expect(res.value.driveId).toBe("drv-1");
    expect(res.value.itemId).toBe("itm-1");
    expect(res.value.sheetName).toBe("Job Codes");
  });

  it("returns source_file_not_found when search returns no hits", async () => {
    mockFetchSequence([
      { ok: true, body: { value: [{ hitsContainers: [{ hits: [] }] }] } },
    ]);
    const res = await fetchJobCodesFromSharePoint();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("source_file_not_found");
  });

  it("maps Graph 403 to graph_forbidden so the caller can prompt for an admin", async () => {
    mockFetchSequence([{ ok: false, status: 403, text: "Sites.Read.All required" }]);
    const res = await fetchJobCodesFromSharePoint();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("graph_forbidden");
  });

  it("maps Graph 429 to rate_limited with retryAfter parsed from headers", async () => {
    mockFetchSequence([
      { ok: false, status: 429, headers: { "retry-after": "37" }, text: "throttled" },
    ]);
    const res = await fetchJobCodesFromSharePoint();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.retryAfter).toBe(37);
    }
  });

  it("skips search entirely when a hint is provided", async () => {
    mockFetchSequence([
      /* worksheets list — search is skipped */
      { ok: true, body: { value: [{ name: "Job Codes" }] } },
      /* usedRange */
      {
        ok: true,
        body: { values: [["Code", "Description"], ["X-1", "Hint hit"]] },
      },
    ]);
    const res = await fetchJobCodesFromSharePoint({ hint: { driveId: "drv-2", itemId: "itm-2" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.driveId).toBe("drv-2");
    expect(res.value.itemId).toBe("itm-2");
    expect(res.value.rows[0].code).toBe("X-1");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("encodes a SharePoint URL into the Graph /shares form", () => {
    /* Microsoft's encoding spec: base64, trim '=', '/'→'_', '+'→'-',
       then prefix 'u!'. */
    const url = "https://contoso.sharepoint.com/sites/foo/Shared%20Documents/x.xlsx";
    const out = encodeShareUrl(url);
    expect(out.startsWith("u!")).toBe(true);
    expect(out).not.toMatch(/[=]/);
    expect(out).not.toMatch(/[+/]/);
    /* Round-trip: undo the URL-safe transformation, base64-decode,
       and confirm we get the original URL back. */
    const stripped = out.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = stripped + "=".repeat((4 - (stripped.length % 4)) % 4);
    expect(Buffer.from(padded, "base64").toString("utf8")).toBe(url);
  });

  it("uses /shares/{id}/driveItem when JOB_CODES_SHARE_URL is set (production path)", async () => {
    process.env.JOB_CODES_SHARE_URL = "https://example.sharepoint.com/sites/x/Shared Documents/JobCodes.xlsx";
    /* The module reads the env var at import time as a const, so we
       need a fresh module load. jest.isolateModules gives us that. */
    let res: Awaited<ReturnType<typeof fetchJobCodesFromSharePoint>>;
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/microsoft-graph", () => ({
        getAppOnlyToken: jest.fn().mockResolvedValue("test-token"),
      }));
      jest.doMock("@/lib/analytics", () => ({
        trackEvent: jest.fn().mockResolvedValue(undefined),
      }));
      mockFetchSequence([
        /* /shares/{id}/driveItem response */
        {
          ok: true,
          body: {
            id: "itm-share",
            webUrl: "https://example.sharepoint.com/sites/x/Shared%20Documents/JobCodes.xlsx",
            parentReference: { driveId: "drv-share" },
          },
        },
        /* worksheets list */
        { ok: true, body: { value: [{ name: "Job Codes" }] } },
        /* usedRange */
        {
          ok: true,
          body: { values: [["Code", "Description"], ["VIA-SHARE", "from share URL"]] },
        },
      ]);
      const { fetchJobCodesFromSharePoint: fresh } = await import("@/lib/job-codes/sharepoint-source");
      res = await fresh();
    });
    delete process.env.JOB_CODES_SHARE_URL;
    expect(res!.ok).toBe(true);
    if (!res!.ok) return;
    expect(res!.value.driveId).toBe("drv-share");
    expect(res!.value.itemId).toBe("itm-share");
    expect(res!.value.rows[0].code).toBe("VIA-SHARE");
  });

  it("share-URL 404 maps to source_file_not_found with a configuration hint", async () => {
    process.env.JOB_CODES_SHARE_URL = "https://example.sharepoint.com/wrong.xlsx";
    let res: Awaited<ReturnType<typeof fetchJobCodesFromSharePoint>>;
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/microsoft-graph", () => ({
        getAppOnlyToken: jest.fn().mockResolvedValue("test-token"),
      }));
      jest.doMock("@/lib/analytics", () => ({
        trackEvent: jest.fn().mockResolvedValue(undefined),
      }));
      mockFetchSequence([{ ok: false, status: 404, text: "not found" }]);
      const { fetchJobCodesFromSharePoint: fresh } = await import("@/lib/job-codes/sharepoint-source");
      res = await fresh();
    });
    delete process.env.JOB_CODES_SHARE_URL;
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.error.code).toBe("source_file_not_found");
      expect(res!.error.detail).toContain("JOB_CODES_SHARE_URL");
    }
  });

  it("returns no_codes_found when the workbook is empty", async () => {
    mockFetchSequence([
      { ok: true, body: { value: [{ hitsContainers: [{ hits: [{ resource: { parentReference: { driveId: "d" }, id: "i" } }] }] }] } },
      { ok: true, body: { value: [{ name: "Sheet1" }] } },
      { ok: true, body: { values: [["Code", "Description"]] } },
    ]);
    const res = await fetchJobCodesFromSharePoint();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("no_codes_found");
  });
});
