/**
 * Tests for inbox-poller — the pure helpers (filter + source-type
 * detection) plus the soft-fail "no token connected" path. Full Graph
 * round-trip is exercised via the API route test which mocks
 * listMailDelta.
 */

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: jest.fn(),
}));
jest.mock("@/lib/ms-graph/client", () => {
  class GraphClientError extends Error {
    constructor(public status: number, public code: string, msg: string) {
      super(msg);
    }
  }
  return {
    listMailDelta: jest.fn(),
    GraphClientError,
  };
});
jest.mock("@/lib/automations/registry", () => ({
  getAutomation: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(() => Promise.resolve()) }));
// DB layer is mocked — search-mode loads/saves cursor via @/lib/db; we
// don't run a real Postgres in unit tests.
jest.mock("@/lib/db", () => ({
  query: jest.fn(async () => ({ rows: [] })),
  writeQuery: jest.fn(async () => ({ rows: [{ automation_id: "porsche-classes" }] })),
}));

import {
  messageMatchesAutomation,
  detectSourceType,
  pollInbox,
  getMailboxBase,
  __searchModeInternalsForTests,
} from "@/lib/automations/inbox-poller";
import { getValidToken } from "@/lib/microsoft-graph";
import { getAutomation } from "@/lib/automations/registry";
import type { AutomationDefinition } from "@/lib/automations/types";

const automation: AutomationDefinition = {
  id: "porsche-classes",
  name: "test",
  owner_label: "x",
  description: "x",
  active_window_days: { min: 0, max: 30 },
  inbox_filters: {
    sender_match: ["porsche-academy-notification@porsche.de"],
    subject_match: ["Scheduled Report Notification"],
  },
  parsers: { porsche_xlsx: jest.fn() as never },
};

describe("messageMatchesAutomation", () => {
  it("matches when sender + subject substrings both hit", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "porsche-academy-notification@porsche.de" } },
      subject: "Scheduled Report Notification: Daily",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(true);
  });

  it("rejects when sender substring miss", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "spam@elsewhere.com" } },
      subject: "Scheduled Report Notification",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(false);
  });

  it("rejects when subject substring miss", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "porsche-academy-notification@porsche.de" } },
      subject: "Holiday party invite",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(false);
  });

  it("matches case-insensitively", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "PORSCHE-ACADEMY-NOTIFICATION@PORSCHE.DE" } },
      subject: "scheduled report notification",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(true);
  });

  it("matches when filters are empty (everything passes)", () => {
    const a = { ...automation, inbox_filters: {} };
    expect(messageMatchesAutomation({ id: "1", subject: "anything" }, a)).toBe(true);
  });
});

describe("detectSourceType", () => {
  it("returns porsche_xlsx for .xlsx + spreadsheet mime", () => {
    expect(
      detectSourceType(
        "report.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        automation,
      ),
    ).toBe("porsche_xlsx");
  });

  it("returns porsche_xlsx for .csv + text/csv", () => {
    expect(detectSourceType("report.csv", "text/csv", automation)).toBe("porsche_xlsx");
  });

  it("returns null when filename is unrecognized", () => {
    expect(detectSourceType("README.md", "text/markdown", automation)).toBeNull();
  });

  it("returns null when porsche_xlsx parser is not registered", () => {
    const a: AutomationDefinition = { ...automation, parsers: {} };
    expect(detectSourceType("report.xlsx", "spreadsheet", a)).toBeNull();
  });
});

describe("getMailboxBase · routes to /me by default and /users/<upn> when env set", () => {
  // The 4 Graph mail-read sites in inbox-poller.ts compose URLs as
  // `https://graph.microsoft.com/v1.0${getMailboxBase()}/...`. Confirm
  // both branches so a future env-var flip to a shared mailbox can't
  // silently keep polling /me.
  const ORIGINAL = process.env.AUTOMATION_POLL_MAILBOX_UPN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AUTOMATION_POLL_MAILBOX_UPN;
    else process.env.AUTOMATION_POLL_MAILBOX_UPN = ORIGINAL;
  });

  it("returns /me when env var is unset (default — operator's own inbox)", () => {
    delete process.env.AUTOMATION_POLL_MAILBOX_UPN;
    expect(getMailboxBase()).toBe("/me");
  });

  it("returns /me when env var is empty or whitespace-only", () => {
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "   ";
    expect(getMailboxBase()).toBe("/me");
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "";
    expect(getMailboxBase()).toBe("/me");
  });

  it("returns /users/<encoded-upn> when env var is set", () => {
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "pcna-automation@thewolfpack.agency";
    // The @ in the UPN must be URL-encoded so Graph parses it as a
    // single path segment, not a host.
    expect(getMailboxBase()).toBe("/users/pcna-automation%40thewolfpack.agency");
  });

  it("trims surrounding whitespace before encoding (Vercel env vars have a trailing-newline history)", () => {
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "  pcna-automation@thewolfpack.agency\n";
    expect(getMailboxBase()).toBe("/users/pcna-automation%40thewolfpack.agency");
  });
});

