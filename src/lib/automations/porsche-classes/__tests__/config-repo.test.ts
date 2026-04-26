/**
 * config-repo — round-trip tests against a mocked db layer. The
 * production config-repo is a thin wrapper over `query` + `writeQuery`
 * so we mock those and assert (a) the right SQL goes through, (b) the
 * typed helpers normalize input correctly, and (c) defaults kick in
 * when no row exists.
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));

import {
  getConfig,
  setConfig,
  getInboxFilters,
  setInboxFilters,
  getSharepointConfig,
  setSharepointConfig,
  DEFAULT_INBOX_FILTERS,
} from "@/lib/automations/porsche-classes/config-repo";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test/test";
});

afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

/* ------------------------------------------------------------------ */
/* getConfig / setConfig — generic                                    */
/* ------------------------------------------------------------------ */

describe("getConfig", () => {
  it("returns null in shadow mode (no DATABASE_URL)", async () => {
    delete process.env.DATABASE_URL;
    const out = await getConfig("inbox_filters");
    expect(out).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns null when no row exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getConfig("inbox_filters")).toBeNull();
  });

  it("returns the stored value when a row exists", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: { foo: "bar" } }],
    });
    expect(await getConfig("inbox_filters")).toEqual({ foo: "bar" });
  });

  it("soft-fails to null when the query throws", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    expect(await getConfig("inbox_filters")).toBeNull();
  });
});

describe("setConfig", () => {
  it("UPSERTs with key + JSON value + updated_by", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ key: "inbox_filters" }] });
    await setConfig("inbox_filters", { foo: "bar" }, "alicia@thewolfpack.agency");
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params, opts] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_automation_porsche_config/);
    expect(sql).toMatch(/ON CONFLICT \(key\)/);
    expect(params[0]).toBe("inbox_filters");
    expect(JSON.parse(params[1] as string)).toEqual({ foo: "bar" });
    expect(params[2]).toBe("alicia@thewolfpack.agency");
    expect(opts).toEqual({ expectRows: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Inbox filters — typed helpers                                      */
/* ------------------------------------------------------------------ */

describe("getInboxFilters", () => {
  it("returns the shipped defaults when no row exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getInboxFilters()).toEqual(DEFAULT_INBOX_FILTERS);
  });

  it("returns the stored row coerced to the contract shape", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          value: {
            sender_match: ["a@x.com", "b@x.com"],
            subject_match: ["Hello"],
          },
        },
      ],
    });
    expect(await getInboxFilters()).toEqual({
      sender_match: ["a@x.com", "b@x.com"],
      subject_match: ["Hello"],
    });
  });

  it("falls back to default arrays when stored value has wrong shape", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: { sender_match: "not an array" } }],
    });
    const out = await getInboxFilters();
    expect(out.sender_match).toEqual(DEFAULT_INBOX_FILTERS.sender_match);
    expect(out.subject_match).toEqual(DEFAULT_INBOX_FILTERS.subject_match);
  });
});

describe("setInboxFilters", () => {
  it("normalizes whitespace, drops empties, and dedupes", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ key: "inbox_filters" }] });
    await setInboxFilters(
      {
        sender_match: ["  a@x.com  ", "", "a@x.com", "b@x.com"],
        subject_match: ["Hello", "Hello", "  "],
      },
      "alicia@thewolfpack.agency",
    );
    const [, params] = mockWriteQuery.mock.calls[0];
    const stored = JSON.parse(params[1] as string);
    expect(stored.sender_match).toEqual(["a@x.com", "b@x.com"]);
    expect(stored.subject_match).toEqual(["Hello"]);
  });

  it("throws when arrays aren't actually arrays", async () => {
    await expect(
      setInboxFilters(
        // @ts-expect-error — testing runtime guard
        { sender_match: "abc", subject_match: [] },
        "alicia@thewolfpack.agency",
      ),
    ).rejects.toThrow();
  });

  it("set then get round-trips the normalized value", async () => {
    /* Wire the in-memory fake: setInboxFilters writes via writeQuery,
       then we make getConfig return whatever was just written. */
    let captured: unknown = null;
    mockWriteQuery.mockImplementationOnce(async (_sql, params) => {
      captured = JSON.parse(params[1] as string);
      return { rows: [{ key: "inbox_filters" }] };
    });
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ value: captured }],
    }));

    await setInboxFilters(
      {
        sender_match: ["A@x.com", "a@x.com"],
        subject_match: ["Hello"],
      },
      "alicia@thewolfpack.agency",
    );
    const out = await getInboxFilters();
    expect(out.sender_match).toEqual(["A@x.com", "a@x.com"]);
    expect(out.subject_match).toEqual(["Hello"]);
  });
});

/* ------------------------------------------------------------------ */
/* SharePoint config — typed helpers                                  */
/* ------------------------------------------------------------------ */

describe("getSharepointConfig", () => {
  it("returns null when no row exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getSharepointConfig()).toBeNull();
  });

  it("returns null for a partial / corrupted row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: { site_id: "abc" } }],
    });
    expect(await getSharepointConfig()).toBeNull();
  });

  it("trims whitespace and strips slashes from a valid row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          value: {
            site_id: "  contoso.sharepoint.com,abc,def  ",
            drive_id: "drive-1\n",
            path: "/PCNA/Class Summaries/",
          },
        },
      ],
    });
    expect(await getSharepointConfig()).toEqual({
      site_id: "contoso.sharepoint.com,abc,def",
      drive_id: "drive-1",
      path: "PCNA/Class Summaries",
    });
  });
});

describe("setSharepointConfig", () => {
  it("rejects empty strings", async () => {
    await expect(
      setSharepointConfig(
        { site_id: "abc", drive_id: "", path: "x" },
        "alicia@thewolfpack.agency",
      ),
    ).rejects.toThrow();
  });

  it("normalizes path before writing", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ key: "sharepoint" }] });
    await setSharepointConfig(
      {
        site_id: "contoso.sharepoint.com,abc,def",
        drive_id: "drive-1",
        path: "/PCNA/Class Summaries/",
      },
      "alicia@thewolfpack.agency",
    );
    const stored = JSON.parse(mockWriteQuery.mock.calls[0][1][1] as string);
    expect(stored.path).toBe("PCNA/Class Summaries");
  });
});

describe("DEFAULT_INBOX_FILTERS — subject scope locked to the class-summary workflow", () => {
  test("only the four class-summary source streams match by subject", () => {
    // Operator-confirmed scope (2026-04-26). Anything else
    // ('Change Management Plan', 'Brand Ambassador',
    // 'Skills Practice Auditor Score Sheet', etc.) is intentionally
    // OUT of scope — they exist as separate Cognito forms but are
    // not part of the class summary doc. Re-adding them without a
    // parser would quarantine every match.
    expect(DEFAULT_INBOX_FILTERS.subject_match.sort()).toEqual(
      [
        "Coordinator Class Report",
        "Instructor Class Report",
        "Scheduled Report Notification",
        "Survey Data PCBA",
      ].sort(),
    );
  });

  test("dropped patterns must NOT reappear without a paired parser", () => {
    const dropped = [
      "Change Management Plan",
      "Brand Ambassador",
      "Skills Practice",
      "Auditor Score Sheet",
    ];
    for (const d of dropped) {
      expect(DEFAULT_INBOX_FILTERS.subject_match).not.toContain(d);
    }
  });
});
