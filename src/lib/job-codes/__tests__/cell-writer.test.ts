/**
 * Cell-writer contract tests — the guardrail safety net for
 * "Instinct must never overwrite the catalog columns" (CTO 2026-05-21).
 *
 * The hard rule: B (Client/Category) and C (Job Code) are immutable.
 * D/E/F (Program, PO Number, PO Amount) are the ONLY columns the
 * writer ever touches. The forbidden_column tests below MUST keep
 * passing — if someone widens EDITABLE_COLUMNS without a CTO sign-off,
 * they're breaking a written client commitment.
 */

const mockAcquireToken = jest.fn();
jest.mock("@/lib/job-codes/sharepoint-source", () => ({
  acquireSharePointToken: (...a: unknown[]) => mockAcquireToken(...a),
}));

import {
  patchJobCodeCell,
  EDITABLE_COLUMNS,
  JOB_CODE_COLUMN,
} from "@/lib/job-codes/cell-writer";

function mockFetchSequence(
  responses: Array<{ ok: boolean; status?: number; body?: unknown; text?: string }>,
) {
  let i = 0;
  global.fetch = jest.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body ?? {},
      text: async () => r.text ?? "",
    } as unknown as Response;
  }) as jest.Mock;
}

const baseInput = {
  triggeredBy: "u-1",
  driveId: "drv",
  itemId: "itm",
  sheetName: "Job Codes",
  jobCode: "WOLFPACK-AUTO",
  value: "Phase 2",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockAcquireToken.mockResolvedValue({ token: "tok", kind: "delegated" });
});

describe("patchJobCodeCell — guardrail (refuses non-editable columns)", () => {
  /* PINNED: the writer MUST refuse every column not in EDITABLE_COLUMNS
     BEFORE any Graph call. acquireToken should not even fire. */
  for (const forbidden of ["A", "B", "C", "G", "Z", "AA", "abc", "", "1"]) {
    it(`refuses column "${forbidden}" without firing Graph`, async () => {
      global.fetch = jest.fn();
      const res = await patchJobCodeCell({ ...baseInput, column: forbidden });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("forbidden_column");
      expect(global.fetch).not.toHaveBeenCalled();
      /* And the token acquisition path must not have run either —
         no side-effect Graph traffic for a forbidden column. */
      expect(mockAcquireToken).not.toHaveBeenCalled();
    });
  }

  it("JOB_CODE_COLUMN is C and is NOT in EDITABLE_COLUMNS", () => {
    expect(JOB_CODE_COLUMN).toBe("C");
    expect(EDITABLE_COLUMNS).not.toContain("C");
    expect(EDITABLE_COLUMNS).not.toContain("B");
    expect([...EDITABLE_COLUMNS].sort()).toEqual(["D", "E", "F"]);
  });
});

describe("patchJobCodeCell — input validation", () => {
  it("requires a non-empty jobCode", async () => {
    const res = await patchJobCodeCell({ ...baseInput, column: "D", jobCode: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_input");
  });
  it("requires driveId/itemId/sheetName", async () => {
    const res = await patchJobCodeCell({ ...baseInput, column: "D", driveId: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_input");
  });
  it("requires value to be a string (no object/number/etc.)", async () => {
    const res = await patchJobCodeCell({
      ...baseInput,
      column: "D",
      value: 12345 as unknown as string,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_input");
  });
});

describe("patchJobCodeCell — Graph happy path", () => {
  it("locates the row by Job Code in column C and PATCHes the requested cell", async () => {
    mockFetchSequence([
      /* usedRange — row 3 (rowIndex 4 = index 3 + 1) matches WOLFPACK-AUTO */
      {
        ok: true,
        body: {
          values: [
            ["Client/Category", "Other", "Job Code", "Program", "PO Number", "PO Amount"],
            ["Acme", "x", "OTHER-1", "", "", ""],
            ["Acme", "x", "WOLFPACK-AUTO", "OLD", "PO-OLD", "100"],
            ["Globex", "x", "CLIENT-GLB", "", "", ""],
          ],
        },
      },
      /* PATCH response — Graph echoes back what was written */
      { ok: true, body: { values: [["Phase 2"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cellAddress).toBe("D3");
    /* Row 3 in the values array = Excel row 3 (header is row 1,
       rows[1] is excel row 2, rows[2] is excel row 3). */
    expect(res.rowIndex).toBe(3);
    expect(res.previousValue).toBe("OLD");
    expect(res.newValue).toBe("Phase 2");
    expect(res.tokenKind).toBe("delegated");
  });

  it("returns code_not_found when no row matches the Job Code", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          values: [
            ["a", "b", "Job Code", "d", "e", "f"],
            ["x", "x", "OTHER-1", "", "", ""],
          ],
        },
      },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("code_not_found");
  });
});

describe("patchJobCodeCell — Graph error mapping", () => {
  it("maps Graph 403 on usedRange to graph_forbidden", async () => {
    mockFetchSequence([{ ok: false, status: 403, text: "Access denied" }]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("graph_forbidden");
  });

  it("maps Graph 5xx on PATCH to graph_unavailable", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          values: [
            ["a", "b", "Job Code", "d", "e", "f"],
            ["x", "x", "WOLFPACK-AUTO", "OLD", "", ""],
          ],
        },
      },
      { ok: false, status: 503, text: "throttled" },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("graph_unavailable");
  });

  it("returns not_configured when no token can be acquired", async () => {
    mockAcquireToken.mockResolvedValueOnce(null);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_configured");
  });
});
