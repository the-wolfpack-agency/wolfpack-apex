/**
 * sharepoint-write — DOCX builder + Graph PUT + audit shape.
 *
 * Coverage matrix:
 *   - markdownToParagraphs: heading/bold/blank/plain
 *   - buildWeeklyReportDocx: produces a valid OOXML zip
 *     (round-trips through the existing JSZip-based parser)
 *   - resolveSharePointParent: 200/403/404/network/missing-fields
 *   - uploadWeeklyReportDocx: 200/201/403/5xx/network
 *   - writeWeeklyReportToSharePoint: skipped/failed/uploaded paths
 *   - recordWeeklyDocUpload: WriteQueryError → returns null (shadow)
 */

import JSZip from "jszip";

const mockGetValidToken = jest.fn();
const mockWriteQuery = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));
jest.mock("@/lib/db", () => {
  class WriteQueryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = "WriteQueryError";
    }
  }
  return {
    writeQuery: (...a: any[]) => mockWriteQuery(...a),
    WriteQueryError,
  };
});

import {
  buildWeeklyReportDocx,
  markdownToParagraphs,
  resolveSharePointParent,
  uploadWeeklyReportDocx,
  recordWeeklyDocUpload,
  writeWeeklyReportToSharePoint,
  WEEKLY_REPORT_DOC_FILENAME,
} from "@/lib/principles/sharepoint-write";
import { docXmlToMarkdown } from "@/lib/principles/parser";
import { WriteQueryError } from "@/lib/db";

const realFetch = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
  mockWriteQuery.mockReset();
  /* Default: every audit insert succeeds. Specific tests override. */
  mockWriteQuery.mockImplementation(async () => ({
    rows: [
      {
        id: "audit-1",
        week_start: "2026-04-28",
        status: "uploaded",
        reason_code: "ok",
        filename: WEEKLY_REPORT_DOC_FILENAME,
        byte_count: 0,
        parent_drive_id: null,
        parent_item_id: null,
        web_url: null,
        etag: null,
        attempted_by: null,
        error_message: null,
        attempted_at: "2026-05-02T00:00:00Z",
      },
    ],
  }));
});

afterAll(() => {
  global.fetch = realFetch;
});

/* ------------------------------------------------------------------ */
/* markdownToParagraphs                                                */
/* ------------------------------------------------------------------ */

describe("markdownToParagraphs", () => {
  test("Heading1 + Heading2 + plain + blank + bold", () => {
    const md = [
      "# Title",
      "",
      "## Section",
      "Body **with bold** text.",
      "",
    ].join("\n");
    const ps = markdownToParagraphs(md);
    expect(ps[0].style).toBe("Heading1");
    expect(ps[0].runs[0].text).toBe("Title");
    expect(ps[1].runs).toHaveLength(0);
    expect(ps[2].style).toBe("Heading2");
    expect(ps[3].style).toBeUndefined();
    expect(ps[3].runs.find((r) => r.bold)?.text).toBe("with bold");
  });

  test("XML-special characters survive markdown→paragraph step", () => {
    const ps = markdownToParagraphs("Tom & Jerry <fast>");
    expect(ps[0].runs[0].text).toBe("Tom & Jerry <fast>");
  });
});

/* ------------------------------------------------------------------ */
/* buildWeeklyReportDocx                                               */
/* ------------------------------------------------------------------ */

describe("buildWeeklyReportDocx", () => {
  test("produces a valid OOXML zip whose document.xml round-trips through the parser", async () => {
    const md = [
      "# Wolfpack — Principles Last Week",
      "",
      "**Window:** 2026-04-21 → 2026-04-28",
      "",
      "## Bias for Action",
      "Observations: 12. Mean score: 0.42.",
    ].join("\n");

    const buf = await buildWeeklyReportDocx(md);
    expect(buf.length).toBeGreaterThan(500);

    const zip = await JSZip.loadAsync(buf);
    const required = [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
    ];
    for (const path of required) {
      expect(zip.file(path)).toBeTruthy();
    }
    const docXml = await zip.file("word/document.xml")!.async("string");
    /* The repo's own .docx parser turns OOXML back into the markdown
       surface — proves the writer + parser agree on the schema. */
    const recovered = docXmlToMarkdown(docXml);
    expect(recovered).toContain("Wolfpack");
    expect(recovered).toContain("Bias for Action");
    expect(recovered).toContain("**Window:**");
  });

  test("XML-escapes ampersands so SharePoint preview doesn't choke", async () => {
    const buf = await buildWeeklyReportDocx("Tom & Jerry <fast>");
    const zip = await JSZip.loadAsync(buf);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Tom &amp; Jerry &lt;fast&gt;");
    expect(docXml).not.toContain("Tom & Jerry");
  });
});

