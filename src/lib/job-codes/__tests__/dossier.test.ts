/**
 * Unit tests for buildCodeDossier — the SQL aggregator behind
 * /api/job-codes/[code]/dossier.
 *
 * The aim is to lock the rollup math + ordering so a refactor that
 * touches the YTD/MTD bucketing, PO remaining sign, or activity
 * merge order fails at PR time.
 */

export {};

const mockQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import { buildCodeDossier } from "../dossier";

interface PgRow extends Record<string, unknown> {}

function rows<T extends PgRow>(rows: T[]): { rows: T[] } {
  return { rows };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("buildCodeDossier", () => {
  it("returns null when the cache has no row for the code", async () => {
    mockQuery.mockResolvedValueOnce(rows([])); // cache miss
    const res = await buildCodeDossier("UNKNOWN");
    expect(res).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns null on empty / whitespace input without hitting the DB", async () => {
    expect(await buildCodeDossier("")).toBeNull();
    expect(await buildCodeDossier("   ")).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("assembles header from cache + parses PO amount + picks category", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{
        code: "WOLFPACK-AUTO",
        description: "Wolfpack Auto programme",
        active: true,
        last_seen_at: "2026-05-21T00:00:00.000Z",
        source_web_url: "https://sp/x.xlsx",
        extra: {
          "Client/Category": "Wolfpack Auto",
          "Program": "Phase 2",
          "PO Number": "PO-42",
          "PO Amount": "$3,500.00",
        },
      }]))
      .mockResolvedValueOnce(rows([])) // receipts
      .mockResolvedValueOnce(rows([])) // edits
      .mockResolvedValueOnce(rows([])); // events

    const d = await buildCodeDossier("WOLFPACK-AUTO");
    expect(d).not.toBeNull();
    expect(d!.header).toMatchObject({
      code: "WOLFPACK-AUTO",
      description: "Wolfpack Auto programme",
      active: true,
      category: "Wolfpack Auto",
      program: "Phase 2",
      poNumber: "PO-42",
      poAmount: "$3,500.00",
      poAmountNumeric: 3500,
      webUrl: "https://sp/x.xlsx",
    });
  });

  it("rolls up YTD/MTD spend from applied receipts", async () => {
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
    /* Last-year date: previous year, same month-day to avoid leap-year issues. */
    const lastYear = new Date(Date.UTC(now.getUTCFullYear() - 1, 6, 1)).toISOString();
    /* Earlier this year but a different month than current. We use
       month 0 (January) and substitute month 6 (July) when the
       current month is January to guarantee a "this YTD but not
       this MTD" datapoint. */
    const sameYearOtherMonth = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() === 0 ? 6 : 0,
      1,
    )).toISOString();

    mockQuery
      .mockResolvedValueOnce(rows([{
        code: "X", description: "x", active: true,
        last_seen_at: now.toISOString(), source_web_url: null,
        extra: { "PO Amount": "1000" },
      }]))
      .mockResolvedValueOnce(rows([
        { id: "a", applied_at: thisMonth, uploaded_by_email: null,
          fields: { total: 100, currency: "USD" },
          applied_program: null, applied_po_number: null, applied_po_amount: null },
        { id: "b", applied_at: sameYearOtherMonth, uploaded_by_email: null,
          fields: { total: 250, currency: "USD" },
          applied_program: null, applied_po_number: null, applied_po_amount: null },
        { id: "c", applied_at: lastYear, uploaded_by_email: null,
          fields: { total: 999, currency: "USD" },
          applied_program: null, applied_po_number: null, applied_po_amount: null },
      ]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const d = await buildCodeDossier("X");
    expect(d!.rollups.spendMtd).toBe(100);
    expect(d!.rollups.spendYtd).toBe(350); // 100 + 250
    expect(d!.rollups.spendAllTime).toBe(1349); // + 999 last year
    expect(d!.rollups.receiptCount).toBe(3);
    expect(d!.rollups.poRemaining).toBe(1000 - 1349); // -349
  });

  it("falls back to parsing applied_po_amount when receipt fields.total is missing", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{
        code: "Y", description: "y", active: true,
        last_seen_at: new Date().toISOString(), source_web_url: null,
        extra: { "PO Amount": "500" },
      }]))
      .mockResolvedValueOnce(rows([{
        id: "r", applied_at: new Date().toISOString(),
        uploaded_by_email: null, fields: { total: null, currency: null },
        applied_program: null, applied_po_number: null,
        applied_po_amount: "$120.50",
      }]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const d = await buildCodeDossier("Y");
    expect(d!.rollups.spendAllTime).toBe(120.5);
    expect(d!.rollups.poRemaining).toBe(500 - 120.5);
  });

  it("poRemaining is null when PO Amount is unset / unparseable", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{
        code: "Z", description: "", active: true,
        last_seen_at: new Date().toISOString(), source_web_url: null,
        extra: {},
      }]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const d = await buildCodeDossier("Z");
    expect(d!.rollups.poRemaining).toBeNull();
  });

  it("merges audit-log edits and non-edit events into one activity stream, newest-first", async () => {
    const t1 = "2026-05-21T10:00:00.000Z"; // newest
    const t2 = "2026-05-20T10:00:00.000Z";
    const t3 = "2026-05-19T10:00:00.000Z"; // oldest

    mockQuery
      .mockResolvedValueOnce(rows([{
        code: "W", description: "", active: true,
        last_seen_at: t1, source_web_url: null, extra: {},
      }]))
      .mockResolvedValueOnce(rows([])) // receipts
      .mockResolvedValueOnce(rows([
        {
          column_name: "PO Number",
          old_value: "PO-1",
          new_value: "PO-2",
          edited_by: "u-a",
          edited_by_email: "nick@thewolfpack.agency",
          edited_by_role: "cto",
          status: "succeeded",
          graph_error: null,
          created_at: t2,
        },
      ]))
      .mockResolvedValueOnce(rows([
        /* cell_edit_succeeded event MUST be filtered out (duplicates
           the edit row above). */
        {
          event_type: "jobcodes.cell_edit_succeeded",
          user_id: "u-a", user_role: "cto",
          metadata: { code: "W" }, timestamp: t2,
        },
        /* receipt_applied event KEPT. */
        {
          event_type: "jobcodes.receipt_applied",
          user_id: "u-a", user_role: "cto",
          metadata: { code: "W", scan_id: "r-1" }, timestamp: t1,
        },
        {
          event_type: "jobcodes.receipt_scanned",
          user_id: "u-b", user_role: "ops",
          metadata: { code: "W" }, timestamp: t3,
        },
      ]));

    const d = await buildCodeDossier("W");
    expect(d!.activity.length).toBe(3); // edit + 2 events; cell_edit_succeeded dropped
    expect(d!.activity[0].at).toBe(t1);
    expect(d!.activity[1].at).toBe(t2);
    expect(d!.activity[2].at).toBe(t3);
    expect(d!.activity[1].kind).toBe("cell_edit");
    expect(d!.activity[1].summary).toContain("PO Number");
    expect(d!.rollups.lastActivityAt).toBe(t1);
  });
});
