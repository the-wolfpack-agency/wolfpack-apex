/**
 * notifications-api.test.ts — route-level coverage for every notifications
 * endpoint:
 *   GET  /api/notifications
 *   GET  /api/notifications/unread-count
 *   POST /api/notifications/[id]/read
 *   POST /api/notifications/[id]/dismiss
 *   POST /api/notifications/[id]/click
 *   POST /api/notifications/mark-all-read
 *   GET  /api/notifications/preferences
 *   PUT  /api/notifications/preferences
 *   POST /api/notifications/test
 *   POST /api/admin/notifications/trigger-digest
 *
 * For each: 401 unauthorized, happy path, analytics emission.
 */

 

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockListAll = jest.fn();
const mockUnreadCount = jest.fn();
const mockMarkRead = jest.fn();
const mockMarkAllRead = jest.fn();
const mockDismiss = jest.fn();
const mockRecordClick = jest.fn();
const mockGetPrefs = jest.fn();
const mockUpdatePrefs = jest.fn();
const mockNotify = jest.fn();

jest.mock("@/lib/notifications/in-app", () => ({
  listAll: (...a: unknown[]) => mockListAll(...a),
  unreadCount: (...a: unknown[]) => mockUnreadCount(...a),
  markRead: (...a: unknown[]) => mockMarkRead(...a),
  markAllRead: (...a: unknown[]) => mockMarkAllRead(...a),
  dismiss: (...a: unknown[]) => mockDismiss(...a),
  recordClick: (...a: unknown[]) => mockRecordClick(...a),
  getPreferences: (...a: unknown[]) => mockGetPrefs(...a),
  updatePreferences: (...a: unknown[]) => mockUpdatePrefs(...a),
  notify: (...a: unknown[]) => mockNotify(...a),
}));

const mockSendDigests = jest.fn();
jest.mock("@/lib/notifications/digest", () => ({
  sendDigests: (...a: unknown[]) => mockSendDigests(...a),
}));

import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@b.c", name: "A", role: "dev" as const, created_at: "" };
const CEO = { ...USER, id: "u2", role: "ceo" as const };

function req(url: string, init?: { method?: string; body?: string; auth?: boolean }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.auth !== false) headers["authorization"] = "Bearer t";
  return new NextRequest(url, {
    method: init?.method,
    body: init?.body,
    headers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/notifications", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(req("http://localhost/api/notifications", { auth: false }));
    expect(res.status).toBe(401);
  });
  test("200 + passes through filter params", async () => {
    mockGetUser.mockReturnValue(USER);
    mockListAll.mockResolvedValue({ notifications: [], nextCursor: undefined });
    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET(
      req("http://localhost/api/notifications?read=unread&category=hr.x&limit=5"),
    );
    expect(res.status).toBe(200);
    const [userId, opts] = mockListAll.mock.calls[0];
    expect(userId).toBe("u1");
    expect(opts.filter.readState).toBe("unread");
    expect(opts.filter.category).toBe("hr.x");
    expect(opts.limit).toBe(5);
  });
});

describe("GET /api/notifications/unread-count", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/notifications/unread-count/route");
    const res = await GET(req("http://localhost/api/notifications/unread-count", { auth: false }));
    expect(res.status).toBe(401);
  });
  test("200 + returns count", async () => {
    mockGetUser.mockReturnValue(USER);
    mockUnreadCount.mockResolvedValue(7);
    const { GET } = await import("@/app/api/notifications/unread-count/route");
    const res = await GET(req("http://localhost/api/notifications/unread-count"));
    const data = await res.json();
    expect(data.count).toBe(7);
  });
});