describe("pollInbox · soft-fail when no user is connected", () => {
  beforeEach(() => {
    (getAutomation as jest.Mock).mockReturnValue(automation);
    (getValidToken as jest.Mock).mockReset();
  });

  it("returns skipped:'no_user_connected' (not 500) when no token", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce(null);

    const result = await pollInbox({
      automationId: "porsche-classes",
      userId: "automation-cron",
      userRole: "ops",
    });

    expect(result.skipped).toBe("no_user_connected");
    expect(result.messages_seen).toBe(0);
    expect(result.errors).toBe(0);
    // The poller must NOT throw — cron health stays green during bootstrap.
  });
});

describe("search-mode poll cursor (search:<iso>)", () => {
  const { parseSearchCursor, formatSearchCursor } = __searchModeInternalsForTests;

  it("parses a stored search:<iso> cursor", () => {
    expect(parseSearchCursor("search:2026-04-27T12:34:56.789Z")).toBe(
      "2026-04-27T12:34:56.789Z",
    );
  });

  it("returns null for null / empty / non-search-prefixed cursors (delta-link compatibility)", () => {
    expect(parseSearchCursor(null)).toBeNull();
    expect(parseSearchCursor("")).toBeNull();
    expect(parseSearchCursor("https://graph.microsoft.com/v1.0/...")).toBeNull();
  });

  it("rejects malformed search-prefixed cursors (defense-in-depth)", () => {
    expect(parseSearchCursor("search:not-an-iso")).toBeNull();
    expect(parseSearchCursor("search:")).toBeNull();
  });

  it("round-trips format → parse", () => {
    const iso = "2026-04-27T18:00:00.000Z";
    expect(parseSearchCursor(formatSearchCursor(iso))).toBe(iso);
  });
});

