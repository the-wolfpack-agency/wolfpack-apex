/**
 * notify.test.ts — unit tests for the in-app notifications library.
 *
 * Covers:
 *   - create + return id
 *   - dedup path skips insert when matching unread row exists
 *   - expiresInHours sets expires_at
 *   - critical priority accepted
 *   - preferences in_app=false still records, but auto-dismisses
 *   - mark read emits seconds_to_read analytics
 *   - updatePreferences validates enum values
 *   - updatePreferences emits changes list
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  notify,
  notifyMany,
  markRead,
  markAllRead,
  dismiss,
  recordClick,
  listUnread,
  listAll,
  unreadCount,
  getPreferences,
  updatePreferences,
} from "@/lib/notifications/in-app";

beforeEach(() => {
  jest.clearAllMocks();
  // Default preferences: user with no row
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  mockQuery.mockResolvedValue({ rows: [{ id: "notif-1" }] });
});

describe("notify()", () => {
  test("creates a row and emits system.notification_created", async () => {
    const result = await notify({
      userId: "u1",
      category: "hr.onboarding_stalled",
      title: "You have 2 pending onboarding tasks",
      source: "hr",
    });
    expect(result).toEqual({ id: "notif-1" });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO instinct_notifications");
    expect(params[0]).toBe("u1");
    expect(params[1]).toBe("hr.onboarding_stalled");
    expect(params[2]).toBe("normal"); // default priority

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_created",
      "u1",
      "system",
      expect.objectContaining({
        notification_id: "notif-1",
        category: "hr.onboarding_stalled",
        priority: "normal",
        source: "hr",
      }),
    );
  });

  test("rejects missing required fields", async () => {
    await expect(
      notify({
        userId: "",
        category: "test",
        title: "hi",
        source: "test",
      }),
    ).rejects.toThrow(/missing_required/);
  });

  test("rejects invalid priority", async () => {
    await expect(
      notify({
        userId: "u1",
        category: "test",
        title: "hi",
        source: "test",
        priority: "urgent" as any,
      }),
    ).rejects.toThrow(/invalid_priority/);
  });

  test("dedup skips insert when existing unread row matches source+sourceId", async () => {
    // safeQuery first call: preferences (empty row → defaults)
    // safeQuery second call: dedup lookup → has existing row
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ id: "existing-1" }], fromCache: false });

    const result = await notify({
      userId: "u1",
      category: "tasks.due_soon",
      title: "Task due",
      source: "tasks",
      sourceId: "task:ms-123",
      dedup: true,
    });

    expect(result).toEqual({ deduped: true });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("dedup=true falls through when no existing row matches", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await notify({
      userId: "u1",
      category: "tasks.due_soon",
      title: "Task due",
      source: "tasks",
      sourceId: "task:ms-123",
      dedup: true,
    });

    expect(result).toEqual({ id: "notif-1" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("expiresInHours sets expires_at parameter", async () => {
    await notify({
      userId: "u1",
      category: "t",
      title: "hi",
      source: "t",
      expiresInHours: 24,
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    const expiresAt = params[10] as string;
    expect(typeof expiresAt).toBe("string");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("critical priority is accepted and persisted", async () => {
    await notify({
      userId: "u1",
      category: "security.login_unusual",
      title: "Suspicious login",
      source: "security",
      priority: "critical",
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[2]).toBe("critical");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_created",
      "u1",
      "system",
      expect.objectContaining({ priority: "critical" }),
    );
  });

  test("preferences in_app=false still records (no data loss) but auto-dismisses", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          user_id: "u1",
          in_app: false,
          email_digest: "daily",
          quiet_hours_start: null,
          quiet_hours_end: null,
          timezone: "UTC",
          category_overrides: {},
          updated_at: new Date().toISOString(),
        },
      ],
      fromCache: false,
    });

    await notify({
      userId: "u1",
      category: "hr.onboarding_stalled",
      title: "Still pending",
      source: "hr",
    });

    // INSERT still happens (no data loss)
    expect(mockQuery).toHaveBeenCalled();
    const params = mockQuery.mock.calls[0][1] as unknown[];
    // dismissed_at (last param) should be set to an ISO string, not null
    expect(params[11]).not.toBeNull();
    expect(typeof params[11]).toBe("string");
  });

  test("critical is not auto-dismissed by in_app=false — wait, per spec critical still auto-dismisses for bell only via in-app channel", async () => {
    // The spec says in_app=false auto-dismisses the bell; critical ONLY
    // bypasses quiet hours + digest batching. Verify in_app=false + critical
    // still auto-dismisses in the bell (critical path is email, not bell).
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          user_id: "u1",
          in_app: false,
          email_digest: "realtime",
          quiet_hours_start: null,
          quiet_hours_end: null,
          timezone: "UTC",
          category_overrides: {},
          updated_at: new Date().toISOString(),
        },
      ],
      fromCache: false,
    });
    await notify({
      userId: "u1",
      category: "security.login_unusual",
      title: "Unusual login",
      source: "security",
      priority: "critical",
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[11]).not.toBeNull(); // auto-dismissed for bell
    expect(params[2]).toBe("critical");
  });
});

describe("notifyMany()", () => {
  test("continues past individual failures", async () => {
    mockQuery.mockReset();
    // first insert fails, second succeeds, third succeeds
    mockQuery
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ rows: [{ id: "n2" }] })
      .mockResolvedValueOnce({ rows: [{ id: "n3" }] });

    await notifyMany([
      { userId: "u1", category: "c1", title: "t1", source: "s1" },
      { userId: "u1", category: "c2", title: "t2", source: "s2" },
      { userId: "u1", category: "c3", title: "t3", source: "s3" },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

describe("markRead()", () => {
  test("emits seconds_to_read analytics", async () => {
    const createdAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    mockSafeQuery
      // loadOwned: row lookup
      .mockResolvedValueOnce({
        rows: [
          {
            id: "n1",
            user_id: "u1",
            category: "t",
            priority: "normal",
            title: "hi",
            source: "t",
            metadata: {},
            created_at: createdAt,
          },
        ],
        fromCache: false,
      })
      // UPDATE
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    await markRead("n1", "u1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_read",
      "u1",
      "system",
      expect.objectContaining({
        notification_id: "n1",
        user_id: "u1",
      }),
    );
    const call = mockTrackEvent.mock.calls[0];
    const meta = call[3] as Record<string, number>;
    expect(meta.seconds_to_read).toBeGreaterThanOrEqual(100);
  });

  test("is idempotent when already read", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "n1",
          user_id: "u1",
          category: "t",
          priority: "normal",
          title: "hi",
          source: "t",
          metadata: {},
          created_at: new Date().toISOString(),
          read_at: new Date().toISOString(),
        },
      ],
      fromCache: false,
    });
    await markRead("n1", "u1");
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("markAllRead()", () => {
  test("returns count of rows updated and emits analytics per row", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "a", created_at: new Date(Date.now() - 10_000).toISOString() },
        { id: "b", created_at: new Date(Date.now() - 20_000).toISOString() },
      ],
      fromCache: false,
    });
    const count = await markAllRead("u1");
    expect(count).toBe(2);
    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
  });
});

describe("dismiss()", () => {
  test("emits system.notification_dismissed", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "n1",
            user_id: "u1",
            category: "t",
            priority: "normal",
            title: "hi",
            source: "t",
            metadata: {},
            created_at: new Date().toISOString(),
          },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    await dismiss("n1", "u1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_dismissed",
      "u1",
      "system",
      expect.objectContaining({ notification_id: "n1" }),
    );
  });
});

describe("recordClick()", () => {
  test("emits system.notification_clicked with action_url and returns it", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "n1",
            user_id: "u1",
            category: "t",
            priority: "normal",
            title: "hi",
            source: "t",
            metadata: {},
            action_url: "/settings",
            created_at: new Date().toISOString(),
          },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await recordClick("n1", "u1");
    expect(result.action_url).toBe("/settings");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_clicked",
      "u1",
      "system",
      expect.objectContaining({ notification_id: "n1", action_url: "/settings" }),
    );
  });

  test("returns null action_url when notification not found", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const result = await recordClick("nope", "u1");
    expect(result.action_url).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("list + count queries", () => {
  test("unreadCount returns zero when no rows", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ count: "0" }],
      fromCache: false,
    });
    const n = await unreadCount("u1");
    expect(n).toBe(0);
  });

  test("listUnread caps limit at 100", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await listUnread("u1", { limit: 10_000 });
    const params = mockSafeQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(100);
  });

  test("listAll returns nextCursor when more than limit rows exist", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 21; i++) {
      rows.push({
        id: `n-${i}`,
        user_id: "u1",
        category: "t",
        priority: "normal",
        title: `t${i}`,
        source: "t",
        metadata: {},
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
    mockSafeQuery.mockResolvedValueOnce({ rows, fromCache: false });
    const result = await listAll("u1", { limit: 20 });
    expect(result.notifications.length).toBe(20);
    expect(typeof result.nextCursor).toBe("string");
  });
});

describe("preferences", () => {
  test("getPreferences returns defaults when no row", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const prefs = await getPreferences("u1");
    expect(prefs.in_app).toBe(true);
    expect(prefs.email_digest).toBe("daily");
    expect(prefs.timezone).toBe("America/New_York");
    expect(prefs.category_overrides).toEqual({});
  });

  test("updatePreferences rejects invalid email_digest", async () => {
    await expect(
      updatePreferences("u1", { email_digest: "bogus" as any }),
    ).rejects.toThrow(/invalid_email_digest/);
  });

  test("updatePreferences rejects invalid category override", async () => {
    await expect(
      updatePreferences("u1", {
        category_overrides: { "hr.onboarding_stalled": "bogus" as any },
      }),
    ).rejects.toThrow(/invalid_category_override/);
  });

  test("updatePreferences returns changed fields list", async () => {
    // getPreferences → defaults
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false }) // getPreferences
      .mockResolvedValueOnce({ rows: [], fromCache: false }); // upsert

    const { preferences, changes } = await updatePreferences("u1", {
      email_digest: "realtime",
      in_app: false,
    });
    expect(changes).toEqual(expect.arrayContaining(["email_digest", "in_app"]));
    expect(preferences.email_digest).toBe("realtime");
    expect(preferences.in_app).toBe(false);
  });
});
