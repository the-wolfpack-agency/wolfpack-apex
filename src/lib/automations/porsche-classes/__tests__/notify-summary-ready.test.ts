/**
 * notify-summary-ready — unit tests.
 *
 * Mocks @/lib/db + the config-repo getter to drive the orchestrator
 * through every branch:
 *   - no_recipients (config returns [])
 *   - no_provider (RESEND_API_KEY unset)
 *   - already_notified (notifications row exists)
 *   - not_yet_ready (distinct sources < 4)
 *   - happy path (resend returns 200)
 *   - send_failed (resend returns 500) — does NOT mark notified
 *   - subject + body shape (one paragraph + one link)
 *   - defaultSummaryUrl encoding
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: class extends Error {},
}));

const mockGetConfig = jest.fn();
jest.mock("@/lib/automations/porsche-classes/config-repo", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

import {
  notifySummaryReady,
  notifySummaryReadyIfTransition,
  defaultSummaryUrl,
  loadRecipients,
  REQUIRED_SOURCES_FOR_READY,
} from "@/lib/automations/porsche-classes/notify-summary-ready";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.RESEND_API_KEY;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PROD_DOMAIN;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

/* ------------------------------------------------------------------ */
/* notifySummaryReady (direct)                                         */
/* ------------------------------------------------------------------ */