describe("pollInbox dispatch · routes to search mode when AUTOMATION_POLL_MAILBOX_UPN is set", () => {
  // The privacy-critical decision: when reading a mailbox the operator
  // doesn't own (Alicia's, a future shared mailbox), the cron MUST use
  // server-side $search so only matching messages cross the wire. This
  // test asserts the dispatch — pollInbox() with the env var set never
  // calls listMailDelta (the unfiltered path).
  const { listMailDelta } = jest.requireMock("@/lib/ms-graph/client") as {
    listMailDelta: jest.Mock;
  };
  const ORIGINAL = process.env.AUTOMATION_POLL_MAILBOX_UPN;
  const realFetch = global.fetch;

  beforeEach(() => {
    (getAutomation as jest.Mock).mockReturnValue(automation);
    (getValidToken as jest.Mock).mockReset();
    listMailDelta.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AUTOMATION_POLL_MAILBOX_UPN;
    else process.env.AUTOMATION_POLL_MAILBOX_UPN = ORIGINAL;
    global.fetch = realFetch;
  });

  it("when env var is set, calls Graph search endpoint and NEVER calls listMailDelta", async () => {
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "alicia@thewolfpack.agency";
    (getValidToken as jest.Mock).mockResolvedValueOnce({ accessToken: "t" });
    let capturedUrl = "";
    global.fetch = jest.fn(async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ value: [] }) } as Response;
    }) as unknown as typeof fetch;

    await pollInbox({ automationId: "porsche-classes", userId: "u1", userRole: "ops" });

    expect(listMailDelta).not.toHaveBeenCalled();
    expect(capturedUrl).toContain("/users/alicia%40thewolfpack.agency/mailFolders/inbox/messages");
    // Server-side filter is applied — the URL must contain $search.
    expect(capturedUrl).toContain("%24search=");
    expect(capturedUrl).toContain("from%3A");
  });

  it("when env var is unset, does NOT call the search-mode fetch (delta path runs)", async () => {
    delete process.env.AUTOMATION_POLL_MAILBOX_UPN;
    (getValidToken as jest.Mock).mockResolvedValueOnce(null); // soft-fail before listMailDelta
    const fetchSpy = jest.fn() as jest.Mock;
    global.fetch = fetchSpy as unknown as typeof fetch;

    await pollInbox({ automationId: "porsche-classes", userId: "u1", userRole: "ops" });

    // Search-mode never runs — the dispatch sent us to delta which soft-failed.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to poll the shared mailbox when filter list is empty (privacy guard)", async () => {
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "alicia@thewolfpack.agency";
    (getAutomation as jest.Mock).mockReturnValueOnce({
      ...automation,
      inbox_filters: { sender_match: [], subject_match: [] },
    });
    (getValidToken as jest.Mock).mockResolvedValueOnce({ accessToken: "t" });
    const fetchSpy = jest.fn() as jest.Mock;
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await pollInbox({
      automationId: "porsche-classes",
      userId: "u1",
      userRole: "ops",
    });

    // No filters in search mode = HARD STOP. Graph fetch must never fire.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.skipped).toBeDefined();
    expect(result.messages_seen).toBe(0);
  });

  it("fetches per-message body detail (Graph $search omits body in list response)", async () => {
    // Regression — 2026-04-27. The first cron tick against Alicia's
    // mailbox quarantined the BA101 Ritz Carlton coordinator email
    // because Graph $search returned the message WITHOUT the body
    // field, so the synthesized .eml had only bodyPreview and the
    // Cognito parser saw no text/html part. The fix: per-message
    // detail GET for ?$select=body,ccRecipients before processing.
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "alicia@thewolfpack.agency";
    (getValidToken as jest.Mock).mockResolvedValueOnce({ accessToken: "t" });
    const fetchSpy = jest.fn(async (url: string) => {
      const u = String(url);
      // URL.searchParams.set percent-encodes the $; the actual URL
      // contains %24search=, not $search=. The body-detail GET uses
      // a template literal so $select stays literal there.
      if (u.includes("%24search=")) {
        // Search list response — note no body field, mimicking Graph's actual behavior.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: "msg-1",
                // Match the test automation's filter (porsche-academy sender +
                // Scheduled Report Notification subject — see automation
                // const at top of file). The body-detail fetch is what we're
                // asserting; the sender shape is incidental.
                subject: "Scheduled Report Notification",
                from: { emailAddress: { address: "porsche-academy-notification@porsche.de" } },
                receivedDateTime: "2026-04-27T13:00:00Z",
                bodyPreview: "truncated...",
                hasAttachments: false,
                // body deliberately absent — Graph's $search list response
                // omits the body field even when $select includes it.
              },
            ],
          }),
        } as Response;
      }
      // Per-message body-detail GET.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          body: { contentType: "html", content: "<html><body>full email</body></html>" },
          ccRecipients: [],
        }),
      } as Response;
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await pollInbox({ automationId: "porsche-classes", userId: "u1", userRole: "ops" });

    // Two fetches: the $search list, then the per-message body GET.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const detailCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/messages/msg-1") && String(c[0]).includes("$select=body"),
    );
    expect(detailCall).toBeDefined();
    expect(String(detailCall![0])).toContain("/users/alicia%40thewolfpack.agency");
  });

  it("emits trackEvent with mode:'search' when the search path runs", async () => {
    process.env.AUTOMATION_POLL_MAILBOX_UPN = "alicia@thewolfpack.agency";
    (getValidToken as jest.Mock).mockResolvedValueOnce({ accessToken: "t" });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as unknown as typeof fetch;
    const { trackEvent } = jest.requireMock("@/lib/analytics") as {
      trackEvent: jest.Mock;
    };
    trackEvent.mockClear();

    await pollInbox({ automationId: "porsche-classes", userId: "u1", userRole: "ops" });

    const calls = trackEvent.mock.calls;
    const runCall = calls.find((c) => c[0] === "automations.poll_run");
    expect(runCall).toBeDefined();
    expect(runCall![3]).toMatchObject({ mode: "search" });
  });
});