/* ------------------------------------------------------------------ */
/* resolveSharePointParent                                             */
/* ------------------------------------------------------------------ */

function mockResponse(
  status: number,
  body: unknown = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("resolveSharePointParent", () => {
  test("returns not_connected when getValidToken returns null", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const r = await resolveSharePointParent("u1", "https://sp/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_connected");
  });

  test("403 → scope_missing", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(403)) as any;
    const r = await resolveSharePointParent("u1", "https://sp/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("scope_missing");
  });

  test("404 → not_found", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(404)) as any;
    const r = await resolveSharePointParent("u1", "https://sp/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("network throw → graph_error", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")) as any;
    const r = await resolveSharePointParent("u1", "https://sp/x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("graph_error");
      expect(r.message).toContain("ECONNREFUSED");
    }
  });

  test("missing parentReference → graph_error", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { id: "x" })) as any;
    const r = await resolveSharePointParent("u1", "https://sp/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("graph_error");
  });

  test("happy path returns driveId + parentItemId + parent webUrl", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(
      mockResponse(200, {
        id: "doc-1",
        webUrl: "https://contoso.sharepoint.com/Shared/folder/source.docx",
        parentReference: { driveId: "drv-1", id: "folder-1" },
      }),
    ) as any;
    const r = await resolveSharePointParent("u1", "https://sp/x");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parent.driveId).toBe("drv-1");
      expect(r.parent.parentItemId).toBe("folder-1");
      expect(r.parent.parentWebUrl).toBe(
        "https://contoso.sharepoint.com/Shared/folder",
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* uploadWeeklyReportDocx                                              */
/* ------------------------------------------------------------------ */

describe("uploadWeeklyReportDocx", () => {
  const parent = {
    driveId: "drv-1",
    parentItemId: "folder-1",
    parentWebUrl: null,
  };
  const bytes = Buffer.from("fake-docx");

  test("403 → scope_missing", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(403)) as any;
    const r = await uploadWeeklyReportDocx({
      userId: "u1",
      parent,
      filename: "x.docx",
      bytes,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("scope_missing");
  });

  test("500 → graph_error with status", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(503)) as any;
    const r = await uploadWeeklyReportDocx({
      userId: "u1",
      parent,
      filename: "x.docx",
      bytes,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("graph_error");
      expect(r.status).toBe(503);
    }
  });

  test("network throw → graph_error", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockRejectedValueOnce(new Error("EHOSTUNREACH")) as any;
    const r = await uploadWeeklyReportDocx({
      userId: "u1",
      parent,
      filename: "x.docx",
      bytes,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("graph_error");
      expect(r.message).toContain("EHOSTUNREACH");
    }
  });

  test("happy path returns itemId + webUrl + etag + byteCount", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const fetchMock = jest.fn().mockResolvedValueOnce(
      mockResponse(201, {
        id: "new-id",
        webUrl: "https://sp/newdoc.docx",
        eTag: '"abc"',
      }),
    );
    global.fetch = fetchMock as any;
    const r = await uploadWeeklyReportDocx({
      userId: "u1",
      parent,
      filename: WEEKLY_REPORT_DOC_FILENAME,
      bytes,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.itemId).toBe("new-id");
      expect(r.webUrl).toBe("https://sp/newdoc.docx");
      expect(r.etag).toBe('"abc"');
      expect(r.byteCount).toBe(bytes.byteLength);
    }
    /* URL must be properly encoded + use replace conflict behavior. */
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/drives/drv-1/items/folder-1");
    expect(calledUrl).toContain("conflictBehavior=replace");
    expect(calledUrl).toContain(encodeURIComponent(WEEKLY_REPORT_DOC_FILENAME));
  });
});

/* ------------------------------------------------------------------ */
/* recordWeeklyDocUpload — shadow-mode degradation                     */
/* ------------------------------------------------------------------ */

