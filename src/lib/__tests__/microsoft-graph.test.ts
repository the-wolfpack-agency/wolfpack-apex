/**
 * Microsoft Graph Integration Tests
 *
 * Tests cover:
 *   - OAuth2 URL generation
 *   - Shadow mode demo data for all fetchers
 *   - Calendar event data shape
 *   - Email data shape
 *   - Contact data shape
 *   - Demo data quality (realistic CEO day)
 *   - Error handling
 *   - Migration file
 *   - Analytics event types
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_REDIRECT_URI;
  delete process.env.MS_TENANT_ID;
});

// ---------------------------------------------------------------------------
// Shadow Mode
// ---------------------------------------------------------------------------

describe("Shadow Mode (no MS credentials)", () => {
  let ms: typeof import("@/lib/microsoft-graph");

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.MS_CLIENT_ID;
    ms = await import("@/lib/microsoft-graph");
  });

  test("getAuthUrl returns empty or null in shadow mode", () => {
    const url = ms.getAuthUrl();
    expect(url === "" || url === null).toBe(true);
  });

  test("fetchCalendarEvents returns demo events", async () => {
    const today = new Date().toISOString().split("T")[0];
    const events = await ms.fetchCalendarEvents(today, today);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    if (events[0]) {
      expect(events[0]).toHaveProperty("subject");
      expect(events[0]).toHaveProperty("start");
    }
  });

  test("fetchRecentEmails returns demo emails", async () => {
    const emails = await ms.fetchRecentEmails(10);
    expect(Array.isArray(emails)).toBe(true);
    expect(emails.length).toBeGreaterThan(0);
    if (emails[0]) {
      expect(emails[0]).toHaveProperty("subject");
      expect(emails[0]).toHaveProperty("from");
    }
  });

  test("fetchContacts returns demo contacts", async () => {
    const contacts = await ms.fetchContacts(10);
    expect(Array.isArray(contacts)).toBe(true);
    expect(contacts.length).toBeGreaterThan(0);
  });

  test("fetchUnreadCount returns a number", async () => {
    const count = await ms.fetchUnreadCount();
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("fetchUserProfile returns demo profile", async () => {
    const profile = await ms.fetchUserProfile();
    expect(profile).not.toBeNull();
    expect(profile!.displayName).toBeTruthy();
    expect(profile!.email).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// OAuth2
// ---------------------------------------------------------------------------

describe("OAuth2 URL Generation", () => {
  let ms: typeof import("@/lib/microsoft-graph");

  beforeEach(async () => {
    jest.resetModules();
    process.env.MS_CLIENT_ID = "test-ms-client-id";
    process.env.MS_CLIENT_SECRET = "test-ms-secret";
    process.env.MS_REDIRECT_URI = "https://wolfpack-instinct.vercel.app/api/microsoft/callback";
    ms = await import("@/lib/microsoft-graph");
  });

  test("generates auth URL containing client ID", () => {
    const url = ms.getAuthUrl();
    expect(url).toContain("test-ms-client-id");
  });

  test("auth URL targets Microsoft login", () => {
    const url = ms.getAuthUrl();
    expect(url).toContain("login.microsoftonline.com");
  });

  test("auth URL includes calendar and mail scopes", () => {
    const url = ms.getAuthUrl();
    expect(url).toContain("Calendars.Read");
    expect(url).toContain("Mail.Read");
  });

  test("auth URL includes redirect URI", () => {
    const url = ms.getAuthUrl();
    expect(url).toContain("callback");
  });
});

// ---------------------------------------------------------------------------
// Demo Data Quality
// ---------------------------------------------------------------------------

describe("Demo Data Quality", () => {
  let ms: typeof import("@/lib/microsoft-graph");

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.MS_CLIENT_ID;
    ms = await import("@/lib/microsoft-graph");
  });

  test("calendar events have realistic subjects", async () => {
    const today = new Date().toISOString().split("T")[0];
    const events = await ms.fetchCalendarEvents(today, today);
    for (const ev of events) {
      expect(ev.subject.length).toBeGreaterThan(0);
    }
  });

  test("emails have from addresses", async () => {
    const emails = await ms.fetchRecentEmails(10);
    for (const email of emails) {
      expect(email.from).toBeTruthy();
      expect(email.subject).toBeTruthy();
    }
  });

  test("contacts have display names", async () => {
    const contacts = await ms.fetchContacts(10);
    for (const c of contacts) {
      expect(c.displayName).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  let ms: typeof import("@/lib/microsoft-graph");

  beforeEach(async () => {
    jest.resetModules();
    process.env.MS_CLIENT_ID = "test-id";
    process.env.MS_CLIENT_SECRET = "test-secret";
    ms = await import("@/lib/microsoft-graph");
  });

  test("exchangeCode returns null on API failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    }) as any;

    const result = await ms.exchangeCode("bad-code");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("Migration File", () => {
  test("migration 005 exists", () => {
    const fs = require("fs");
    const p = require("path").resolve(__dirname, "../../db/migrations/005_microsoft_graph.sql");
    expect(fs.existsSync(p)).toBe(true);
  });

  test("migration creates apex_ms_tokens table", () => {
    const fs = require("fs");
    const sql = fs.readFileSync(
      require("path").resolve(__dirname, "../../db/migrations/005_microsoft_graph.sql"),
      "utf-8",
    );
    expect(sql).toContain("apex_ms_tokens");
    expect(sql).toContain("access_token");
    expect(sql).toContain("refresh_token");
    expect(sql).toContain("user_email");
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe("Analytics Event Types", () => {
  test("Microsoft event types are registered", () => {
    const fs = require("fs");
    const analytics = fs.readFileSync(
      require("path").resolve(__dirname, "../analytics.ts"),
      "utf-8",
    );
    expect(analytics).toContain("microsoft.api_called");
    expect(analytics).toContain("microsoft.connected");
    expect(analytics).toContain("microsoft.disconnected");
  });
});