describe("notifySummaryReady", () => {
  it("skips when recipients is empty", async () => {
    process.env.RESEND_API_KEY = "key";
    const out = await notifySummaryReady({
      class_key: "k",
      recipients: [],
      summary_url: "https://x",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("no_recipients");
  });

  it("skips when RESEND_API_KEY is unset", async () => {
    const out = await notifySummaryReady({
      class_key: "k",
      recipients: ["a@b.com"],
      summary_url: "https://x",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("no_provider");
  });

  it("skips when subject parts cannot be loaded (no snapshot)", async () => {
    process.env.RESEND_API_KEY = "key";
    process.env.DATABASE_URL = "postgres://x";
    mockQuery.mockResolvedValueOnce({ rows: [] }); // loadSubjectParts
    const out = await notifySummaryReady({
      class_key: "k",
      recipients: ["a@b.com"],
      summary_url: "https://x",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("summary_unavailable");
  });

  it("happy path — POSTs to Resend with plain-text body + correct subject", async () => {
    process.env.RESEND_API_KEY = "key";
    process.env.DATABASE_URL = "postgres://x";
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          course_type: "BA101",
          location: "Westlake",
          class_date: "2026-04-13",
        },
      ],
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const out = await notifySummaryReady({
      class_key: "BA101|2026-04-13|Westlake",
      recipients: ["alicia@example.com", "ops@example.com"],
      summary_url: "https://app.example/automations/porsche/summaries/abc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const init2 = init as RequestInit;
    expect(init2.method).toBe("POST");
    const body = JSON.parse(init2.body as string);
    expect(body.to).toEqual(["alicia@example.com", "ops@example.com"]);
    expect(body.subject).toBe(
      "Class summary ready: BA101 Westlake 2026-04-13",
    );
    // Plain text only — no HTML key, body contains the deep link.
    expect(body.html).toBeUndefined();
    expect(body.text).toContain(
      "https://app.example/automations/porsche/summaries/abc",
    );
    // One paragraph + one link, not a long marketing brief.
    const lines = (body.text as string).split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("returns ok:false on non-2xx Resend response", async () => {
    process.env.RESEND_API_KEY = "key";
    process.env.DATABASE_URL = "postgres://x";
    mockQuery.mockResolvedValueOnce({
      rows: [
        { course_type: "BA101", location: "X", class_date: "2026-04-13" },
      ],
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const out = await notifySummaryReady({
      class_key: "k",
      recipients: ["a@b.com"],
      summary_url: "https://x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("send_failed");
  });

  it("never throws on fetch network error", async () => {
    process.env.RESEND_API_KEY = "key";
    process.env.DATABASE_URL = "postgres://x";
    mockQuery.mockResolvedValueOnce({
      rows: [
        { course_type: "BA101", location: "X", class_date: "2026-04-13" },
      ],
    });
    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const out = await notifySummaryReady({
      class_key: "k",
      recipients: ["a@b.com"],
      summary_url: "https://x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("send_failed");
  });
});

/* ------------------------------------------------------------------ */
/* notifySummaryReadyIfTransition (orchestrator)                       */
/* ------------------------------------------------------------------ */

describe("notifySummaryReadyIfTransition", () => {
  function inject(opts: {
    distinctCount?: number;
    alreadyNotified?: boolean;
    recipients?: string[];
    fetchImpl?: typeof fetch;
  } = {}) {
    return {
      automation_id: "porsche-classes",
      class_key: "BA101|2026-04-13|Westlake",
      loadDistinctSourceCount: jest
        .fn()
        .mockResolvedValue(opts.distinctCount ?? 4),
      loadRecipients: jest
        .fn()
        .mockResolvedValue(opts.recipients ?? ["a@b.com"]),
      loadSubjectParts: jest.fn().mockResolvedValue({
        course: "BA101",
        location: "Westlake",
        class_date: "2026-04-13",
      }),
      fetchImpl: opts.fetchImpl,
      summaryUrlBuilder: (k: string) => `https://x/${k}`,
      _alreadyNotified: opts.alreadyNotified ?? false,
    };
  }

  function setupAlreadyMock(already: boolean) {
    // hasAlreadyNotified call → return rows depending on `already`.
    mockQuery.mockResolvedValueOnce({
      rows: already ? [{ class_key: "k" }] : [],
    });
  }

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://x";
  });

  it("skips when already notified", async () => {
    setupAlreadyMock(true);
    const args = inject();
    const out = await notifySummaryReadyIfTransition(args);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("already_notified");
    expect(args.loadDistinctSourceCount).not.toHaveBeenCalled();
  });

  it("skips when not all sources are present (count < 4)", async () => {
    setupAlreadyMock(false);
    const args = inject({ distinctCount: 3 });
    const out = await notifySummaryReadyIfTransition(args);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("not_yet_ready");
  });

  it("records skipped_no_recipients when recipients is empty", async () => {
    setupAlreadyMock(false);
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ class_key: "k" }] });
    const args = inject({ recipients: [] });
    const out = await notifySummaryReadyIfTransition(args);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("no_recipients");
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_automation_porsche_notifications/);
    expect(params[2]).toBe("skipped_no_recipients");
  });

  it("records skipped_no_provider when RESEND_API_KEY is missing", async () => {
    setupAlreadyMock(false);
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ class_key: "k" }] });
    const args = inject();
    const out = await notifySummaryReadyIfTransition(args);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("no_provider");
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const params = mockWriteQuery.mock.calls[0][1];
    expect(params[2]).toBe("skipped_no_provider");
  });

  it("happy path — sends email and marks notified", async () => {
    process.env.RESEND_API_KEY = "key";
    setupAlreadyMock(false);
    // The notifySummaryReady internal call uses a different loadSubjectParts
    // from this orchestrator's loadSubjectParts? Actually our implementation
    // re-queries with mockQuery for subject parts. Stub that call.
    mockQuery.mockResolvedValueOnce({
      rows: [
        { course_type: "BA101", location: "Westlake", class_date: "2026-04-13" },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ class_key: "k" }] }); // markNotified

    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const args = inject({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await notifySummaryReadyIfTransition(args);

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel).toBe("resend");
      expect(out.recipient_count).toBe(1);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const params = mockWriteQuery.mock.calls[0][1];
    expect(params[2]).toBe("resend");
  });

  it("does NOT mark notified when send fails (transient — preserve slot)", async () => {
    process.env.RESEND_API_KEY = "key";
    setupAlreadyMock(false);
    mockQuery.mockResolvedValueOnce({
      rows: [
        { course_type: "BA101", location: "Westlake", class_date: "2026-04-13" },
      ],
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }));

    const args = inject({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await notifySummaryReadyIfTransition(args);
    expect(out.ok).toBe(false);
    expect(mockWriteQuery).not.toHaveBeenCalled(); // no markNotified
  });
});

/* ------------------------------------------------------------------ */
/* loadRecipients                                                      */
/* ------------------------------------------------------------------ */

describe("loadRecipients", () => {
  it("returns [] when config has no row", async () => {
    mockGetConfig.mockResolvedValueOnce(null);
    const out = await loadRecipients();
    expect(out).toEqual([]);
  });
  it("filters non-string + invalid emails", async () => {
    mockGetConfig.mockResolvedValueOnce([
      "alicia@example.com",
      "  ops@example.com  ",
      "not-an-email",
      42,
      null,
    ]);
    const out = await loadRecipients();
    expect(out).toEqual(["alicia@example.com", "ops@example.com"]);
  });
  it("returns [] for non-array values (defensive)", async () => {
    mockGetConfig.mockResolvedValueOnce("alicia@example.com");
    const out = await loadRecipients();
    expect(out).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* defaultSummaryUrl                                                   */
/* ------------------------------------------------------------------ */

describe("defaultSummaryUrl", () => {
  it("URL-encodes the class_key (preserves | as %7C)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example/";
    const url = defaultSummaryUrl("BA101|2026-04-13|Westlake");
    expect(url).toBe(
      "https://app.example/automations/porsche-classes/summaries/BA101%7C2026-04-13%7CWestlake",
    );
  });
  it("falls back to the documented prod default when no env is set", () => {
    const url = defaultSummaryUrl("k");
    expect(url).toMatch(/^https:\/\/app\.wolfpack\.agency\//);
  });
});

/* ------------------------------------------------------------------ */
/* REQUIRED_SOURCES_FOR_READY contract                                 */
/* ------------------------------------------------------------------ */

describe("REQUIRED_SOURCES_FOR_READY", () => {
  it("matches the four contract source types in types.ts", () => {
    expect([...REQUIRED_SOURCES_FOR_READY].sort()).toEqual(
      [
        "cognito_coordinator",
        "cognito_instructor",
        "porsche_xlsx",
        "survey",
      ].sort(),
    );
  });
});
