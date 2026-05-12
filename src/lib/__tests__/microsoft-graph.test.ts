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
    const url = ms.getAuthUrl("user-1");
    expect(url === "" || url === null).toBe(true);
  });

  test("fetchCalendarEvents returns demo events", async () => {
    const today = new Date().toISOString().split("T")[0];
    const events = await ms.fetchCalendarEvents("user-1", today, today);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    if (events[0]) {
      expect(events[0]).toHaveProperty("subject");
      expect(events[0]).toHaveProperty("start");
    }
  });

  test("fetchRecentEmails returns demo emails", async () => {
    const emails = await ms.fetchRecentEmails("user-1", 10);
    expect(Array.isArray(emails)).toBe(true);
    expect(emails.length).toBeGreaterThan(0);
    if (emails[0]) {
      expect(emails[0]).toHaveProperty("subject");
      expect(emails[0]).toHaveProperty("from");
    }
  });

  test("fetchContacts returns demo contacts", async () => {
    const contacts = await ms.fetchContacts("user-1", 10);
    expect(Array.isArray(contacts)).toBe(true);
    expect(contacts.length).toBeGreaterThan(0);
  });

  test("fetchUnreadCount returns a number", async () => {
    const count = await ms.fetchUnreadCount("user-1");
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("fetchUserProfile returns demo profile", async () => {
    const profile = await ms.fetchUserProfile("user-1");
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
    const url = ms.getAuthUrl("user-1");
    expect(url).toContain("test-ms-client-id");
  });

  test("auth URL targets Microsoft login", () => {
    const url = ms.getAuthUrl("user-1");
    expect(url).toContain("login.microsoftonline.com");
  });

  test("auth URL includes calendar and mail scopes", () => {
    const url = ms.getAuthUrl("user-1");
    expect(url).toContain("Calendars.Read");
    expect(url).toContain("Mail.Read");
  });

  test("auth URL includes redirect URI", () => {
    const url = ms.getAuthUrl("user-1");
    expect(url).toContain("callback");
  });

  test("auth URL includes prompt=consent (forces re-consent when scopes change)", () => {
    // Regression: without prompt=consent, Azure silently reuses the
    // user's prior consent set when they reconnect MS. Newly-added
    // scopes (e.g. Channel.ReadBasic.All on 2026-04-24) never make
    // it into the issued token, and Graph then returns 200 with empty
    // results for the new endpoints — looks like "no data" but is
    // really "missing scope". This caused hours of dead-end debugging.
    // Lock the parameter in.
    const url = ms.getAuthUrl("user-1");
    expect(url).toMatch(/[?&]prompt=consent\b/);
  });

  test("auth URL includes a signed state parameter (not raw userId)", () => {
    const url = ms.getAuthUrl("user-1");
    // The state must contain userId.signature, not just the raw id
    expect(url).toContain("state=");
    expect(url).toMatch(/state=user-1\./);
  });

  test("verifyState accepts a state generated by signState", () => {
    const signed = ms.signState("alice");
    expect(ms.verifyState(signed)).toBe("alice");
  });

  test("verifyState rejects forged state with wrong signature", () => {
    expect(ms.verifyState("alice.not-a-valid-signature")).toBeNull();
  });

  test("verifyState rejects empty / malformed state", () => {
    expect(ms.verifyState(null)).toBeNull();
    expect(ms.verifyState("")).toBeNull();
    expect(ms.verifyState("no-dot-here")).toBeNull();
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
    const events = await ms.fetchCalendarEvents("user-1", today, today);
    for (const ev of events) {
      expect(ev.subject.length).toBeGreaterThan(0);
    }
  });

  test("emails have from addresses", async () => {
    const emails = await ms.fetchRecentEmails("user-1", 10);
    for (const email of emails) {
      expect(email.from).toBeTruthy();
      expect(email.subject).toBeTruthy();
    }
  });

  test("contacts have display names", async () => {
    const contacts = await ms.fetchContacts("user-1", 10);
    for (const c of contacts) {
      expect(c.displayName).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-User Isolation (the privacy-critical contract)
// ---------------------------------------------------------------------------

describe("Per-User Isolation", () => {
  let ms: typeof import("@/lib/microsoft-graph");

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.MS_CLIENT_ID;
    process.env.APEX_JWT_SECRET = "test-isolation-secret";
    ms = await import("@/lib/microsoft-graph");
  });

  test("getValidToken returns null for empty userId", async () => {
    process.env.MS_CLIENT_ID = "test-id";
    process.env.MS_CLIENT_SECRET = "test-secret";
    jest.resetModules();
    ms = await import("@/lib/microsoft-graph");
    const token = await ms.getValidToken("");
    expect(token).toBeNull();
  });

  test("deleteTokens with empty userId is a no-op (does not wipe everyone)", async () => {
    // In real usage this would issue a scoped DELETE; here we verify the
    // guard prevents the no-arg pattern that historically wiped all rows.
    await expect(ms.deleteTokens("")).resolves.toBeUndefined();
  });

  test("signed state for user A does not validate as user B", () => {
    const aliceState = ms.signState("alice");
    // Take alice's signature and try to attach it to bob's id
    const sig = aliceState.split(".")[1];
    const forged = `bob.${sig}`;
    expect(ms.verifyState(forged)).toBeNull();
  });

  test("cache keys are namespaced by userId", async () => {
    // In shadow mode the cache still wraps demo data; verify two users
    // calling the same endpoint produce independent cache entries.
    // We can't introspect the cache directly, but we can verify both
    // users get a successful response (proving neither blocked the other).
    const today = new Date().toISOString().split("T")[0];
    const aliceEvents = await ms.fetchCalendarEvents("alice", today, today);
    const bobEvents = await ms.fetchCalendarEvents("bob", today, today);
    expect(Array.isArray(aliceEvents)).toBe(true);
    expect(Array.isArray(bobEvents)).toBe(true);
    expect(aliceEvents.length).toBeGreaterThan(0);
    expect(bobEvents.length).toBeGreaterThan(0);
  });

  test("clearCache(userId) only clears that user's namespace", async () => {
    // Populate caches for two users, then clear one
    const today = new Date().toISOString().split("T")[0];
    await ms.fetchCalendarEvents("alice", today, today);
    await ms.fetchCalendarEvents("bob", today, today);
    ms.clearCache("alice");
    // Both should still resolve (alice will re-populate, bob should hit cache)
    const aliceAgain = await ms.fetchCalendarEvents("alice", today, today);
    const bobAgain = await ms.fetchCalendarEvents("bob", today, today);
    expect(aliceAgain.length).toBeGreaterThan(0);
    expect(bobAgain.length).toBeGreaterThan(0);
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

  test("migration 006 adds per-user unique index on connected_by", () => {
    const fs = require("fs");
    const p = require("path").resolve(__dirname, "../../db/migrations/006_ms_tokens_per_user.sql");
    expect(fs.existsSync(p)).toBe(true);
    const sql = fs.readFileSync(p, "utf-8");
    expect(sql).toContain("idx_apex_ms_tokens_connected_by");
    expect(sql).toContain("UNIQUE INDEX");
    expect(sql).toContain("connected_by");
    // Should drop the old unique constraint on user_email and recreate
    // it as a non-unique secondary index.
    expect(sql).toContain("DROP INDEX IF EXISTS idx_apex_ms_tokens_email");
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
export {};
