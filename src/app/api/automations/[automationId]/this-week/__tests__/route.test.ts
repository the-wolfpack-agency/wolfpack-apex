/**
 * /api/automations/[automationId]/this-week — handler tests.
 *
 * Covers: 401 (no auth), 404 (unknown automation), 200 happy path with
 * a mix of statuses, 200 empty week, 500 (aggregator throws).
 *
 * The aggregator is mocked here — its own SQL projection is exercised
 * in detail by `lib/automations/porsche-classes/__tests__/this-week-aggregator.test.ts`
 * via the FakeQueryRunner pattern.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockListThisWeek = jest.fn();
jest.mock(
  "@/lib/automations/porsche-classes/this-week-aggregator",
  () => ({
    listThisWeekClasses: (...args: unknown[]) => mockListThisWeek(...args),
  }),
);

const fakeAutomation = {
  id: "porsche-classes",
  name: "Porsche BA101 / BA102",
  owner_label: "Program Director",
  description: "test",
  active_window_days: { min: -7, max: 60 },
  inbox_filters: {},
  parsers: {},
};
jest.mock("@/lib/automations/registry", () => ({
  getAutomation: (id: string) =>
    id === "porsche-classes" ? fakeAutomation : null,
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/automations/[automationId]/this-week/route";

function req(): NextRequest {
  return new NextRequest(
    "http://test/api/automations/porsche-classes/this-week",
    { method: "GET" },
  );
}

const USER = { id: "u-1", role: "ops", name: "T", email: "t@e" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/automations/[automationId]/this-week", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "porsche-classes" }),
    });
    expect(res.status).toBe(401);
    expect(mockListThisWeek).not.toHaveBeenCalled();
  });

  it("404 for unknown automation id", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "not-a-real-automation" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/automation not found/i);
    expect(mockListThisWeek).not.toHaveBeenCalled();
  });

  it("200 with mixed statuses + window echo", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockListThisWeek.mockResolvedValueOnce([
      {
        class_key: "BA101|2026-04-13|Westlake",
        course_type: "BA101",
        class_date: "2026-04-13",
        location: "Westlake",
        sources_present: [
          "porsche_xlsx",
          "cognito_coordinator",
          "cognito_instructor",
          "survey",
        ],
        sources_missing: [],
        status: "ready",
        sharepoint_uploaded_at: null,
        last_activity_at: "2026-04-21T15:00:00.000Z",
        open_exception_count: 0,
      },
      {
        class_key: "BA102|2026-05-01|Atlanta",
        course_type: "BA102",
        class_date: "2026-05-01",
        location: "Atlanta",
        sources_present: ["porsche_xlsx"],
        sources_missing: ["cognito_coordinator", "cognito_instructor", "survey"],
        status: "waiting",
        sharepoint_uploaded_at: null,
        last_activity_at: "2026-04-22T10:00:00.000Z",
        open_exception_count: 0,
      },
      {
        class_key: "BA101|2026-04-20|Boston",
        course_type: "BA101",
        class_date: "2026-04-20",
        location: "Boston",
        sources_present: ["porsche_xlsx", "cognito_coordinator"],
        sources_missing: ["cognito_instructor", "survey"],
        status: "needs_attention",
        attention_reason: "1 open issue needs review",
        sharepoint_uploaded_at: null,
        last_activity_at: "2026-04-22T11:00:00.000Z",
        open_exception_count: 1,
      },
    ]);

    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "porsche-classes" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: { min: number; max: number };
      classes: Array<{ class_key: string; status: string }>;
    };
    expect(body.window).toEqual({ min: -7, max: 60 });
    expect(body.classes).toHaveLength(3);
    expect(body.classes.map((c) => c.status).sort()).toEqual([
      "needs_attention",
      "ready",
      "waiting",
    ]);
    expect(mockListThisWeek).toHaveBeenCalledWith({
      automationId: "porsche-classes",
      windowMinDays: -7,
      windowMaxDays: 60,
    });
  });

  it("200 empty list when no classes in window", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockListThisWeek.mockResolvedValueOnce([]);
    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "porsche-classes" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { classes: unknown[] };
    expect(body.classes).toEqual([]);
  });

  it("500 when the aggregator throws", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockListThisWeek.mockRejectedValueOnce(new Error("db exploded"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "porsche-classes" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe("aggregator_error");
    errorSpy.mockRestore();
  });
});