describe("recordWeeklyDocUpload", () => {
  test("WriteQueryError (no DATABASE_URL) → returns null without throwing", async () => {
    mockWriteQuery.mockRejectedValueOnce(
      new WriteQueryError("no db", "no_database"),
    );
    const r = await recordWeeklyDocUpload({
      weekStart: "2026-04-28",
      status: "skipped",
      reasonCode: "no_doc_url",
    });
    expect(r).toBeNull();
  });

  test("non-WriteQueryError throws (real DB errors must surface)", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(
      recordWeeklyDocUpload({ weekStart: "2026-04-28", status: "uploaded" }),
    ).rejects.toThrow("connection terminated");
  });

  test("happy path returns the audit row", async () => {
    const r = await recordWeeklyDocUpload({
      weekStart: "2026-04-28",
      status: "uploaded",
      filename: WEEKLY_REPORT_DOC_FILENAME,
      byteCount: 1234,
      attemptedBy: "u1",
    });
    expect(r?.status).toBe("uploaded");
  });
});

/* ------------------------------------------------------------------ */
/* writeWeeklyReportToSharePoint — orchestrator                        */
/* ------------------------------------------------------------------ */

describe("writeWeeklyReportToSharePoint", () => {
  const baseReport = {
    weekStart: "2026-04-28",
    weekEnd: "2026-05-05",
    markdownBody: "# Title\n\n## Section\nbody.",
    observationCount: 3,
    principleCount: 2,
  };

  test("config without docUrl → status:'skipped' + reason no_doc_url", async () => {
    const r = await writeWeeklyReportToSharePoint({
      report: baseReport,
      config: { docUrl: null, ownerUserId: "u1" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("skipped");
      expect(r.reasonCode).toBe("no_doc_url");
    }
    /* No graph fetches when we short-circuit. */
    /* Audit row was attempted. */
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
  });

  test("config without ownerUserId → status:'skipped' + reason no_owner", async () => {
    const r = await writeWeeklyReportToSharePoint({
      report: baseReport,
      config: { docUrl: "https://sp/x", ownerUserId: null },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("skipped");
      expect(r.reasonCode).toBe("no_owner");
    }
  });

  test("scope_missing on parent resolve → 'skipped' (no nag)", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(403)) as any;
    const r = await writeWeeklyReportToSharePoint({
      report: baseReport,
      config: { docUrl: "https://sp/x", ownerUserId: "u1" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("skipped");
      expect(r.reasonCode).toBe("scope_missing");
    }
  });

  test("graph_error on parent resolve → 'failed'", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(500)) as any;
    const r = await writeWeeklyReportToSharePoint({
      report: baseReport,
      config: { docUrl: "https://sp/x", ownerUserId: "u1" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("failed");
      expect(r.reasonCode).toBe("graph_error");
    }
  });

  test("upload 5xx → 'failed' with audit row capturing parent ids", async () => {
    mockGetValidToken
      .mockResolvedValueOnce({ accessToken: "t", userEmail: "x" })
      .mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockResponse(200, {
          id: "doc-1",
          webUrl: "https://sp/folder/x.docx",
          parentReference: { driveId: "drv", id: "fld" },
        }),
      )
      .mockResolvedValueOnce(mockResponse(500)) as any;
    const r = await writeWeeklyReportToSharePoint({
      report: baseReport,
      config: { docUrl: "https://sp/x", ownerUserId: "u1" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("failed");
      expect(r.reasonCode).toBe("graph_error");
    }
    /* Parent ids are captured in the audit insert. */
    const lastCall = mockWriteQuery.mock.calls.at(-1)!;
    expect(lastCall[1]).toContain("drv");
    expect(lastCall[1]).toContain("fld");
  });

  test("happy path uploads, audit captures bytes + ids + webUrl", async () => {
    mockGetValidToken
      .mockResolvedValueOnce({ accessToken: "t", userEmail: "x" })
      .mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockResponse(200, {
          id: "doc-1",
          webUrl: "https://sp/folder/source.docx",
          parentReference: { driveId: "drv", id: "fld" },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse(201, {
          id: "new-1",
          webUrl: "https://sp/folder/Wolfpack.docx",
          eTag: '"e1"',
        }),
      ) as any;
    const r = await writeWeeklyReportToSharePoint({
      report: baseReport,
      config: { docUrl: "https://sp/x", ownerUserId: "u1" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.itemId).toBe("new-1");
      expect(r.byteCount).toBeGreaterThan(0);
      expect(r.webUrl).toBe("https://sp/folder/Wolfpack.docx");
      expect(r.etag).toBe('"e1"');
    }
  });
});
