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
  it("returns empty rows when given fewer than 2 rows", () => {
    expect(parseUsedRange([], "Sheet1").rows).toEqual([]);
    expect(parseUsedRange([["Code", "Description"]], "Sheet1").rows).toEqual([]);
  });

  it("parses canonical Code/Description headers", () => {
    const { rows } = parseUsedRange(
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
    expect(rows[0].extra).toEqual({});
  });

  it("tolerates header variants (Job Code / Job_Code / Name)", () => {
    const a = parseUsedRange(
      [
        ["Job Code", "Name"],
        ["X-1", "Alpha"],
      ],
      "S",
    );
    expect(a.rows[0]).toMatchObject({ code: "X-1", description: "Alpha" });

    const b = parseUsedRange(
      [
        ["job_code", "desc"],
        ["X-2", "Beta"],
      ],
      "S",
    );
    expect(b.rows[0]).toMatchObject({ code: "X-2", description: "Beta" });
  });

  it("returns empty rows when no code-like column exists", () => {
    const { rows } = parseUsedRange(
      [
        ["Unrelated", "Other"],
        ["foo", "bar"],
      ],
      "S",
    );
    expect(rows).toEqual([]);
  });

  it("dedups by lowercased code (first wins)", () => {
    const { rows } = parseUsedRange(
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
    const { rows } = parseUsedRange(
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
    const { rows } = parseUsedRange(
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

  /* The "shows a mirrored version of some of the columns" CTO bug,
     2026-05-21: v1 parser hardcoded only Code+Description and dropped
     every other workbook column silently. This test pins that the
     parser preserves ALL columns on `extra` AND returns the column
     ordering so the UI can render in the same order finance owns. */
  it("preserves every non-Code/non-Description column on `extra` keyed by header text", () => {
    const { rows, columns } = parseUsedRange(
      [
        ["Client/Category", "Job Code", "Description", "Program", "PO Number", "PO Amount"],
        ["Acme", "WOLFPACK-AUTO", "Dealer DOS", "Phase 1", "PO-1234", "$15,000"],
        ["Globex", "CLIENT-GLB", "Retainer", "Annual", "PO-9999", "$60,000"],
      ],
      "Sheet1",
    );
    expect(columns).toEqual([
      "Client/Category", "Job Code", "Description", "Program", "PO Number", "PO Amount",
    ]);
    expect(rows[0].code).toBe("WOLFPACK-AUTO");
    expect(rows[0].description).toBe("Dealer DOS");
    expect(rows[0].extra).toEqual({
      "Client/Category": "Acme",
      "Program": "Phase 1",
      "PO Number": "PO-1234",
      "PO Amount": "$15,000",
    });
    expect(rows[1].extra["Client/Category"]).toBe("Globex");
  });

  /* REGRESSION 2026-05-21: workbook uses section-header pattern —
     finance puts "Porsche 2026" on the first row of a client group
     and leaves Client/Category blank on subsequent rows of the same
     client. Without forward-fill, the cascading picker only surfaced
     ONE code per client (the row that explicitly carried the value).
     Forward-fill makes every grouped row inherit the section header. */
  it("forward-fills Client/Category for blank rows below a section header", () => {
    const { rows } = parseUsedRange(
      [
        ["Client/Category", "Code", "Program"],
        ["Porsche 2026", "26101", "PBA 101"],
        ["", "26101B", "PBA 101 Coaching"],
        ["", "26102", "PBA 102"],
        ["Nissan", "26200", "Project X"],
        ["", "26201", "Project X Phase 2"],
      ],
      "2026",
    );
    expect(rows.map((r) => ({ code: r.code, cc: r.extra["Client/Category"] }))).toEqual([
      { code: "26101", cc: "Porsche 2026" },
      { code: "26101B", cc: "Porsche 2026" },
      { code: "26102", cc: "Porsche 2026" },
      { code: "26200", cc: "Nissan" },
      { code: "26201", cc: "Nissan" },
    ]);
  });

  it("does NOT forward-fill non-allowlisted columns like Program / PO Number", () => {
    /* Per-row columns must stay blank when finance leaves them blank.
       Pinning so a future widening of FORWARD_FILL_HEADERS gets
       caught in review. */
    const { rows } = parseUsedRange(
      [
        ["Client/Category", "Code", "Program", "PO Number"],
        ["Acme", "A-1", "P1", "PO-1"],
        ["", "A-2", "", ""],
      ],
      "S",
    );
    expect(rows[1].extra["Client/Category"]).toBe("Acme"); // forward-filled
    expect(rows[1].extra["Program"]).toBe("");            // NOT filled
    expect(rows[1].extra["PO Number"]).toBe("");          // NOT filled
  });

  it("returns ordered columns even when no rows match (e.g. blank sheet with headers only)", () => {
    const { columns } = parseUsedRange(
      [["Client/Category", "Job Code", "Program"]],
      "S",
    );
    expect(columns).toEqual(["Client/Category", "Job Code", "Program"]);
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
    (getValidToken as jest.Mock).mockResolvedValueOnce({ accessToken: "delegated-tok", userEmail: "u@x.com" });
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

  it("falls back to app-only when getValidToken returns a malformed shape (defensive)", async () => {
    /* Pins the 2026-05-21 prod bug: getValidToken returns
       { accessToken, userEmail }. If something hands us a string-only
       fake or an empty-accessToken object, we MUST fall back to
       app-only rather than ship "[object Object]" as the Bearer
       value (Graph rejects → accessDenied → user-facing graph_forbidden). */
    (getValidToken as jest.Mock).mockResolvedValueOnce({ accessToken: "", userEmail: "x" });
    (getAppOnlyToken as jest.Mock).mockResolvedValueOnce("app-tok");
    const out = await acquireSharePointToken("u-1");
    expect(out).toEqual({ token: "app-tok", kind: "app_only" });
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
