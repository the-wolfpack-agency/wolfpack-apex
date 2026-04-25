/**
 * /api/automations/[automationId]/summaries/[classKey] — handler tests.
 *
 * Covers auth (401), unknown automation (404), no-snapshots (404), happy
 * path (200), and assembler exception path (500). The summary assembler
 * is mocked so we can exercise each path deterministically without a
 * Postgres dependency.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockAssemble = jest.fn();
const fakeAutomation = {
  id: "porsche-classes",
  name: "Porsche Academy class registrations",
  owner_label: "Alicia",
  description: "test",
  active_window_days: { min: -7, max: 30 },
  inbox_filters: {},
  parsers: {},
  assemble_summary: (key: string) => mockAssemble(key),
};
jest.mock("@/lib/automations/registry", () => ({
  getAutomation: (id: string) =>
    id === "porsche-classes" ? fakeAutomation : null,
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/automations/[automationId]/summaries/[classKey]/route";

function req(): NextRequest {
  return new NextRequest(
    "http://test/api/automations/porsche-classes/summaries/BA101%7C2026-04-13%7CWestlake",
    { method: "GET" },
  );
}

const USER = { id: "u-1", role: "ops", name: "T", email: "t@e" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/automations/[automationId]/summaries/[classKey]", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(401);
    expect(mockAssemble).not.toHaveBeenCalled();
  });

  it("404 for an unknown automation id", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "not-a-real-automation",
        classKey: "x",
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/automation not found/i);
  });

  it("404 when the assembler returns null", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(null);
    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no snapshots/i);
    expect(mockAssemble).toHaveBeenCalledWith("BA101|2026-04-13|Westlake");
  });

  it("200 with the assembled summary", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const summary = {
      class_key: "BA101|2026-04-13|Westlake",
      course_type: "BA101",
      class_date: "2026-04-13",
      location: "Westlake",
      sources: {
        porsche_xlsx: 1,
        cognito_coordinator: 1,
        cognito_instructor: 0,
        survey: 0,
      },
      participants: ["alice"],
      coordinator_notes: [{ author: "Amy", note: "x" }],
      instructor_notes: [],
      survey: null,
      open_exceptions: [],
      generated_at: "2026-04-21T15:00:00.000Z",
    };
    mockAssemble.mockResolvedValueOnce(summary);
    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject(summary);
  });

  it("500 when the assembler throws", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockRejectedValueOnce(new Error("DB exploded"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe("assembler_error");
    errorSpy.mockRestore();
  });
});