describe("pollInboxHistorical · $search-based historical scan", () => {
  const realFetch = global.fetch;
  let lastFetchUrl = "";

  function mockFetch(items: unknown[], status = 200) {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      lastFetchUrl = String(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ value: items }),
        text: async () => JSON.stringify({ value: items }),
      } as Response;
    }) as typeof fetch;
  }

  beforeEach(() => {
    (getAutomation as jest.Mock).mockReturnValue(automation);
    (getValidToken as jest.Mock).mockReset();
    (getValidToken as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      userEmail: "u@x",
    });
    lastFetchUrl = "";
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns skipped:'no_user_connected' when no token", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce(null);
    const { pollInboxHistorical } = await import("@/lib/automations/inbox-poller");
    const r = await pollInboxHistorical({
      automationId: "porsche-classes",
      userId: "u-1",
      userRole: "ops",
      filters: { sender_match: ["porsche-academy-notification@porsche.de"] },
    });
    expect(r.skipped).toBe("no_user_connected");
  });

  it("uses $search when filters are provided", async () => {
    mockFetch([]);
    const { pollInboxHistorical } = await import("@/lib/automations/inbox-poller");
    await pollInboxHistorical({
      automationId: "porsche-classes",
      userId: "u-1",
      userRole: "ops",
      filters: { sender_match: ["nick@thewolfpack.agency"] },
    });
    expect(lastFetchUrl).toContain("%24search");
    /* Bare email (no spaces / dashes) goes through unwrapped; URL-encoded "@" is %40. */
    expect(lastFetchUrl).toContain("from%3Anick%40thewolfpack.agency");
  });

  it("single-quotes KQL values that contain dashes", async () => {
    mockFetch([]);
    const { pollInboxHistorical } = await import("@/lib/automations/inbox-poller");
    await pollInboxHistorical({
      automationId: "porsche-classes",
      userId: "u-1",
      userRole: "ops",
      filters: { sender_match: ["porsche-academy-notification@porsche.de"] },
    });
    /* %27 is a single quote — wrapping is required because KQL needs the
       value quoted when it contains a dash. */
    expect(lastFetchUrl).toContain(
      "from%3A%27porsche-academy-notification%40porsche.de%27",
    );
  });

  it("falls back to $orderby when no filters typed", async () => {
    mockFetch([]);
    const { pollInboxHistorical } = await import("@/lib/automations/inbox-poller");
    await pollInboxHistorical({
      automationId: "porsche-classes",
      userId: "u-1",
      userRole: "ops",
      filters: { sender_match: [], subject_match: [] },
    });
    expect(lastFetchUrl).not.toContain("%24search");
    expect(lastFetchUrl).toContain("%24orderby");
  });

  it("returns errors:1 when Graph returns non-OK", async () => {
    mockFetch([], 400);
    const { pollInboxHistorical } = await import("@/lib/automations/inbox-poller");
    const r = await pollInboxHistorical({
      automationId: "porsche-classes",
      userId: "u-1",
      userRole: "ops",
      filters: { sender_match: ["porsche-academy-notification@porsche.de"] },
    });
    expect(r.errors).toBe(1);
    expect(r.messages_seen).toBe(0);
  });

  it("returns skipped:'no_valid_token' on 401", async () => {
    mockFetch([], 401);
    const { pollInboxHistorical } = await import("@/lib/automations/inbox-poller");
    const r = await pollInboxHistorical({
      automationId: "porsche-classes",
      userId: "u-1",
      userRole: "ops",
      filters: { sender_match: ["x"] },
    });
    expect(r.skipped).toBe("no_valid_token");
  });
});

