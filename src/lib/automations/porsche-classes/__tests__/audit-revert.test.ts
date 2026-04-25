/**
 * audit-revert — unit tests for the three revert handlers.
 *
 * Mocks `@/lib/db` (writeQuery / query / WriteQueryError) and
 * `@/lib/microsoft-graph` (getValidToken). Confirms:
 *   - revertClassMatchMerge deletes the override row, idempotent on
 *     missing detail
 *   - revertSharepointUpload soft-fails on 404, hard-fails on missing
 *     item_id, dual-anchor token resolution
 *   - revertSurveyAutoSplit deletes synthetic snapshots and either
 *     re-opens or inserts an exception
 *   - All three NEVER throw — every error returns ok:false
 */

const mockWriteQuery = jest.fn();
const mockQuery = jest.fn();
class FakeWriteQueryError extends Error {}
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: FakeWriteQueryError,
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

import {
  revertClassMatchMerge,
  revertSharepointUpload,
  revertSurveyAutoSplit,
  buildDeleteUrlByItemId,
} from "@/lib/automations/porsche-classes/audit-revert";
import type { AuditActionRecord } from "@/lib/automations/porsche-classes/audit-repo";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.INSTINCT_SHAREPOINT_SITE_ID;
  delete process.env.INSTINCT_SHAREPOINT_DRIVE_ID;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const baseAction = <K extends string>(
  kind: K,
  // biome-ignore lint/suspicious/noExplicitAny: test record shape
  detail: any,
  overrides: Partial<AuditActionRecord> = {},
) =>
  ({
    id: "a-1",
    automation_id: "porsche-classes",
    action_kind: kind,
    target_ref: "BA101|2026-04-13|Westlake",
    detail,
    actor: "alicia@example.com",
    reverted_at: null,
    reverted_by: null,
    created_at: "2026-04-25T10:00:00.000Z",
    ...overrides,
  }) as AuditActionRecord;

/* ------------------------------------------------------------------ */
/* class_match_merge                                                   */
/* ------------------------------------------------------------------ */

