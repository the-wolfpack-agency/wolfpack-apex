/**
 * Cell-writer contract tests. After 2026-05-21 refactor: column
 * positions are DISCOVERED from the worksheet header row at write
 * time. Tests use `columnName: "Program" | "PO Number" | "PO Amount"`
 * (the API also accepts legacy column-letter D/E/F).
 *
 * Guardrail: writer MUST never PATCH a column whose header is the
 * Job Code or Client/Category, regardless of position in the sheet.
 */

const mockAcquireToken = jest.fn();
jest.mock("@/lib/job-codes/sharepoint-source", () => ({
  acquireSharePointToken: (...a: unknown[]) => mockAcquireToken(...a),
}));

import {
  patchJobCodeCell,
  EDITABLE_HEADERS,
  LETTER_TO_HEADER,
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

/* Canonical Wolfpack workbook layout: B=Client/Category, C=Code,
   D=Program, E=PO Number, F=PO Amount. Used in every happy-path
   test below. */
const CANONICAL_HEADERS = ["A-blank", "Client/Category", "Code", "Program", "PO Number", "PO Amount"];

beforeEach(() => {
  jest.resetAllMocks();
  mockAcquireToken.mockResolvedValue({ token: "tok", kind: "delegated" });
});

describe("patchJobCodeCell — column resolution guardrail", () => {
  /* PINNED: writer MUST refuse a request that doesn't resolve to one
     of EDITABLE_HEADERS BEFORE any Graph call. */
  for (const bad of ["A", "B", "C", "G", "Z", "abc", "", "1"]) {
    it(`refuses column letter "${bad}" without firing Graph`, async () => {
      global.fetch = jest.fn();
      const res = await patchJobCodeCell({ ...baseInput, column: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("forbidden_column");
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockAcquireToken).not.toHaveBeenCalled();
    });
  }

  for (const bad of ["Code", "Client/Category", "anything else"]) {
    it(`refuses columnName "${bad}" without firing Graph`, async () => {
      global.fetch = jest.fn();
      const res = await patchJobCodeCell({ ...baseInput, columnName: bad as any });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("forbidden_column");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  }

  it("EDITABLE_HEADERS contains exactly Program / PO Number / PO Amount", () => {
    expect([...EDITABLE_HEADERS].sort()).toEqual(["PO Amount", "PO Number", "Program"]);
  });

  it("LETTER_TO_HEADER maps D/E/F to canonical names", () => {
    expect(LETTER_TO_HEADER.D).toBe("Program");
    expect(LETTER_TO_HEADER.E).toBe("PO Number");
    expect(LETTER_TO_HEADER.F).toBe("PO Amount");
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
  it("requires value to be a string", async () => {
    const res = await patchJobCodeCell({ ...baseInput, column: "D", value: 12345 as unknown as string });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_input");
  });
});

describe("patchJobCodeCell — header discovery + Graph happy path", () => {
  it("discovers Program column from headers and PATCHes the matching row", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          address: "'S'!A1:F3", rowIndex: 0, columnIndex: 0,
          values: [
            CANONICAL_HEADERS,
            ["", "Acme", "OTHER-1", "", "", ""],
            ["", "Acme", "WOLFPACK-AUTO", "OLD", "PO-OLD", "100"],
          ],
        },
      },
      /* verify-cell (Code) read */
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      /* current-value (editable cell) read for concurrency / idempotency gate */
      { ok: true, body: { values: [["OLD"]] } },
      /* PATCH */
      { ok: true, body: { values: [["Phase 2"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cellAddress).toBe("D3");
    expect(res.rowIndex).toBe(3);
    expect(res.previousValue).toBe("OLD");
    expect(res.newValue).toBe("Phase 2");
  });

  it("works when the Code column is at a DIFFERENT letter than C", async () => {
    /* Real-world finding (2026-05-21): Wolfpack workbook has Code at
       column B, not C. The hardcoded-C writer 404'd on every lookup.
       Header-discovery writer must handle this. */
    mockFetchSequence([
      {
        ok: true,
        body: {
          address: "'S'!A1:E2", rowIndex: 0, columnIndex: 0,
          values: [
            ["Code", "Client/Category", "Program", "PO Number", "PO Amount"],
            ["WOLFPACK-AUTO", "Acme", "OLD", "PO-OLD", "100"],
          ],
        },
      },
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      { ok: true, body: { values: [["OLD"]] } },
      { ok: true, body: { values: [["NEW PROG"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, columnName: "Program", value: "NEW PROG" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    /* Program is at index 2 here → column C; row matched at i=1 →
       Excel row 2. */
    expect(res.cellAddress).toBe("C2");
    expect(res.previousValue).toBe("OLD");
  });

  it("returns code_not_found when the Job Code value isn't anywhere in the sheet", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: { address: "'S'!A1:F4", rowIndex: 0, columnIndex: 0, values: [CANONICAL_HEADERS, ["", "x", "OTHER-1", "", "", ""]] },
      },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("code_not_found");
  });

  it("returns code_not_found with a clear hint when the sheet lacks a Code-shaped header", async () => {
    mockFetchSequence([
      { ok: true, body: { address: "'S'!A1:F4", rowIndex: 0, columnIndex: 0, values: [["Foo", "Bar", "Baz"], ["x", "y", "z"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("code_not_found");
      expect(res.detail).toMatch(/no Job Code column/i);
    }
  });

  it("returns code_not_found when the requested editable header isn't in the sheet", async () => {
    mockFetchSequence([
      { ok: true, body: { address: "'S'!A1:F4", rowIndex: 0, columnIndex: 0, values: [["Client/Category", "Code"], ["x", "WOLFPACK-AUTO"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, columnName: "Program" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("code_not_found");
      expect(res.detail).toMatch(/no column with header "Program"/);
    }
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
      { ok: true, body: { address: "'S'!A1:F2", rowIndex: 0, columnIndex: 0, values: [CANONICAL_HEADERS, ["", "x", "WOLFPACK-AUTO", "OLD", "", ""]] } },
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      /* current-value read for concurrency / idempotency gate */
      { ok: true, body: { values: [["OLD"]] } },
      { ok: false, status: 503, text: "throttled" },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("graph_unavailable");
  });

  it("REGRESSION 2026-05-21: respects usedRange origin (rowIndex > 0)", async () => {
    /* The destructive bug: writer computed Excel row = arrayIndex+1
       ignoring rowIndex offset. Pinned here. */
    mockFetchSequence([
      {
        ok: true,
        body: {
          address: "'2026'!A3:F5", rowIndex: 2, columnIndex: 0,
          values: [CANONICAL_HEADERS, ["", "Acme", "OTHER-1", "", "", ""], ["", "Acme", "WOLFPACK-AUTO", "OLD", "PO-OLD", "100"]],
        },
      },
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      { ok: true, body: { values: [["OLD"]] } },
      { ok: true, body: { values: [["Phase 2"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rowIndex).toBe(5);
    expect(res.cellAddress).toBe("D5");
  });

  it("REFUSES to write when verify-cell-read returns a different Code (safety gate)", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          address: "'S'!A1:F3", rowIndex: 0, columnIndex: 0,
          values: [CANONICAL_HEADERS, ["", "Acme", "OTHER-1", "", "", ""], ["", "Acme", "WOLFPACK-AUTO", "OLD", "PO-OLD", "100"]],
        },
      },
      { ok: true, body: { values: [["WRONG-CODE"]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("internal");
      expect(res.detail).toMatch(/address-resolution mismatch/i);
    }
  });

  it("returns internal when usedRange response is missing address/rowIndex (won't guess)", async () => {
    mockFetchSequence([
      { ok: true, body: { values: [CANONICAL_HEADERS, ["", "x", "WOLFPACK-AUTO", "", "", ""]] } },
    ]);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("internal");
      expect(res.detail).toMatch(/missing address/i);
    }
  });

  it("returns not_configured when no token can be acquired", async () => {
    mockAcquireToken.mockResolvedValueOnce(null);
    const res = await patchJobCodeCell({ ...baseInput, column: "D" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_configured");
  });
});

describe("patchJobCodeCell — optimiztic concurrency + idempotency", () => {
  /* The shared usedRange body: WOLFPACK-AUTO at row 3 with
     Program="HOXSIE-VALUE" (someone else's write between snapshot
     and submit). */
  const usedRangeWithCurrent = (current: string) => ({
    ok: true,
    body: {
      address: "'S'!A1:F3", rowIndex: 0, columnIndex: 0,
      values: [
        CANONICAL_HEADERS,
        ["", "Acme", "OTHER-1", "", "", ""],
        ["", "Acme", "WOLFPACK-AUTO", current, "PO-1", "100"],
      ],
    },
  });

  it("returns conflict (ok:false) when current value != expectedValue and != requested", async () => {
    mockFetchSequence([
      usedRangeWithCurrent("HOXSIE-VALUE"),
      /* verify Code */
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      /* current-value of editable cell (Program) */
      { ok: true, body: { values: [["HOXSIE-VALUE"]] } },
    ]);
    const res = await patchJobCodeCell({
      ...baseInput,
      column: "D",
      value: "MY-VALUE",
      expectedValue: "OLD",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("conflict");
    expect(res.conflict).toEqual({
      column: "Program",
      currentValue: "HOXSIE-VALUE",
      expectedValue: "OLD",
      requestedValue: "MY-VALUE",
    });
    /* PATCH must NOT have been issued. 3 reads total. */
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
  });

  it("no conflict when expectedValue matches current — proceeds to PATCH", async () => {
    mockFetchSequence([
      usedRangeWithCurrent("OLD"),
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      { ok: true, body: { values: [["OLD"]] } },
      { ok: true, body: { values: [["NEW"]] } },
    ]);
    const res = await patchJobCodeCell({
      ...baseInput,
      column: "D",
      value: "NEW",
      expectedValue: "OLD",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newValue).toBe("NEW");
    expect(res.previousValue).toBe("OLD");
  });

  it("no conflict when current cell is empty (treated as no pre-existing value)", async () => {
    mockFetchSequence([
      usedRangeWithCurrent(""),
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      { ok: true, body: { values: [[""]] } },
      { ok: true, body: { values: [["NEW"]] } },
    ]);
    const res = await patchJobCodeCell({
      ...baseInput,
      column: "D",
      value: "NEW",
      expectedValue: "I-EXPECTED-SOMETHING",
    });
    expect(res.ok).toBe(true);
  });

  it("opts out of the conflict gate when expectedValue is null (server scripts)", async () => {
    mockFetchSequence([
      usedRangeWithCurrent("HOXSIE-VALUE"),
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      { ok: true, body: { values: [["HOXSIE-VALUE"]] } },
      { ok: true, body: { values: [["FORCE"]] } },
    ]);
    const res = await patchJobCodeCell({
      ...baseInput,
      column: "D",
      value: "FORCE",
      expectedValue: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newValue).toBe("FORCE");
  });

  it("idempotent: when current value equals the requested value, skips PATCH and returns noop=true", async () => {
    mockFetchSequence([
      usedRangeWithCurrent("SAME"),
      { ok: true, body: { values: [["WOLFPACK-AUTO"]] } },
      /* current cell already holds SAME */
      { ok: true, body: { values: [["SAME"]] } },
    ]);
    const res = await patchJobCodeCell({
      ...baseInput,
      column: "D",
      value: "SAME",
      expectedValue: "SAME",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.noop).toBe(true);
    expect(res.previousValue).toBe("SAME");
    expect(res.newValue).toBe("SAME");
    /* Only 3 reads, no PATCH. */
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
  });
});
