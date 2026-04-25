/**
 * /api/automations/[automationId]/summaries/[classKey]/export-docx — handler tests.
 *
 * Mirrors the JSON sibling's pattern: mock requireCapability, registry,
 * and the assembler so each path is exercised without a live Postgres.
 *
 * The renderer itself is mocked too — its real behaviour is covered in
 * `src/lib/automations/porsche-classes/__tests__/export-docx.test.ts`,
 * and stubbing it here lets us assert the route's content-type +
 * content-disposition + body length deterministically.
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

const mockRender = jest.fn();
jest.mock("@/lib/automations/porsche-classes/export-docx", () => ({
  renderClassSummaryDocx: (...args: unknown[]) => mockRender(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/automations/[automationId]/summaries/[classKey]/export-docx/route";

function req(): NextRequest {
  return new NextRequest(
    "http://test/api/automations/porsche-classes/summaries/BA101%7C2026-04-13%7CWestlake/export-docx",
    { method: "GET" },
  );
}

const USER = { id: "u-1", role: "ops", name: "T", email: "t@e" };

const FAKE_SUMMARY = {
  class_key: "BA101|2026-04-13|Westlake",
  course_type: "BA101",
  class_date: "2026-04-13",
  location: "Westlake",
  sources: {
    porsche_xlsx: 1,
    cognito_coordinator: 0,
    cognito_instructor: 0,
    survey: 0,
    email: 0,
  },
  participants: ["alice@dealer.com"],
  coordinator_notes: [],
  instructor_notes: [],
  survey: null,
  open_exceptions: [],
  generated_at: "2026-04-25T10:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/automations/[automationId]/summaries/[classKey]/export-docx", () => {
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
    expect(mockRender).not.toHaveBeenCalled();
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
    expect(mockRender).not.toHaveBeenCalled();
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

  it("500 when the renderer throws", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(FAKE_SUMMARY);
    mockRender.mockRejectedValueOnce(new Error("docx boom"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe("render_error");
    errorSpy.mockRestore();
  });

  it("200 returns docx bytes + Content-Type + Content-Disposition", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(FAKE_SUMMARY);
    // Real-ish ZIP-magic prefix so a downstream sniff (curl/file) is happy.
    const fakeBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    mockRender.mockResolvedValueOnce(fakeBytes);

    const res = await GET(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="class-summary-BA101_2026-04-13_Westlake.docx"',
    );
    const arrBuf = await res.arrayBuffer();
    expect(arrBuf.byteLength).toBe(fakeBytes.byteLength);
    const out = Buffer.from(arrBuf);
    // Verify byte equality — body should be the exact bytes the renderer
    // returned. Anything else would mean the route is mangling output.
    expect(out.equals(fakeBytes)).toBe(true);
    expect(mockAssemble).toHaveBeenCalledWith("BA101|2026-04-13|Westlake");
    expect(mockRender).toHaveBeenCalledWith(FAKE_SUMMARY);
  });
});
