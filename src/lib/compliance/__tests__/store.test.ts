/**
 * Compliance store. Deterministic id, workspace-scoped INSERT with workspace_id +
 * ON CONFLICT, and the scoped list read. db mocked.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { recordReport, listReports } from "../store";
import type { ComplianceReport } from "../types";

const report: ComplianceReport = {
  framework: "SOC2",
  generatedNote: "n",
  controls: [{ id: "SOC2-CC4.1", name: "x", ogiamControl: "ledger", rationale: "r", status: "covered", evidence: "e" }],
  covered: 3,
  partial: 1,
  gap: 0,
  coverage: 0.75,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

test("recordReport inserts workspace-scoped with ON CONFLICT and a deterministic cmp_ id", async () => {
  const id = await recordReport("w-1", report, "2026-06-30T00:00:00.000Z");
  expect(id).toMatch(/^cmp_[0-9a-f]{24}$/);
  expect(await recordReport("w-1", report, "2026-06-30T00:00:00.000Z")).toBe(id);
  const [sql, args] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_compliance_reports/i);
  expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
  expect(args[1]).toBe("w-1");
  expect(args[2]).toBe("SOC2");
  expect(args[3]).toBe(0.75);
});

test("listReports is workspace-scoped and maps rows", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ id: "cmp_x", framework: "EU_AI_ACT", coverage: 0.9, covered: 3, partial: 1, gap: 0, created_at: "t" }] });
  const rows = await listReports("w-1");
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/FROM instinct_compliance_reports/i);
  expect(sql).toMatch(/workspace_id = \$1/);
  expect(params).toEqual(["w-1"]);
  expect(rows[0]).toMatchObject({ id: "cmp_x", framework: "EU_AI_ACT", coverage: 0.9 });
});
