/**
 * listProtections: what the gate caught + whether the factory's PRs landed, from
 * the event stream, workspace-scoped. db mocked. Three queries in order:
 * findings-by-class, run outcomes, PR outcomes.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { listProtections, labelForClass } from "@/lib/ai-code/protections";

beforeEach(() => jest.clearAllMocks());

test("labelForClass gives product-agnostic names, falls back gracefully", () => {
  expect(labelForClass("logged_credential")).toMatch(/secret/i);
  expect(labelForClass("sql_injection")).toBe("SQL injection");
  expect(labelForClass("some_new_class")).toBe("Some new class");
});

test("aggregates findings by class + run outcomes + PR outcomes, workspace-scoped", async () => {
  mockSafeQuery
    .mockResolvedValueOnce({ rows: [{ klass: "logged_credential", n: 3 }, { klass: "sql_injection", n: 1 }] })
    .mockResolvedValueOnce({ rows: [{ blocked: 2, escalated: 1, criticals: 4 }] })
    .mockResolvedValueOnce({ rows: [{ opened: 10, merged: 6, closed: 2 }] });
  const p = await listProtections("w1", 30);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["30", "w1"]); // scoped
  expect(mockSafeQuery.mock.calls[2][1]).toEqual(["30", "w1"]); // outcomes scoped too
  expect(p.totalCaught).toBe(4);
  expect(p.byClass[0]).toMatchObject({ klass: "logged_credential", count: 3 });
  expect(p.byClass[0].label).toMatch(/secret/i);
  expect(p.changesBlocked).toBe(2);
  expect(p.sentForReview).toBe(1);
  expect(p.criticalsCaught).toBe(4);
  expect(p.prsOpened).toBe(10);
  expect(p.prsMerged).toBe(6);
  expect(p.prsClosedUnmerged).toBe(2);
  // acceptance = merged / (merged + closed), NOT / opened: open PRs haven't settled.
  expect(p.acceptanceRate).toBeCloseTo(6 / 8, 5);
});

test("acceptanceRate is null until something settles (honest n/a, never a fake 100%)", async () => {
  mockSafeQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ blocked: 0, escalated: 0, criticals: 0 }] })
    .mockResolvedValueOnce({ rows: [{ opened: 3, merged: 0, closed: 0 }] });
  const p = await listProtections("w1");
  expect(p.prsOpened).toBe(3);
  expect(p.acceptanceRate).toBeNull();
});

test("returns zeros on empty streams (never throws)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  const p = await listProtections("w1");
  expect(p.totalCaught).toBe(0);
  expect(p.changesBlocked).toBe(0);
  expect(p.prsOpened).toBe(0);
  expect(p.acceptanceRate).toBeNull();
});
