/**
 * MS Graph typed delta client tests (L0 — Tier 3 Batch U1).
 *
 * Covers:
 *   - 200 happy path + nextDeltaLink pass-through
 *   - 429 Retry-After single retry + rate_limited final surface
 *   - 403 scope_missing surfaces as GraphClientError{code:"scope_missing"}
 *   - 401 unauthorized surfaces as GraphClientError{code:"unauthorized"}
 *   - pagination: follow @odata.nextLink until @odata.deltaLink
 *   - per-helper endpoint correctness (calendar, tasks, mail, contacts, files)
 *   - token resolution failure throws GraphClientError{code:"no_token"}
 */
 

export {};

const mockGetValidToken = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
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
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-xyz", userEmail: "u@x" });
});

function okResp(data: unknown, headers: Record<string, string> = {}): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResp(status: number, text = "err", headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  };
}

describe("GraphClientError classification", () => {
  it("throws no_token when getValidToken returns null", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const mod = await import("@/lib/ms-graph/client");
    await expect(mod.listCalendarEventsDelta("u-1")).rejects.toMatchObject({
      code: "no_token",
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces 403 as scope_missing", async () => {
    fetchMock.mockResolvedValueOnce(errResp(403, "consent required"));
    const mod = await import("@/lib/ms-graph/client");
    await expect(mod.listMailDelta("u-1")).rejects.toMatchObject({
      code: "scope_missing",
      status: 403,
    });
  });

  it("surfaces 401 as unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(errResp(401, "token bad"));
    const mod = await import("@/lib/ms-graph/client");
    await expect(mod.listContactsDelta("u-1")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });
});

describe("graphGet 429 retry-after", () => {
  it("retries once on 429 with Retry-After header then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(errResp(429, "throttle", { "retry-after": "0" }))
      .mockResolvedValueOnce(
        okResp({ value: [{ id: "e1" }], "@odata.deltaLink": "https://x/delta" }),
      );

    const mod = await import("@/lib/ms-graph/client");
    const res = await mod.listCalendarEventsDelta("u-1");
    expect(res.items).toHaveLength(1);
    expect(res.nextDeltaLink).toBe("https://x/delta");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces final 429 as rate_limited with retryAfter set", async () => {
    fetchMock
      .mockResolvedValueOnce(errResp(429, "t", { "retry-after": "0" }))
      .mockResolvedValueOnce(errResp(429, "t", { "retry-after": "0" }));

    const mod = await import("@/lib/ms-graph/client");
    await expect(mod.listFilesDelta("u-1")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });
});

describe("pagination + deltaLink drain", () => {
  it("follows @odata.nextLink and returns @odata.deltaLink from the final page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResp({
          value: [{ id: "a1" }],
          "@odata.nextLink": "https://graph.example/page2",
        }),
      )
      .mockResolvedValueOnce(
        okResp({
          value: [{ id: "a2" }, { id: "a3" }],
          "@odata.deltaLink": "https://graph.example/delta-final",
        }),
      );

    const mod = await import("@/lib/ms-graph/client");
    const res = await mod.listCalendarEventsDelta("u-1");
    expect(res.items.map((x) => x.id)).toEqual(["a1", "a2", "a3"]);
    expect(res.nextDeltaLink).toBe("https://graph.example/delta-final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call must reuse the absolute next-link URL verbatim.
    expect(fetchMock.mock.calls[1][0]).toBe("https://graph.example/page2");
  });

  it("passes a stored deltaLink through as the first URL unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x/delta-new" }),
    );
    const mod = await import("@/lib/ms-graph/client");
    const stored = "https://graph.microsoft.com/v1.0/me/calendarview/delta?$deltatoken=abc";
    await mod.listCalendarEventsDelta("u-1", stored);
    expect(fetchMock.mock.calls[0][0]).toBe(stored);
  });
});

describe("per-helper endpoints", () => {
  it("listCalendarEventsDelta hits /me/calendarview/delta on first sync", async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x" }),
    );
    const mod = await import("@/lib/ms-graph/client");
    await mod.listCalendarEventsDelta("u-1");
    expect(fetchMock.mock.calls[0][0]).toMatch(/me\/calendarview\/delta/);
    expect(fetchMock.mock.calls[0][0]).toMatch(/startDateTime=/);
  });

  it("listMailDelta hits /me/mailFolders/inbox/messages/delta", async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x" }),
    );
    const mod = await import("@/lib/ms-graph/client");
    await mod.listMailDelta("u-1");
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /me\/mailFolders\/inbox\/messages\/delta/,
    );
  });

  it("listContactsDelta hits /me/contacts/delta", async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x" }),
    );
    const mod = await import("@/lib/ms-graph/client");
    await mod.listContactsDelta("u-1");
    expect(fetchMock.mock.calls[0][0]).toMatch(/me\/contacts\/delta/);
  });

  it("listFilesDelta hits /me/drive/root/delta when no driveId", async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x" }),
    );
    const mod = await import("@/lib/ms-graph/client");
    await mod.listFilesDelta("u-1");
    expect(fetchMock.mock.calls[0][0]).toMatch(/me\/drive\/root\/delta/);
  });

  it("listFilesDelta hits /drives/{id}/root/delta when driveId provided", async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x" }),
    );
    const mod = await import("@/lib/ms-graph/client");
    await mod.listFilesDelta("u-1", "drive-abc");
    expect(fetchMock.mock.calls[0][0]).toMatch(/drives\/drive-abc\/root\/delta/);
  });

  it("listTasksDelta discovers task lists on first sync and drains each", async () => {
    // First call: list discovery.
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [{ id: "list-1" }, { id: "list-2" }] }),
    );
    // Second + third: one page per list, each terminating with a deltaLink.
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [{ id: "t1" }], "@odata.deltaLink": "https://x/l1" }),
    );
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [{ id: "t2" }], "@odata.deltaLink": "https://x/l2" }),
    );

    const mod = await import("@/lib/ms-graph/client");
    const res = await mod.listTasksDelta("u-1");
    expect(res.items.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    // deltaLink is a JSON map keyed by list id — worker stores/re-passes it.
    expect(res.nextDeltaLink).toBeDefined();
    const parsed = JSON.parse(res.nextDeltaLink!);
    expect(parsed).toEqual({
      "list-1": "https://x/l1",
      "list-2": "https://x/l2",
    });
  });

  it("listTasksDelta uses per-list cursor map on subsequent sync", async () => {
    const stored = JSON.stringify({
      "list-1": "https://x/l1-old",
      "list-2": "https://x/l2-old",
    });
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [{ id: "t-new" }], "@odata.deltaLink": "https://x/l1-new" }),
    );
    fetchMock.mockResolvedValueOnce(
      okResp({ value: [], "@odata.deltaLink": "https://x/l2-new" }),
    );

    const mod = await import("@/lib/ms-graph/client");
    const res = await mod.listTasksDelta("u-1", stored);
    expect(res.items).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://x/l1-old");
    expect(fetchMock.mock.calls[1][0]).toBe("https://x/l2-old");
  });
});

describe("describeGraphError", () => {
  it("returns typed shape for GraphClientError", async () => {
    const mod = await import("@/lib/ms-graph/client");
    const err = new mod.GraphClientError(429, "rate_limited", "throttled", 30);
    expect(mod.describeGraphError(err)).toEqual({
      code: "rate_limited",
      status: 429,
      retryAfter: 30,
      message: "throttled",
    });
  });
  it("returns unknown for non-GraphClientError values", async () => {
    const mod = await import("@/lib/ms-graph/client");
    expect(mod.describeGraphError(new Error("boom")).code).toBe("unknown");
  });
});
