/**
 * Contract tests for PATCH /api/job-codes/[code]/cell.
 *
 * Locks the policy in code so a future refactor that loosens
 * column allowlisting or skips audit logging fails at PR time, not
 * after finance discovers Instinct overwrote a row.
 */

export {};

const mockRequireCapability = jest.fn();
const mockFindBySource = jest.fn();
const mockPatchCell = jest.fn();
const mockRecordEdit = jest.fn();
const mockUpdateExtra = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/job-codes/cell-writer", () => ({
  patchJobCodeCell: (...a: unknown[]) => mockPatchCell(...a),
  EDITABLE_HEADERS: ["Program", "PO Number", "PO Amount"] as const,
  LETTER_TO_HEADER: { D: "Program", E: "PO Number", F: "PO Amount" },
}));
jest.mock("@/lib/job-codes/repo", () => ({
  findJobCodeBySource: (...a: unknown[]) => mockFindBySource(...a),
  recordCellEdit: (...a: unknown[]) => mockRecordEdit(...a),
  updateExtraCell: (...a: unknown[]) => mockUpdateExtra(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { PATCH } from "../route";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/job-codes/WOLFPACK-AUTO/cell", {
    method: "PATCH",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const okAuth = (overrides: { id?: string; role?: string; workspaceId?: string } = {}) => ({
  ok: true,
  user: {
    id: overrides.id ?? "u-admin",
    role: overrides.role ?? "cto",
    workspaceId: overrides.workspaceId ?? "w-1",
    email: "homyk@thewolfpack.agency",
  },
  capabilities: new Set(),
});

const cachedSource = {
  code: "WOLFPACK-AUTO",
  description: "x",
  sheetName: "Job Codes",
  active: true,
  lastSeenAt: "2026-05-21",
  extra: {},
  rowIndex: 0,
  driveId: "drv",
  itemId: "itm",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockTrackEvent.mockResolvedValue(undefined);
  mockRecordEdit.mockResolvedValue(undefined);
  mockUpdateExtra.mockResolvedValue(undefined);
});

describe("PATCH /api/job-codes/[code]/cell — auth + capability", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await PATCH(makeReq({ column: "D", value: "x" }), { params: Promise.resolve({ code: "X" }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks jobcodes.refresh capability", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await PATCH(makeReq({ column: "D", value: "x" }), { params: Promise.resolve({ code: "X" }) });
    expect(res.status).toBe(403);
  });
});

describe("PATCH — column allowlist (defense in depth)", () => {
  it.each(["A", "B", "C", "G", "Z", "ABC", ""])(
    "refuses column %p with 400 forbidden_column",
    async (col) => {
      mockRequireCapability.mockResolvedValue(okAuth());
      const res = await PATCH(
        makeReq({ column: col, value: "x" }),
        { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
      );
      expect(res.status).toBe(400);
      expect(mockFindBySource).not.toHaveBeenCalled();
      expect(mockPatchCell).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.error).toBe("forbidden_column");
    },
  );
});

describe("PATCH — happy path", () => {
  it("PATCHes, mirrors to cache, writes audit, returns the new value", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(cachedSource);
    mockPatchCell.mockResolvedValue({
      ok: true,
      rowIndex: 7,
      cellAddress: "D7",
      previousValue: "old prog",
      newValue: "Phase 2",
      tokenKind: "delegated",
    });

    const res = await PATCH(
      makeReq({ column: "D", value: "Phase 2" }),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      code: "WOLFPACK-AUTO",
      column_header: "Program",
      cell_address: "D7",
      previous_value: "old prog",
      new_value: "Phase 2",
    });

    expect(mockUpdateExtra).toHaveBeenCalledWith("WOLFPACK-AUTO", "Program", "Phase 2");
    expect(mockRecordEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w-1",
        code: "WOLFPACK-AUTO",
        columnName: "Program",
        oldValue: "old prog",
        newValue: "Phase 2",
        editedBy: "u-admin",
        editedByRole: "cto",
        status: "succeeded",
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.cell_edit_succeeded",
      "u-admin",
      "cto",
      expect.objectContaining({ code: "WOLFPACK-AUTO", column_header: "Program" }),
    );
  });
});

describe("PATCH — optimiztic concurrency", () => {
  const cachedSourceLocal = {
    code: "WOLFPACK-AUTO",
    description: "x",
    sheetName: "Job Codes",
    active: true,
    lastSeenAt: "2026-05-21",
    extra: {},
    rowIndex: 0,
    driveId: "drv",
    itemId: "itm",
  };

  it("forwards expected_value from the body to the writer", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(cachedSourceLocal);
    mockPatchCell.mockResolvedValue({
      ok: true,
      rowIndex: 3,
      cellAddress: "D3",
      previousValue: "OLD",
      newValue: "NEW",
      tokenKind: "delegated",
    });

    await PATCH(
      makeReq({ column: "D", value: "NEW", expected_value: "OLD" }),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(mockPatchCell).toHaveBeenCalledWith(
      expect.objectContaining({ expectedValue: "OLD", value: "NEW" }),
    );
  });

  it("opts out of the gate when body omits expected_value (forwards null)", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(cachedSourceLocal);
    mockPatchCell.mockResolvedValue({
      ok: true, rowIndex: 3, cellAddress: "D3",
      previousValue: "X", newValue: "Y", tokenKind: "delegated",
    });
    await PATCH(
      makeReq({ column: "D", value: "Y" }),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(mockPatchCell).toHaveBeenCalledWith(
      expect.objectContaining({ expectedValue: null }),
    );
  });

  it("writer returns conflict → route returns 409 with conflicts[] and audits as conflict_detected", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(cachedSourceLocal);
    mockPatchCell.mockResolvedValue({
      ok: false,
      code: "conflict",
      detail: "cell changed",
      conflict: {
        column: "Program",
        currentValue: "HOXSIE",
        expectedValue: "OLD",
        requestedValue: "MINE",
      },
    });

    const res = await PATCH(
      makeReq({ column: "D", value: "MINE", expected_value: "OLD" }),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("conflict");
    expect(body.conflicts).toEqual([
      {
        column: "Program",
        currentValue: "HOXSIE",
        expectedValue: "OLD",
        requestedValue: "MINE",
      },
    ]);

    expect(mockRecordEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        oldValue: "HOXSIE",
        graphError: expect.stringContaining("conflict_detected"),
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.job_code_conflict_detected",
      "u-admin",
      "cto",
      expect.objectContaining({
        code: "WOLFPACK-AUTO",
        column: "Program",
        current_value: "HOXSIE",
        expected_value: "OLD",
        requested_value: "MINE",
      }),
    );
    /* DB mirror MUST NOT run on conflict. */
    expect(mockUpdateExtra).not.toHaveBeenCalled();
  });

  it("writer returns noop:true → route returns 200 noop, fires cell_edit_noop, skips audit + mirror", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(cachedSourceLocal);
    mockPatchCell.mockResolvedValue({
      ok: true,
      rowIndex: 3,
      cellAddress: "D3",
      previousValue: "SAME",
      newValue: "SAME",
      tokenKind: "delegated",
      noop: true,
    });
    const res = await PATCH(
      makeReq({ column: "D", value: "SAME", expected_value: "SAME" }),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.noop).toBe(true);
    expect(mockUpdateExtra).not.toHaveBeenCalled();
    expect(mockRecordEdit).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.cell_edit_noop",
      "u-admin",
      "cto",
      expect.objectContaining({ code: "WOLFPACK-AUTO", column_header: "Program" }),
    );
  });
});

describe("PATCH — failure paths still audit", () => {
  it("Graph 403 → 502 + records a 'failed' audit row (still preserves attempt history)", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(cachedSource);
    mockPatchCell.mockResolvedValue({
      ok: false,
      code: "graph_forbidden",
      detail: "accessDenied",
    });
    const res = await PATCH(
      makeReq({ column: "D", value: "x" }),
      { params: Promise.resolve({ code: "WOLFPACK-AUTO" }) },
    );
    expect(res.status).toBe(502);
    expect(mockRecordEdit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", graphError: "accessDenied" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.cell_edit_failed",
      "u-admin",
      "cto",
      expect.objectContaining({ reason: "graph_forbidden" }),
    );
    /* DB mirror MUST NOT run on failure — otherwise the UI would show
       a value that isn't in SharePoint. */
    expect(mockUpdateExtra).not.toHaveBeenCalled();
  });

  it("returns 404 when the job code isn't in the cache", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySource.mockResolvedValue(null);
    const res = await PATCH(
      makeReq({ column: "D", value: "x" }),
      { params: Promise.resolve({ code: "UNKNOWN" }) },
    );
    expect(res.status).toBe(404);
    expect(mockPatchCell).not.toHaveBeenCalled();
  });
});