describe("pollInboxByDelta · inbox-list fallback when delta returns 0", () => {
  // Regression — 2026-04-28. After Microsoft moved support@thewolfpack.agency
  // to a different Exchange backend, /me/mailFolders/inbox/messages/delta
  // started returning 0 items for homyk@thewolfpack.agency even though
  // /me/mailFolders/inbox/messages was returning fresh emails. Confirmed
  // via graph-probe. The poller now falls back to a direct inbox list
  // when delta returns nothing, so ingest doesn't stall while Microsoft
  // rebuilds the per-mailbox delta index.
  const { listMailDelta } = jest.requireMock("@/lib/ms-graph/client") as {
    listMailDelta: jest.Mock;
  };
  const realFetch = global.fetch;
  const ORIGINAL_UPN = process.env.AUTOMATION_POLL_MAILBOX_UPN;

  beforeEach(() => {
    delete process.env.AUTOMATION_POLL_MAILBOX_UPN; // force delta path
    (getAutomation as jest.Mock).mockReturnValue({
      ...automation,
      inbox_filters: {
        sender_match: ["notifications@cognitoforms.com"],
        subject_match: ["Instructor Class Report"],
      },
    });
    (getValidToken as jest.Mock).mockReset();
    listMailDelta.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_UPN === undefined) delete process.env.AUTOMATION_POLL_MAILBOX_UPN;
    else process.env.AUTOMATION_POLL_MAILBOX_UPN = ORIGINAL_UPN;
    global.fetch = realFetch;
  });

  it("falls back to /me/mailFolders/inbox/messages when delta returns 0 items", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "homyk@thewolfpack.agency",
    });
    listMailDelta.mockResolvedValueOnce({ items: [], nextDeltaLink: undefined });

    let capturedUrl = "";
    let capturedAuth = "";
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = String(
        (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "msg-cognito-1",
              subject: "Instructor Class Report - Declan Mulready",
              from: {
                emailAddress: { address: "notifications@cognitoforms.com" },
              },
              receivedDateTime: "2026-04-28T14:27:08Z",
              hasAttachments: false,
              bodyPreview: "Entry Details Name Declan Mulready",
            },
          ],
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await pollInbox({
      automationId: "porsche-classes",
      userId: "homyk@thewolfpack.agency",
      userRole: "ops",
    });

    expect(listMailDelta).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain("/me/mailFolders/inbox/messages");
    expect(capturedUrl).toContain("receivedDateTime");
    expect(capturedAuth).toBe("Bearer tok-abc");
    expect(result.messages_seen).toBe(1);
    expect(result.messages_matched).toBe(1);
  });

  it("does NOT save deltaLink when fallback was used", async () => {
    const { writeQuery } = jest.requireMock("@/lib/db") as {
      writeQuery: jest.Mock;
    };
    writeQuery.mockClear();

    (getValidToken as jest.Mock).mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "homyk@thewolfpack.agency",
    });
    /* Delta returns 0 items but DOES return a fresh nextDeltaLink (Graph
       behavior during a delta-rebuild window — it hands back a token
       even though it has no items to deliver). The poller must NOT
       persist that link, otherwise the next tick reads the empty delta
       and the fallback never fires. */
    listMailDelta.mockResolvedValueOnce({
      items: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/...$deltatoken=fresh",
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as unknown as typeof fetch;

    await pollInbox({
      automationId: "porsche-classes",
      userId: "homyk@thewolfpack.agency",
      userRole: "ops",
    });

    /* Inspect writeQuery — only the saveDeltaLink path goes through it.
       If fallback was used, no INSERT INTO instinct_automation_porsche_poll_state
       call should have happened. */
    const wroteDeltaLink = writeQuery.mock.calls.some((args: unknown[]) =>
      typeof args[0] === "string" &&
      (args[0] as string).includes("instinct_automation_porsche_poll_state"),
    );
    expect(wroteDeltaLink).toBe(false);
  });

  it("when fallback also returns 0, reports messages_seen:0 cleanly", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "homyk@thewolfpack.agency",
    });
    listMailDelta.mockResolvedValueOnce({ items: [], nextDeltaLink: undefined });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as unknown as typeof fetch;

    const result = await pollInbox({
      automationId: "porsche-classes",
      userId: "homyk@thewolfpack.agency",
      userRole: "ops",
    });

    expect(result.messages_seen).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("survives a fallback fetch error without throwing", async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "homyk@thewolfpack.agency",
    });
    listMailDelta.mockResolvedValueOnce({ items: [], nextDeltaLink: undefined });
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "ServiceUnavailable",
    })) as unknown as typeof fetch;

    const result = await pollInbox({
      automationId: "porsche-classes",
      userId: "homyk@thewolfpack.agency",
      userRole: "ops",
    });

    expect(result.messages_seen).toBe(0);
    /* The fallback failure is logged via console.warn and SHOULD NOT
       count as a hard error — the next poll will retry. */
    expect(result.errors).toBe(0);
  });
});
