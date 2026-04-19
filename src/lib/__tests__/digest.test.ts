/**
 * digest.test.ts — digest builder + sender behavior.
 *
 * Covers:
 *   - buildDigestForUser groups by category
 *   - buildDigestForUser drops categories set to "off" in overrides (except critical)
 *   - buildDigestForUser filters out expired + read + dismissed via SQL
 *   - sendDigests skips users whose email_digest is "off"
 *   - sendDigests respects timezone morning window
 *   - sendDigests skip_empty when no unread
 *   - sendDigests force=true bypasses window filter
 *   - sendDigests emits system.notification_digest_sent
 *   - isInMorningWindow respects tz + window bounds
 */

 

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  query: (...a: unknown[]) => mockSafeQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  buildDigestForUser,
  sendDigests,
  isInMorningWindow,
} from "@/lib/notifications/digest";

beforeEach(() => {
  jest.clearAllMocks();
});

function notifRow(
  override: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "n-" + Math.random().toString(36).slice(2, 8),
    user_id: "u1",
    category: "tasks.due_soon",
    priority: "normal",
    title: "t",
    body: "b",
    source: "tasks",
    metadata: {},
    created_at: new Date().toISOString(),
    ...override,
  };
}

describe("buildDigestForUser()", () => {
  test("groups unread notifications by category", async () => {
    // 1) getPreferences → empty row (use defaults)
    // 2) SELECT unread
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({
        rows: [
          notifRow({ category: "tasks.due_soon" }),
          notifRow({ category: "tasks.due_soon" }),
          notifRow({ category: "hr.onboarding_stalled" }),
        ],
        fromCache: false,
      });

    const payload = await buildDigestForUser("u1", "daily");
    expect(payload.total).toBe(3);
    expect(payload.groups).toHaveLength(2);
    const tasks = payload.groups.find((g) => g.category === "tasks.due_soon");
    expect(tasks?.notifications).toHaveLength(2);
  });

  test("category override 'off' drops that category (non-critical)", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            user_id: "u1",
            in_app: true,
            email_digest: "daily",
            quiet_hours_start: null,
            quiet_hours_end: null,
            timezone: "UTC",
            category_overrides: { "tasks.due_soon": "off" },
            updated_at: new Date().toISOString(),
          },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({
        rows: [
          notifRow({ category: "tasks.due_soon" }),
          notifRow({ category: "hr.onboarding_stalled" }),
        ],
        fromCache: false,
      });

    const payload = await buildDigestForUser("u1", "daily");
    expect(payload.total).toBe(1);
    expect(payload.groups[0].category).toBe("hr.onboarding_stalled");
  });

  test("critical priority is NEVER dropped by category override", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            user_id: "u1",
            in_app: true,
            email_digest: "daily",
            quiet_hours_start: null,
            quiet_hours_end: null,
            timezone: "UTC",
            category_overrides: { "security.login_unusual": "off" },
            updated_at: new Date().toISOString(),
          },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({
        rows: [
          notifRow({ category: "security.login_unusual", priority: "critical" }),
        ],
        fromCache: false,
      });

    const payload = await buildDigestForUser("u1", "daily");
    expect(payload.total).toBe(1);
    expect(payload.groups[0].category).toBe("security.login_unusual");
  });

  test("weekly window uses 7d horizon in the SQL param", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    await buildDigestForUser("u1", "weekly");
    const call = mockSafeQuery.mock.calls[1];
    const params = call[1] as unknown[];
    // Second param is start time; check it's ~7d ago
    const start = new Date(params[1] as string).getTime();
    const diffDays = (Date.now() - start) / (86_400_000);
    expect(diffDays).toBeGreaterThan(6.5);
    expect(diffDays).toBeLessThan(7.5);
  });
});

describe("isInMorningWindow()", () => {
  test("returns true inside window, false outside", () => {
    // Fix a UTC time; compare against UTC tz with an 0–24 window trick
    const d = new Date(Date.UTC(2026, 0, 1, 8, 0, 0));
    expect(isInMorningWindow("UTC", d, 7, 9)).toBe(true);
    expect(isInMorningWindow("UTC", d, 9, 11)).toBe(false);
  });

  test("different timezones give different results", () => {
    // 12:00 UTC is 07:00 America/New_York (winter, no DST) → in window
    const d = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(isInMorningWindow("America/New_York", d, 7, 9)).toBe(true);
    // Same instant in UTC is 12:00 → outside 7–9 window
    expect(isInMorningWindow("UTC", d, 7, 9)).toBe(false);
  });

  test("invalid timezone returns false without throwing", () => {
    expect(isInMorningWindow("Not/ATimezone", new Date())).toBe(false);
  });
});

describe("sendDigests()", () => {
  test("skips users whose email_digest is 'off'", async () => {
    // prefs query
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ user_id: "u_off", email_digest: "off", timezone: "UTC" }],
        fromCache: false,
      })
      // no defaults lookup for daily? It will run. Return empty.
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const result = await sendDigests({
      window: "daily",
      sender,
      now: new Date(Date.UTC(2026, 0, 1, 8, 0, 0)),
    });
    expect(result.skipped_off).toBe(1);
    expect(result.sent).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
  });

  test("skips users outside morning window when force=false", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ user_id: "u_late", email_digest: "daily", timezone: "UTC" }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const result = await sendDigests({
      window: "daily",
      sender,
      now: new Date(Date.UTC(2026, 0, 1, 23, 0, 0)), // 23:00 UTC — way past 07–09
    });
    expect(result.skipped_outside_window).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
  });

  test("force=true bypasses window filter and sends", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ user_id: "u_any", email_digest: "daily", timezone: "UTC" }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      // buildDigestForUser: prefs
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      // buildDigestForUser: notifs
      .mockResolvedValueOnce({
        rows: [{
          id: "n1",
          user_id: "u_any",
          category: "hr.onboarding_stalled",
          priority: "normal",
          title: "t",
          source: "hr",
          metadata: {},
          created_at: new Date().toISOString(),
        }],
        fromCache: false,
      });

    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const result = await sendDigests({
      window: "daily",
      sender,
      now: new Date(Date.UTC(2026, 0, 1, 23, 0, 0)),
      force: true,
    });
    expect(result.sent).toBe(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_digest_sent",
      "u_any",
      "system",
      expect.objectContaining({ user_id: "u_any", count: 1, window: "daily" }),
    );
  });

  test("skips users with zero unread (skipped_empty)", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ user_id: "u_empty", email_digest: "daily", timezone: "UTC" }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      // buildDigestForUser: prefs
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      // buildDigestForUser: notifs
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const result = await sendDigests({
      window: "daily",
      sender,
      force: true,
    });
    expect(result.skipped_empty).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "system.notification_digest_sent",
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });
});
