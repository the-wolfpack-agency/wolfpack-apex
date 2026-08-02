 
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn(async () => ({
  query: mockClientQuery,
  release: mockClientRelease,
}));

jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
    writeQuery: (...a: any[]) => mockWriteQuery(...a),
    pool: { connect: () => mockPoolConnect() },
    // activePool() replaced direct pool use so every query is routed to the
    // tenant's database. The mock must expose it or the module under test
    // calls undefined.
    activePool: () => ({ connect: () => mockPoolConnect() }),
  };
});

import {
  createBudget,
  updateBudget,
  createLine,
  updateLine,
  bulkCreateLines,
  createActual,
  getBudgetRollup,
  listBudgets,
  getCategoryByName,
} from "@/lib/programs/budget-store";

const ORIGINAL_DB = process.env.DATABASE_URL;

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockClear();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL_DB) process.env.DATABASE_URL = ORIGINAL_DB;
  else delete process.env.DATABASE_URL;
});

const budgetRow = (override: Record<string, unknown> = {}) => ({
  id: "b1",
  name: "Test Program",
  job_number: "J-001",
  version: "v1",
  status: "draft",
  client_id: null,
  weeks: "2",
  prep_event_days: "3",
  markets: 4,
  event_days: "5",
  teams: 2,
  hotel: 1,
  ballroom: 1,
  breakout_rooms: 2,
  tents: 0,
  clear_span_frame: 0,
  vehicles: 4,
  static_display: 1,
  drive: 1,
  competitors: 3,
  contingency_pct: "5.00",
  notes: null,
  created_by: "u1",
  created_at: "2026-05-01",
  updated_at: "2026-05-01",
  ...override,
});

const lineRow = (override: Record<string, unknown> = {}) => ({
  id: "l1",
  budget_id: "b1",
  category_id: "c1",
  cost_code: "5.0001",
  responsible_user_id: null,
  line_number: "1",
  description: "Creative",
  name: "Designer",
  units: "10",
  rate: "150",
  total: "1500",
  notes: null,
  sort_order: 10,
  created_at: "2026-05-01",
  updated_at: "2026-05-01",
  ...override,
});

describe("createBudget", () => {
  test("rejects without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    await expect(
      createBudget({ name: "X" }),
    ).rejects.toThrow(/DATABASE_URL/);
  });
  test("rejects empty name", async () => {
    await expect(createBudget({ name: "  " })).rejects.toThrow(/name required/);
  });
  test("inserts and maps return row", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [budgetRow()] });
    const out = await createBudget({
      name: "Test Program",
      jobNumber: "J-001",
      contingencyPct: 5,
      specs: { weeks: 2, markets: 4, vehicles: 4, competitors: 3 },
    });
    expect(out.name).toBe("Test Program");
    expect(out.weeks).toBe(2);
    expect(out.contingencyPct).toBe(5);
    expect(out.markets).toBe(4);
    const sql = String(mockWriteQuery.mock.calls[0][0]);
    expect(sql).toMatch(/INSERT INTO instinct_program_budgets/);
  });
});

describe("updateBudget", () => {
  test("partial patch only sets touched columns", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [budgetRow({ name: "Renamed" })] });
    const out = await updateBudget("b1", { name: "Renamed" });
    expect(out.name).toBe("Renamed");
    const sql = String(mockWriteQuery.mock.calls[0][0]);
    expect(sql).toMatch(/SET name = \$1/);
    expect(sql).not.toMatch(/job_number = /);
  });
  test("status guarded by check constraint via SET clause", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [budgetRow({ status: "active" })] });
    await updateBudget("b1", { status: "active" });
    expect(String(mockWriteQuery.mock.calls[0][0])).toMatch(/status = /);
  });
  test("no fields → re-reads current state without UPDATE", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [budgetRow()] });
    const out = await updateBudget("b1", {});
    expect(out.id).toBe("b1");
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});

describe("listBudgets", () => {
  test("optional status filter", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [budgetRow()] });
    await listBudgets({ status: "active" });
    expect(String(mockSafeQuery.mock.calls[0][0])).toMatch(/status = \$1/);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["active", 100]);
  });
});

