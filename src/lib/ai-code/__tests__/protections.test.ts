/**
 * listProtections: what the gate caught, from the event stream, workspace-scoped.
 * db mocked. Two queries: findings-by-class, then run outcomes.
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

test("aggregates findings by class + run outcomes, workspace-scoped", async () => {
  mockSafeQuery
    .mockResolvedValueOnce({ rows: [{ klass: "logged_credential", n: 3 }, { klass: "sql_injection", n: 1 }] })
    .mockResolvedValueOnce({ rows: [{ blocked: 2, escalated: 1, criticals: 4 }] });
  const p = await listProtections("w1", 30);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["30", "w1"]); // scoped
  expect(p.totalCaught).toBe(4);
  expect(p.byClass[0]).toMatchObject({ klass: "logged_credential", count: 3 });
  expect(p.byClass[0].label).toMatch(/secret/i);
  expect(p.changesBlocked).toBe(2);
  expect(p.sentForReview).toBe(1);
  expect(p.criticalsCaught).toBe(4);
});

test("returns zeros on empty streams (never throws)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  const p = await listProtections("w1");
  expect(p.totalCaught).toBe(0);
  expect(p.changesBlocked).toBe(0);
});
