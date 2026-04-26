/**
 * /api/automations/[automationId]/summaries/[classKey]/upload-sharepoint —
 * handler tests.
 *
 * Auth, unknown automation, no-snapshots, success, not_configured (202),
 * no_token (202), graph_error (502), and assembler/render error paths.
 *
 * The summary assembler, docx renderer, and uploader are all mocked so we
 * can exercise every path without Postgres / docx parsing / network IO.
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

const mockUpload = jest.fn();
jest.mock("@/lib/automations/porsche-classes/sharepoint-upload", () => ({
  uploadClassSummary: (...args: unknown[]) => mockUpload(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/automations/[automationId]/summaries/[classKey]/upload-sharepoint/route";

function req(): NextRequest {
  return new NextRequest(
    "http://test/api/automations/porsche-classes/summaries/BA101%7C2026-04-13%7CWestlake/upload-sharepoint",
    { method: "POST" },
  );
}

const USER = {
  id: "u-1",
  role: "ops",
  name: "Alicia",
  email: "alicia@example.com",
};

const SUMMARY = {
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST upload-sharepoint", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(401);
    expect(mockAssemble).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("404 for an unknown automation", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "not-a-real-automation",
        classKey: "x",
      }),
    });
    expect(res.status).toBe(404);
    expect(mockAssemble).not.toHaveBeenCalled();
  });

  it("404 when no snapshots", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(null);
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("500 when the assembler throws", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockRejectedValueOnce(new Error("DB exploded"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req(), {
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

  it("500 when render throws", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(SUMMARY);
    mockRender.mockRejectedValueOnce(new Error("docx broke"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe("render_error");
    expect(mockUpload).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("200 happy path — emits attempt + succeeded analytics", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(SUMMARY);
    mockRender.mockResolvedValueOnce(Buffer.from("DOCXBYTES"));
    mockUpload.mockResolvedValueOnce({
      ok: true,
      web_url: "https://contoso.sharepoint.com/sites/x/Shared/y.docx",
    });
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.web_url).toBe(
      "https://contoso.sharepoint.com/sites/x/Shared/y.docx",
    );
    expect(body.filename).toBe("BA101 - 2026-04-13 - Westlake.docx");

    // Both events fired with the right shape.
    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("automations.sharepoint_upload_attempted");
    expect(eventNames).toContain("automations.sharepoint_upload_succeeded");

    // Upload call received userId + userEmail (dual-anchor).
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const uploadArgs = mockUpload.mock.calls[0][0];
    expect(uploadArgs.userId).toBe("u-1");
    expect(uploadArgs.userEmail).toBe("alicia@example.com");
    expect(uploadArgs.filename).toBe("BA101 - 2026-04-13 - Westlake.docx");
    expect(uploadArgs.bytes).toBeInstanceOf(Buffer);
    expect(uploadArgs.contentType).toContain("wordprocessingml");
  });

  it("202 when SharePoint not configured (graceful skip)", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(SUMMARY);
    mockRender.mockResolvedValueOnce(Buffer.from("DOCXBYTES"));
    mockUpload.mockResolvedValueOnce({
      ok: false,
      error: "SharePoint not configured",
      skipped_reason: "not_configured",
    });
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.skipped_reason).toBe("not_configured");

    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("automations.sharepoint_upload_skipped");
  });

  it("202 when no Microsoft token (graceful skip)", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(SUMMARY);
    mockRender.mockResolvedValueOnce(Buffer.from("DOCXBYTES"));
    mockUpload.mockResolvedValueOnce({
      ok: false,
      error: "no token",
      skipped_reason: "no_token",
    });
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.skipped_reason).toBe("no_token");
  });

  it("502 when Graph rejects the upload", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockAssemble.mockResolvedValueOnce(SUMMARY);
    mockRender.mockResolvedValueOnce(Buffer.from("DOCXBYTES"));
    mockUpload.mockResolvedValueOnce({
      ok: false,
      error: "SharePoint PUT 403: Forbidden",
      skipped_reason: "graph_error",
      status: 403,
    });
    const res = await POST(req(), {
      params: Promise.resolve({
        automationId: "porsche-classes",
        classKey: "BA101%7C2026-04-13%7CWestlake",
      }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.skipped_reason).toBe("graph_error");
    expect(body.upstream_status).toBe(403);
  });
});

import { buildFilename } from "../route";

describe("buildFilename — Graph-safe drive-item name builder", () => {
  it("normalizes a full ISO class_date to YYYY-MM-DD (drops time + millis + Z)", () => {
    // Real-world bug: SharePoint rejected names like
    // "Porsche Academy - 2026-04-20T000000.000Z - Ritz Carlton.docx"
    // with "The string did not match the expected pattern".
    const out = buildFilename({
      course_type: "Porsche Academy",
      class_date: "2026-04-20T00:00:00.000Z",
      location: "Ritz Carlton",
    });
    expect(out).toBe("Porsche Academy - 2026-04-20 - Ritz Carlton.docx");
  });

  it("accepts a bare YYYY-MM-DD class_date unchanged", () => {
    expect(
      buildFilename({
        course_type: "BA101",
        class_date: "2026-04-20",
        location: "Atlanta",
      }),
    ).toBe("BA101 - 2026-04-20 - Atlanta.docx");
  });

  it("falls back to a parsed date when the input isn't ISO-shaped", () => {
    const out = buildFilename({
      course_type: "BA101",
      class_date: "April 20, 2026",
      location: "Atlanta",
    });
    expect(out).toMatch(/^BA101 - \d{4}-\d{2}-\d{2} - Atlanta\.docx$/);
  });

  it("strips Windows-restricted chars (\\, /, :, *, ?, \", <, >, |)", () => {
    const out = buildFilename({
      course_type: "Course / Foo: Bar?",
      class_date: "2026-04-20",
      location: 'Site|"Place"',
    });
    expect(out).not.toMatch(/[\\/:*?"<>|]/);
    expect(out.endsWith(".docx")).toBe(true);
  });

  it("strips hash, percent, ampersand (some tenants reject these in path names)", () => {
    const out = buildFilename({
      course_type: "Cls #100 & Co.",
      class_date: "2026-04-20",
      location: "%Place%",
    });
    expect(out).not.toMatch(/[#%&]/);
  });

  it("trims leading/trailing whitespace and trailing periods (Graph forbids both)", () => {
    const out = buildFilename({
      course_type: "  Padded Course .  ",
      class_date: "2026-04-20",
      location: "Loc.",
    });
    // No leading/trailing whitespace anywhere a segment is joined
    expect(out).toBe("Padded Course - 2026-04-20 - Loc.docx");
  });

  it("collapses consecutive whitespace to a single space", () => {
    const out = buildFilename({
      course_type: "Lots   of    spaces",
      class_date: "2026-04-20",
      location: "X",
    });
    expect(out).toBe("Lots of spaces - 2026-04-20 - X.docx");
  });

  it("falls back to 'Class' when a field is empty after sanitization", () => {
    const out = buildFilename({
      course_type: "///",
      class_date: "2026-04-20",
      location: "",
    });
    expect(out).toMatch(/^Class - 2026-04-20 - Class\.docx$/);
  });
});