describe("revertClassMatchMerge", () => {
  it("deletes the override and returns ok", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const out = await revertClassMatchMerge(
      baseAction("class_match_merge", {
        override_id: "o-1",
        from_value: "a",
        to_value: "b",
      }) as AuditActionRecord<"class_match_merge">,
    );
    expect(out.ok).toBe(true);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM instinct_automation_porsche_overrides/);
    expect(sql).toMatch(/kind = 'class_match'/);
    expect(params).toEqual(["o-1"]);
  });
  it("returns ok:false when detail is missing override_id", async () => {
    const out = await revertClassMatchMerge(
      baseAction("class_match_merge", {
        from_value: "a",
        to_value: "b",
      }) as AuditActionRecord<"class_match_merge">,
    );
    expect(out.ok).toBe(false);
  });
  it("returns ok:false (does not throw) when DELETE errors", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("pg down"));
    const out = await revertClassMatchMerge(
      baseAction("class_match_merge", {
        override_id: "o-1",
        from_value: "a",
        to_value: "b",
      }) as AuditActionRecord<"class_match_merge">,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/pg down/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* sharepoint_upload                                                   */
/* ------------------------------------------------------------------ */

describe("revertSharepointUpload", () => {
  function setEnv() {
    process.env.INSTINCT_SHAREPOINT_SITE_ID =
      "contoso.sharepoint.com,abc,def";
    process.env.INSTINCT_SHAREPOINT_DRIVE_ID = "drive-1";
  }

  it("returns ok:false when item_id is missing", async () => {
    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        web_url: "https://x",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/item_id/);
    }
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });

  it("returns ok:false when SharePoint env vars are missing", async () => {
    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        item_id: "01ABC",
        web_url: "https://x",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/SharePoint not configured/);
    }
  });

  it("returns ok:false when no token resolves", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValue(null);
    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        item_id: "01ABC",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1", userEmail: "alicia@example.com" },
    );
    expect(out.ok).toBe(false);
    expect(mockGetValidToken).toHaveBeenCalledWith("u-1");
    expect(mockGetValidToken).toHaveBeenCalledWith("alicia@example.com");
  });

  it("happy path — DELETE 204 returns ok", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tok-abc" });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        item_id: "01ABC",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/items/01ABC");
    expect((init as RequestInit).method).toBe("DELETE");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
  });

  it("soft-fails on 404 (file already gone)", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tok-abc" });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        item_id: "01ABC",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.ok).toBe(true);
  });

  it("returns ok:false on 403 with body", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tok-abc" });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        item_id: "01ABC",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/403/);
      expect(out.error).toMatch(/forbidden/);
    }
  });

  it("returns ok:false (does not throw) on network error", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tok-abc" });
    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const out = await revertSharepointUpload(
      baseAction("sharepoint_upload", {
        item_id: "01ABC",
        filename: "x.docx",
      }) as AuditActionRecord<"sharepoint_upload">,
      { userId: "u-1", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.ok).toBe(false);
  });

  it("buildDeleteUrlByItemId encodes item_id + site_id", () => {
    const url = buildDeleteUrlByItemId(
      { siteId: "contoso,abc,def", driveId: "drive-1" },
      "01ABC,XYZ",
    );
    expect(url).toBe(
      `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent("contoso,abc,def")}/drives/drive-1/items/${encodeURIComponent("01ABC,XYZ")}`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* survey_auto_split                                                   */
/* ------------------------------------------------------------------ */

describe("revertSurveyAutoSplit", () => {
  it("deletes the synthetic snapshots and re-opens an existing exception", async () => {
    // 1st call: delete snapshots (returns rows []).
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    // 2nd call: re-open the exception (returns 1 row).
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "exc-1" }] });

    const out = await revertSurveyAutoSplit(
      baseAction(
        "survey_auto_split",
        {
          snapshot_ids: ["s-1", "s-2"],
          exception_id: "exc-1",
          original_error: "filename names multiple courses",
        },
        { target_ref: "art-1" },
      ) as AuditActionRecord<"survey_auto_split">,
    );
    expect(out.ok).toBe(true);
    expect(mockWriteQuery).toHaveBeenCalledTimes(2);
    const firstSql = mockWriteQuery.mock.calls[0][0] as string;
    expect(firstSql).toMatch(/DELETE FROM instinct_automation_porsche_snapshots/);
    expect(firstSql).toMatch(/= ANY\(\$1::uuid\[\]\)/);
    const secondSql = mockWriteQuery.mock.calls[1][0] as string;
    expect(secondSql).toMatch(/UPDATE instinct_automation_porsche_exceptions/);
    expect(secondSql).toMatch(/SET status      = 'open'/);
  });

  it("inserts a fresh exception when re-open finds no row", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // delete snapshots
    mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // re-open: 0 rows
    mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // insert exception

    const out = await revertSurveyAutoSplit(
      baseAction(
        "survey_auto_split",
        {
          snapshot_ids: ["s-1"],
          exception_id: "exc-deleted",
          original_error: "boom",
        },
        { target_ref: "art-1" },
      ) as AuditActionRecord<"survey_auto_split">,
    );
    expect(out.ok).toBe(true);
    expect(mockWriteQuery).toHaveBeenCalledTimes(3);
    const insertSql = mockWriteQuery.mock.calls[2][0] as string;
    expect(insertSql).toMatch(/INSERT INTO instinct_automation_porsche_exceptions/);
  });

  it("inserts a fresh exception when no exception_id was captured", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // delete
    mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // insert exception

    const out = await revertSurveyAutoSplit(
      baseAction(
        "survey_auto_split",
        { snapshot_ids: ["s-1"], original_error: "boom" },
        { target_ref: "art-1" },
      ) as AuditActionRecord<"survey_auto_split">,
    );
    expect(out.ok).toBe(true);
    expect(mockWriteQuery).toHaveBeenCalledTimes(2);
  });

  it("returns ok:false (no throw) when the snapshot DELETE errors", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("pg down"));
    const out = await revertSurveyAutoSplit(
      baseAction("survey_auto_split", {
        snapshot_ids: ["s-1"],
      }) as AuditActionRecord<"survey_auto_split">,
    );
    expect(out.ok).toBe(false);
  });

  it("returns ok:false when detail is missing snapshot_ids", async () => {
    const out = await revertSurveyAutoSplit(
      baseAction("survey_auto_split", {}) as AuditActionRecord<"survey_auto_split">,
    );
    expect(out.ok).toBe(false);
  });

  it("skips the DELETE when snapshot_ids is empty (idempotent)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // insert exception
    const out = await revertSurveyAutoSplit(
      baseAction("survey_auto_split", {
        snapshot_ids: [],
        original_error: "boom",
      }) as AuditActionRecord<"survey_auto_split">,
    );
    expect(out.ok).toBe(true);
    // Only one writeQuery call: the exception insert. No DELETE on empty array.
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
  });
});