describe("POST /api/notifications/[id]/read", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/notifications/[id]/read/route");
    const res = await POST(req("http://localhost/api/notifications/n1/read", { method: "POST", auth: false }), {
      params: Promise.resolve({ id: "n1" }),
    });
    expect(res.status).toBe(401);
  });
  test("happy path invokes markRead", async () => {
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/notifications/[id]/read/route");
    const res = await POST(req("http://localhost/api/notifications/n1/read", { method: "POST" }), {
      params: Promise.resolve({ id: "n1" }),
    });
    expect(res.status).toBe(200);
    expect(mockMarkRead).toHaveBeenCalledWith("n1", "u1");
  });
});

describe("POST /api/notifications/[id]/dismiss", () => {
  test("happy path invokes dismiss", async () => {
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/notifications/[id]/dismiss/route");
    const res = await POST(req("http://localhost/api/notifications/n1/dismiss", { method: "POST" }), {
      params: Promise.resolve({ id: "n1" }),
    });
    expect(res.status).toBe(200);
    expect(mockDismiss).toHaveBeenCalledWith("n1", "u1");
  });
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/notifications/[id]/dismiss/route");
    const res = await POST(req("http://localhost/api/notifications/n1/dismiss", { method: "POST", auth: false }), {
      params: Promise.resolve({ id: "n1" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/notifications/[id]/click", () => {
  test("returns action_url from recordClick", async () => {
    mockGetUser.mockReturnValue(USER);
    mockRecordClick.mockResolvedValue({ action_url: "/tasks/123" });
    const { POST } = await import("@/app/api/notifications/[id]/click/route");
    const res = await POST(req("http://localhost/api/notifications/n1/click", { method: "POST" }), {
      params: Promise.resolve({ id: "n1" }),
    });
    const data = await res.json();
    expect(data.action_url).toBe("/tasks/123");
  });
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/notifications/[id]/click/route");
    const res = await POST(req("http://localhost/api/notifications/n1/click", { method: "POST", auth: false }), {
      params: Promise.resolve({ id: "n1" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/notifications/mark-all-read", () => {
  test("returns count", async () => {
    mockGetUser.mockReturnValue(USER);
    mockMarkAllRead.mockResolvedValue(3);
    const { POST } = await import("@/app/api/notifications/mark-all-read/route");
    const res = await POST(req("http://localhost/api/notifications/mark-all-read", { method: "POST" }));
    const data = await res.json();
    expect(data.count).toBe(3);
  });
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/notifications/mark-all-read/route");
    const res = await POST(req("http://localhost/api/notifications/mark-all-read", { method: "POST", auth: false }));
    expect(res.status).toBe(401);
  });
});

describe("preferences routes", () => {
  test("GET 401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/notifications/preferences/route");
    const res = await GET(req("http://localhost/api/notifications/preferences", { auth: false }));
    expect(res.status).toBe(401);
  });
  test("GET returns current preferences", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetPrefs.mockResolvedValue({
      user_id: "u1",
      in_app: true,
      email_digest: "daily",
      quiet_hours_start: null,
      quiet_hours_end: null,
      timezone: "UTC",
      category_overrides: {},
      updated_at: new Date().toISOString(),
    });
    const { GET } = await import("@/app/api/notifications/preferences/route");
    const res = await GET(req("http://localhost/api/notifications/preferences"));
    const data = await res.json();
    expect(data.preferences.email_digest).toBe("daily");
  });

  test("PUT 401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { PUT } = await import("@/app/api/notifications/preferences/route");
    const res = await PUT(req("http://localhost/api/notifications/preferences", {
      method: "PUT",
      body: JSON.stringify({}),
      auth: false,
    }));
    expect(res.status).toBe(401);
  });

  test("PUT 400 on invalid body (non-JSON)", async () => {
    mockGetUser.mockReturnValue(USER);
    const { PUT } = await import("@/app/api/notifications/preferences/route");
    const res = await PUT(
      new NextRequest("http://localhost/api/notifications/preferences", {
        method: "PUT",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("PUT happy path emits system.notification_preferences_updated", async () => {
    mockGetUser.mockReturnValue(USER);
    mockUpdatePrefs.mockResolvedValue({
      preferences: {
        user_id: "u1",
        in_app: true,
        email_digest: "realtime",
        quiet_hours_start: null,
        quiet_hours_end: null,
        timezone: "UTC",
        category_overrides: {},
        updated_at: new Date().toISOString(),
      },
      changes: ["email_digest"],
    });
    const { PUT } = await import("@/app/api/notifications/preferences/route");
    const res = await PUT(req("http://localhost/api/notifications/preferences", {
      method: "PUT",
      body: JSON.stringify({ email_digest: "realtime" }),
    }));
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.notification_preferences_updated",
      "u1",
      "system",
      expect.objectContaining({ user_id: "u1", changes: "email_digest" }),
    );
  });

  test("PUT 400 on invalid enum from lib", async () => {
    mockGetUser.mockReturnValue(USER);
    mockUpdatePrefs.mockRejectedValue(new Error("invalid_email_digest"));
    const { PUT } = await import("@/app/api/notifications/preferences/route");
    const res = await PUT(req("http://localhost/api/notifications/preferences", {
      method: "PUT",
      body: JSON.stringify({ email_digest: "bogus" }),
    }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/notifications/test (dev only)", () => {
  const prev = process.env.NODE_ENV;
  afterAll(() => {
    Object.defineProperty(process.env, "NODE_ENV", { value: prev });
  });

  test("404 in production", async () => {
    Object.defineProperty(process.env, "NODE_ENV", { value: "production" });
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/notifications/test/route");
    const res = await POST(req("http://localhost/api/notifications/test", {
      method: "POST",
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(404);
  });

  test("happy path in dev mode creates test notification", async () => {
    Object.defineProperty(process.env, "NODE_ENV", { value: "development" });
    mockGetUser.mockReturnValue(USER);
    mockNotify.mockResolvedValue({ id: "n-test" });
    const { POST } = await import("@/app/api/notifications/test/route");
    const res = await POST(req("http://localhost/api/notifications/test", {
      method: "POST",
      body: JSON.stringify({ title: "Hello" }),
    }));
    expect(res.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", title: "Hello", source: "test" }),
    );
  });
});

describe("POST /api/admin/notifications/trigger-digest", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/admin/notifications/trigger-digest/route");
    const res = await POST(req("http://localhost/api/admin/notifications/trigger-digest", {
      method: "POST",
      auth: false,
    }));
    expect(res.status).toBe(401);
  });
  test("403 when non-admin", async () => {
    mockGetUser.mockReturnValue(USER); // dev role
    const { POST } = await import("@/app/api/admin/notifications/trigger-digest/route");
    const res = await POST(req("http://localhost/api/admin/notifications/trigger-digest", { method: "POST" }));
    expect(res.status).toBe(403);
  });
  test("400 on invalid window", async () => {
    mockGetUser.mockReturnValue(CEO);
    const { POST } = await import("@/app/api/admin/notifications/trigger-digest/route");
    const res = await POST(req("http://localhost/api/admin/notifications/trigger-digest?window=monthly", {
      method: "POST",
    }));
    expect(res.status).toBe(400);
  });
  test("200 and calls sendDigests(force:true) with daily", async () => {
    mockGetUser.mockReturnValue(CEO);
    mockSendDigests.mockResolvedValue({
      considered: 1,
      sent: 1,
      skipped_off: 0,
      skipped_outside_window: 0,
      skipped_empty: 0,
      errors: 0,
    });
    const { POST } = await import("@/app/api/admin/notifications/trigger-digest/route");
    const res = await POST(req("http://localhost/api/admin/notifications/trigger-digest?window=daily", {
      method: "POST",
    }));
    expect(res.status).toBe(200);
    const [opts] = mockSendDigests.mock.calls[0];
    expect(opts.window).toBe("daily");
    expect(opts.force).toBe(true);
  });
});