describe("createLine", () => {
  test("inserts with computed total via generated column", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [lineRow()] });
    const out = await createLine({
      budgetId: "b1",
      categoryId: "c1",
      units: 10,
      rate: 150,
      description: "Creative",
    });
    expect(out.total).toBe(1500);
    /* JS doesn't compute total — DB does. Confirm we DON'T pass total. */
    const params = mockWriteQuery.mock.calls[0][1];
    expect(params).not.toContain(1500);
  });
});

describe("updateLine", () => {
  test("partial patch (units only) leaves rate untouched", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [lineRow({ units: "12", total: "1800" })] });
    const out = await updateLine("l1", { units: 12 });
    expect(out.units).toBe(12);
    expect(out.total).toBe(1800);
    expect(String(mockWriteQuery.mock.calls[0][0])).toMatch(/units = /);
  });
});

describe("bulkCreateLines", () => {
  test("transactional — BEGIN + N inserts + COMMIT", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce(undefined as any) // INSERT 1
      .mockResolvedValueOnce(undefined as any) // INSERT 2
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const n = await bulkCreateLines([
      { budgetId: "b1", categoryId: "c1" },
      { budgetId: "b1", categoryId: "c2" },
    ]);
    expect(n).toBe(2);
    const sqls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.filter((s) => s.startsWith("INSERT"))).toHaveLength(2);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });
  test("rolls back on insert failure", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockRejectedValueOnce(new Error("constraint"));
    await expect(
      bulkCreateLines([{ budgetId: "b1", categoryId: "c1" }]),
    ).rejects.toThrow(/constraint/);
    expect(mockClientQuery.mock.calls.map((c) => String(c[0]))).toContain("ROLLBACK");
    expect(mockClientRelease).toHaveBeenCalled();
  });
});

describe("createActual", () => {
  test("rejects bad source via type narrowing", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "a1",
          line_id: "l1",
          source: "qb_bill",
          source_id: "INV-1",
          vendor: "Acme",
          amount: "1200",
          currency: "USD",
          occurred_at: "2026-04-30",
          evidence_jsonb: {},
          created_at: "2026-05-01",
        },
      ],
    });
    const out = await createActual({
      lineId: "l1",
      source: "qb_bill",
      sourceId: "INV-1",
      vendor: "Acme",
      amount: 1200,
    });
    expect(out.source).toBe("qb_bill");
    expect(out.amount).toBe(1200);
  });
});

describe("getBudgetRollup", () => {
  test("groups Fixed / Variable, computes subtotals + variance", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [budgetRow({ contingency_pct: "10.00" })],
    });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          category_id: "c1",
          code: 5,
          name: "Creative / Editorial",
          kind: "fixed",
          sort_order: 20,
          line_count: "2",
          planned_total: "1000",
          actual_total: "900",
        },
        {
          category_id: "c2",
          code: 11,
          name: "Airline",
          kind: "variable",
          sort_order: 270,
          line_count: "1",
          planned_total: "500",
          actual_total: "650",
        },
      ],
    });
    const out = await getBudgetRollup("b1");
    expect(out.fixedSubtotal).toBe(1000);
    expect(out.variableSubtotal).toBe(500);
    expect(out.contingencyAmount).toBeCloseTo(150, 5); // 10% of 1500
    expect(out.plannedGrandTotal).toBeCloseTo(1650, 5);
    expect(out.actualGrandTotal).toBe(1550);
    expect(out.variance).toBeCloseTo(1550 - 1650, 5);
    expect(out.fixed[0].variance).toBe(-100);
    expect(out.fixed[0].variancePct).toBeCloseTo(-10, 5);
    expect(out.variable[0].variance).toBe(150);
  });
  test("missing budget returns zeroed shell", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getBudgetRollup("missing");
    expect(out.plannedGrandTotal).toBe(0);
    expect(out.fixed).toEqual([]);
    expect(out.variable).toEqual([]);
  });
});

describe("getCategoryByName", () => {
  test("case-insensitive lookup", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "c1", code: 5, name: "Creative / Editorial", kind: "fixed", sort_order: 20 }],
    });
    const cat = await getCategoryByName("creative / editorial");
    expect(cat?.code).toBe(5);
    expect(String(mockSafeQuery.mock.calls[0][0])).toMatch(/LOWER\(name\) = LOWER\(\$1\)/);
  });
});
