/**
 * AI-code ledger store. Proves the deterministic id, workspace-scoped INSERT
 * with workspace_id supplied + ON CONFLICT, and the workspace-scoped list read.
 * db is mocked; persistence is best-effort.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { recordReview, listReviews } from "../store";
import type { CodeReviewResult } from "../types";

const result: CodeReviewResult = {
  ref: "PR-42",
  author: "agent-1",
  findings: [{ file: "x", line: 1, klass: "secret", severity: "critical", cwe: "CWE-798", title: "t", detail: "d", evidence: {} }],
  verdict: { outcome: "block", highestSeverity: "critical", reason: "r", ruleId: "C-CRITICAL-BLOCK" },
  bySeverity: { critical: 1 },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

test("recordReview inserts workspace-scoped with ON CONFLICT and a deterministic acr_ id", async () => {
  const id = await recordReview("w-1", result, "2026-06-29T00:00:00.000Z");
  expect(id).toMatch(/^acr_[0-9a-f]{24}$/);
  // Same inputs -> same id (stable per review event).
  expect(await recordReview("w-1", result, "2026-06-29T00:00:00.000Z")).toBe(id);

  const [sql, args] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_ai_code_reviews/i);
  expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
  expect(sql).toMatch(/workspace_id/i);
  expect(args[1]).toBe("w-1"); // workspace_id
  expect(args[4]).toBe("block"); // outcome
  expect(args[6]).toBe(1); // finding_count
  expect(args[7]).toContain("CWE-798"); // findings JSON
});

test("listReviews is workspace-scoped and maps rows", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [{ id: "acr_x", ref: "PR-1", author: "a", outcome: "allow", highest_severity: "low", finding_count: 2, created_at: "2026-06-29" }],
  });
  const rows = await listReviews("w-1");
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/FROM instinct_ai_code_reviews/i);
  expect(sql).toMatch(/workspace_id = \$1/);
  expect(params).toEqual(["w-1"]);
  expect(rows[0]).toMatchObject({ id: "acr_x", outcome: "allow", findingCount: 2 });
});
