 
const mockListPrinciples = jest.fn();
const mockListAll = jest.fn();
const mockResolveNames = jest.fn();
const mockUpsert = jest.fn();
const mockTrack = jest.fn();
const mockResolveConfig = jest.fn();
const mockSharepointWrite = jest.fn();

jest.mock("@/lib/principles/store", () => ({
  listActivePrinciples: (...a: any[]) => mockListPrinciples(...a),
  listAllObservations: (...a: any[]) => mockListAll(...a),
}));
jest.mock("@/lib/principles/user-names", () => ({
  resolveUserNames: (...a: any[]) => mockResolveNames(...a),
}));
jest.mock("@/lib/principles/weekly-report", () => {
  const actual = jest.requireActual("@/lib/principles/weekly-report");
  return {
    ...actual,
    upsertWeeklyReport: (...a: any[]) => mockUpsert(...a),
  };
});
jest.mock("@/lib/principles/config", () => ({
  resolvePrinciplesConfig: (...a: any[]) => mockResolveConfig(...a),
}));
jest.mock("@/lib/principles/sharepoint-write", () => ({
  writeWeeklyReportToSharePoint: (...a: any[]) => mockSharepointWrite(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  mockListPrinciples.mockReset();
  mockListAll.mockReset();
  mockResolveNames.mockReset();
  mockUpsert.mockReset();
  mockTrack.mockReset();
  mockResolveConfig.mockReset();
  mockSharepointWrite.mockReset();
  /* Default: no principles config → SharePoint write skips with
     reason 'no_doc_url'. Specific tests override. */
  mockResolveConfig.mockResolvedValue(null);
  mockSharepointWrite.mockResolvedValue({
    ok: false,
    status: "skipped",
    reasonCode: "no_doc_url",
    message: "principles config missing: no_doc_url",
    audit: null,
  });
  process.env.CRON_SECRET = "secret-x";
});
afterAll(() => {
  process.env = ORIG_ENV;
});

const reqWith = (auth?: string) =>
  new NextRequest("https://wp.test/api/cron/principles-weekly-report", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });

describe("GET /api/cron/principles-weekly-report", () => {
  test("401 without secret", async () => {
    const res = await GET(reqWith());
    expect(res.status).toBe(401);
  });
  test("happy path: builds, upserts, emits weekly_report_published", async () => {
    mockListPrinciples.mockResolvedValueOnce([
      {
        id: "p1",
        slug: "x",
        title: "X",
        domains: [],
        owner: null,
        bodyMd: "",
        scoreboardWeight: 1,
        sourceUrl: null,
        sourceDocHash: null,
        effectiveAt: null,
        retiredAt: null,
        createdAt: "x",
        updatedAt: "x",
      },
    ]);
    mockListAll.mockResolvedValueOnce([
      {
        id: "o1",
        principleId: "p1",
        signalId: null,
        validatorId: "v",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u1",
        observedAt: "2026-05-01",
        score: -0.5,
        evidenceJsonb: {},
      },
    ]);
    mockResolveNames.mockResolvedValueOnce(new Map());
    mockUpsert.mockResolvedValueOnce({
      id: "r1",
      weekStart: "2026-04-28",
      weekEnd: "2026-05-05",
      markdownBody: "md",
      observationCount: 1,
      principleCount: 1,
      generatedAt: "x",
    });
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observationCount).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_published",
      "system",
      "system",
      expect.objectContaining({
        observation_count: 1,
        principle_count: 1,
      }),
    );
  });
  test("upsert error → 500 + weekly_report_failed event", async () => {
    mockListPrinciples.mockResolvedValueOnce([]);
    mockListAll.mockResolvedValueOnce([]);
    mockResolveNames.mockResolvedValueOnce(new Map());
    mockUpsert.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(500);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_failed",
      "system",
      "system",
      expect.objectContaining({ error: "db down" }),
    );
    /* SharePoint write must NOT run when the markdown upsert failed —
       the row is the contract. */
    expect(mockSharepointWrite).not.toHaveBeenCalled();
  });

  /* ---------------- SharePoint write-back leg ----------------------- */

  function happyUpsertReturn(weekStart = "2026-04-28") {
    return {
      id: "r1",
      weekStart,
      weekEnd: "2026-05-05",
      markdownBody: "# md",
      observationCount: 0,
      principleCount: 0,
      generatedAt: "x",
    };
  }

  function primeHappyUpsert() {
    mockListPrinciples.mockResolvedValueOnce([]);
    mockListAll.mockResolvedValueOnce([]);
    mockResolveNames.mockResolvedValueOnce(new Map());
    mockUpsert.mockResolvedValueOnce(happyUpsertReturn());
  }

  test("SharePoint upload success → emits weekly_report_uploaded with byte_count + web_url", async () => {
    primeHappyUpsert();
    mockResolveConfig.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: "u1",
      updatedBy: null,
      updatedAt: null,
      ownerAutoDetected: false,
    });
    mockSharepointWrite.mockResolvedValueOnce({
      ok: true,
      audit: null,
      itemId: "new-1",
      webUrl: "https://sp/folder/Wolfpack.docx",
      etag: '"e1"',
      byteCount: 4096,
    });
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharepoint).toEqual(
      expect.objectContaining({
        status: "uploaded",
        webUrl: "https://sp/folder/Wolfpack.docx",
        byteCount: 4096,
      }),
    );
    /* Both events fire — the markdown publish AND the upload. */
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_published",
      "system",
      "system",
      expect.any(Object),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_uploaded",
      "system",
      "system",
      expect.objectContaining({
        byte_count: 4096,
        web_url: "https://sp/folder/Wolfpack.docx",
        item_id: "new-1",
      }),
    );
  });

  test("SharePoint skipped (no config) → emits weekly_report_upload_skipped + 200 still returns", async () => {
    primeHappyUpsert();
    /* default mockResolveConfig=null + default skipped mockSharepointWrite. */
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharepoint).toEqual({
      status: "skipped",
      reason: "no_doc_url",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_upload_skipped",
      "system",
      "system",
      expect.objectContaining({ reason: "no_doc_url" }),
    );
  });

  test("SharePoint scope_missing → 'skipped' (no_nag), 200 still returns", async () => {
    primeHappyUpsert();
    mockResolveConfig.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: "u1",
      updatedBy: null,
      updatedAt: null,
      ownerAutoDetected: false,
    });
    mockSharepointWrite.mockResolvedValueOnce({
      ok: false,
      status: "skipped",
      reasonCode: "scope_missing",
      message: "Files.ReadWrite required",
      audit: null,
    });
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_upload_skipped",
      "system",
      "system",
      expect.objectContaining({ reason: "scope_missing" }),
    );
  });

  test("SharePoint Graph 5xx → 'failed' event but cron still 200s", async () => {
    primeHappyUpsert();
    mockResolveConfig.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: "u1",
      updatedBy: null,
      updatedAt: null,
      ownerAutoDetected: false,
    });
    mockSharepointWrite.mockResolvedValueOnce({
      ok: false,
      status: "failed",
      reasonCode: "graph_error",
      message: "graph 503",
      audit: null,
    });
    const res = await GET(reqWith("Bearer secret-x"));
    /* Markdown row already saved — cron must NOT 5xx on upload failure. */
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharepoint).toEqual({
      status: "failed",
      reason: "graph_error",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_upload_failed",
      "system",
      "system",
      expect.objectContaining({
        reason: "graph_error",
        error: "graph 503",
      }),
    );
  });
});
