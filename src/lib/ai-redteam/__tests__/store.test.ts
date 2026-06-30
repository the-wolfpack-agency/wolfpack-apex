/**
 * Red-team store. Deterministic id, workspace-scoped INSERT with workspace_id +
 * ON CONFLICT, risk=critical when any vuln got through, and the scoped list read.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { recordRun, listRuns, riskFor } from "../store";
import type { RedTeamReport } from "../types";

const clean: RedTeamReport = { attacksRun: 8, blocked: 8, vulns: [], passRate: 1, byCategory: {} };
const breached: RedTeamReport = {
  attacksRun: 8,
  blocked: 7,
  vulns: [{ attackId: "x", category: "LLM06_info_disclosure", technique: "t", outcome: "allow", ruleId: "R" }],
  passRate: 0.875,
  byCategory: {},
};

beforeEach(() => {
  jest.resetAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

test("riskFor: clean is low, any vuln is critical", () => {
  expect(riskFor(clean)).toBe("low");
  expect(riskFor(breached)).toBe("critical");
});

test("recordRun inserts workspace-scoped with ON CONFLICT and a deterministic art_ id", async () => {
  const id = await recordRun("w-1", clean, "cron", "2026-06-30T00:00:00.000Z");
  expect(id).toMatch(/^art_[0-9a-f]{24}$/);
  expect(await recordRun("w-1", clean, "cron", "2026-06-30T00:00:00.000Z")).toBe(id);
  const [sql, args] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_ai_redteam_runs/i);
  expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
  expect(args[1]).toBe("w-1");
  expect(args[7]).toBe("low"); // risk
});

test("recordRun marks a breached run critical", async () => {
  await recordRun("w-1", breached, "manual", "2026-06-30T00:00:00.000Z");
  const [, args] = mockSafeQuery.mock.calls[0];
  expect(args[4]).toBe(1); // vulns count
  expect(args[7]).toBe("critical");
});

test("listRuns is workspace-scoped and maps rows", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ id: "art_x", attacks_run: 8, blocked: 8, vulns: 0, pass_rate: 1, risk: "low", source: "cron", created_at: "t" }] });
  const rows = await listRuns("w-1");
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/FROM instinct_ai_redteam_runs/i);
  expect(sql).toMatch(/workspace_id = \$1/);
  expect(params).toEqual(["w-1"]);
  expect(rows[0]).toMatchObject({ id: "art_x", passRate: 1, risk: "low" });
});
