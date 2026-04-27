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

import {
  messageMatchesAutomation,
  detectSourceType,
  pollInbox,
  getMailboxBase,
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
