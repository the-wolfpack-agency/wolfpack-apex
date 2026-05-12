 
const mockCreateBudget = jest.fn();
const mockListBudgets = jest.fn();
const mockGetBudget = jest.fn();
const mockUpdateBudget = jest.fn();
const mockDeleteBudget = jest.fn();
const mockCreateLine = jest.fn();
const mockUpdateLine = jest.fn();
const mockDeleteLine = jest.fn();
const mockCreateActual = jest.fn();
const mockListLines = jest.fn(async () => []);
const mockListActuals = jest.fn(async () => []);
const mockListCategories = jest.fn(async () => []);
const mockRollup = jest.fn(async () => ({
  fixed: [],
  variable: [],
  fixedSubtotal: 0,
  variableSubtotal: 0,
  plannedGrandTotal: 0,
  actualGrandTotal: 0,
  variance: 0,
  contingencyAmount: 0,
  contingencyPct: 0,
}));
const mockTrack = jest.fn();
let authUser: { id: string; role: string } | null = { id: "u1", role: "cto" };

jest.mock("@/lib/programs/budget-store", () => ({
  createBudget: (...a: unknown[]) => mockCreateBudget(...(a as [])),
  listBudgets: (...a: unknown[]) => mockListBudgets(...(a as [])),
  getBudget: (...a: unknown[]) => mockGetBudget(...(a as [])),
  updateBudget: (...a: unknown[]) => mockUpdateBudget(...(a as [])),
  deleteBudget: (...a: unknown[]) => mockDeleteBudget(...(a as [])),
  createLine: (...a: unknown[]) => mockCreateLine(...(a as [])),
  updateLine: (...a: unknown[]) => mockUpdateLine(...(a as [])),
  deleteLine: (...a: unknown[]) => mockDeleteLine(...(a as [])),
  createActual: (...a: unknown[]) => mockCreateActual(...(a as [])),
  listLines: (...a: unknown[]) => mockListLines(...(a as [])),
  listActuals: (...a: unknown[]) => mockListActuals(...(a as [])),
  listBudgetCategories: (...a: unknown[]) => mockListCategories(...(a as [])),
  getBudgetRollup: (...a: unknown[]) => mockRollup(...(a as [])),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { GET as listGet, POST as listPost } from "../route";
import {
  GET as detailGet,
  PATCH as detailPatch,
  DELETE as detailDelete,
} from "../[id]/route";
import { POST as linePost } from "../[id]/lines/route";
import { PATCH as linePatch, DELETE as lineDelete } from "../[id]/lines/[lineId]/route";
import { POST as actualPost } from "../[id]/actuals/route";

beforeEach(() => {
  [
    mockCreateBudget,
    mockListBudgets,
    mockGetBudget,
    mockUpdateBudget,
    mockDeleteBudget,
    mockCreateLine,
    mockUpdateLine,
    mockDeleteLine,
    mockCreateActual,
    mockTrack,
  ].forEach((m) => m.mockReset());
  mockListBudgets.mockResolvedValue([]);
  mockListLines.mockResolvedValue([]);
  mockListActuals.mockResolvedValue([]);
  mockListCategories.mockResolvedValue([]);
  authUser = { id: "u1", role: "cto" };
});

const req = (path: string, init: RequestInit = {}): NextRequest => {
  const merged = {
    ...init,
    headers: {
      authorization: "Bearer x",
      "content-type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  } as unknown as ConstructorParameters<typeof NextRequest>[1];
  return new NextRequest(`https://wp.test${path}`, merged);
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxLine = (id: string, lineId: string) => ({
  params: Promise.resolve({ id, lineId }),
});

describe("GET /api/programs/budgets", () => {
  test("401 without auth", async () => {
    authUser = null;
    const res = await listGet(req("/api/programs/budgets"));
    expect(res.status).toBe(401);
  });
  test("returns budgets list", async () => {
    mockListBudgets.mockResolvedValueOnce([{ id: "b1" }]);
    const res = await listGet(req("/api/programs/budgets"));
    const j = await res.json();
    expect(j.budgets).toHaveLength(1);
  });
  test("status filter passed through", async () => {
    await listGet(req("/api/programs/budgets?status=active"));
    expect(mockListBudgets).toHaveBeenCalledWith({ status: "active" });
  });
});

describe("POST /api/programs/budgets", () => {
  test("400 when name missing", async () => {
    const res = await listPost(
      req("/api/programs/budgets", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
  test("creates and tracks programBudget.created", async () => {
    mockCreateBudget.mockResolvedValueOnce({ id: "b1", name: "X" });
    const res = await listPost(
      req("/api/programs/budgets", {
        method: "POST",
        body: JSON.stringify({ name: "X" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.created",
      "u1",
      "cto",
      expect.objectContaining({ budget_id: "b1" }),
    );
  });
});

describe("GET /api/programs/budgets/[id]", () => {
  test("404 when missing", async () => {
    mockGetBudget.mockResolvedValueOnce(null);
    const res = await detailGet(req("/api/programs/budgets/b1"), ctx("b1"));
    expect(res.status).toBe(404);
  });
  test("bundles budget + lines + categories + rollup + actuals + tracks viewed", async () => {
    mockGetBudget.mockResolvedValueOnce({ id: "b1", name: "X" });
    mockListLines.mockResolvedValueOnce([{ id: "l1" }] as never);
    mockListCategories.mockResolvedValueOnce([{ id: "c1" }] as never);
    mockListActuals.mockResolvedValueOnce([{ id: "a1" }] as never);
    const res = await detailGet(req("/api/programs/budgets/b1"), ctx("b1"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.lines).toHaveLength(1);
    expect(j.categories).toHaveLength(1);
    expect(j.actuals).toHaveLength(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.viewed",
      "u1",
      "cto",
      expect.objectContaining({ budget_id: "b1" }),
    );
  });
});

describe("PATCH /api/programs/budgets/[id]", () => {
  test("forwards specs payload", async () => {
    mockUpdateBudget.mockResolvedValueOnce({ id: "b1", name: "X" });
    await detailPatch(
      req("/api/programs/budgets/b1", {
        method: "PATCH",
        body: JSON.stringify({ specs: { weeks: 3 } }),
      }),
      ctx("b1"),
    );
    expect(mockUpdateBudget).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({ specs: { weeks: 3 } }),
    );
  });
});

describe("DELETE /api/programs/budgets/[id]", () => {
  test("calls store + tracks delete", async () => {
    const res = await detailDelete(
      req("/api/programs/budgets/b1", { method: "DELETE" }),
      ctx("b1"),
    );
    expect(res.status).toBe(200);
    expect(mockDeleteBudget).toHaveBeenCalledWith("b1");
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.deleted",
      "u1",
      "cto",
      expect.objectContaining({ budget_id: "b1" }),
    );
  });
});

describe("POST /api/programs/budgets/[id]/lines", () => {
  test("400 when categoryId missing", async () => {
    const res = await linePost(
      req("/api/programs/budgets/b1/lines", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      ctx("b1"),
    );
    expect(res.status).toBe(400);
  });
  test("creates and tracks line_added with planned_total", async () => {
    mockCreateLine.mockResolvedValueOnce({
      id: "l1",
      total: 1500,
      categoryId: "c1",
    });
    const res = await linePost(
      req("/api/programs/budgets/b1/lines", {
        method: "POST",
        body: JSON.stringify({
          categoryId: "c1",
          units: 10,
          rate: 150,
        }),
      }),
      ctx("b1"),
    );
    expect(res.status).toBe(201);
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.line_added",
      "u1",
      "cto",
      expect.objectContaining({ planned_total: 1500 }),
    );
  });
});

describe("PATCH/DELETE /api/programs/budgets/[id]/lines/[lineId]", () => {
  test("PATCH forwards units/rate; tracks line_updated", async () => {
    mockUpdateLine.mockResolvedValueOnce({ id: "l1", total: 1800 });
    await linePatch(
      req("/api/programs/budgets/b1/lines/l1", {
        method: "PATCH",
        body: JSON.stringify({ units: 12 }),
      }),
      ctxLine("b1", "l1"),
    );
    expect(mockUpdateLine).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({ units: 12 }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.line_updated",
      "u1",
      "cto",
      expect.objectContaining({ planned_total: 1800 }),
    );
  });
  test("DELETE tracks line_deleted", async () => {
    await lineDelete(
      req("/api/programs/budgets/b1/lines/l1", { method: "DELETE" }),
      ctxLine("b1", "l1"),
    );
    expect(mockDeleteLine).toHaveBeenCalledWith("l1");
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.line_deleted",
      "u1",
      "cto",
      expect.objectContaining({ line_id: "l1" }),
    );
  });
});

describe("POST /api/programs/budgets/[id]/actuals", () => {
  test("400 on bad source", async () => {
    const res = await actualPost(
      req("/api/programs/budgets/b1/actuals", {
        method: "POST",
        body: JSON.stringify({
          lineId: "l1",
          source: "wat",
          amount: 100,
        }),
      }),
      ctx("b1"),
    );
    expect(res.status).toBe(400);
  });
  test("400 when amount missing", async () => {
    const res = await actualPost(
      req("/api/programs/budgets/b1/actuals", {
        method: "POST",
        body: JSON.stringify({ lineId: "l1", source: "manual" }),
      }),
      ctx("b1"),
    );
    expect(res.status).toBe(400);
  });
  test("records actual and tracks programBudget.actual_recorded", async () => {
    mockCreateActual.mockResolvedValueOnce({
      id: "a1",
      lineId: "l1",
      source: "manual",
      amount: 1200,
    });
    const res = await actualPost(
      req("/api/programs/budgets/b1/actuals", {
        method: "POST",
        body: JSON.stringify({
          lineId: "l1",
          source: "manual",
          amount: 1200,
          vendor: "Acme",
        }),
      }),
      ctx("b1"),
    );
    expect(res.status).toBe(201);
    expect(mockTrack).toHaveBeenCalledWith(
      "programBudget.actual_recorded",
      "u1",
      "cto",
      expect.objectContaining({ source: "manual", amount: 1200 }),
    );
  });
});
