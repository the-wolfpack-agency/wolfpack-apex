/**
 * Recommendation persistence test: the db boundary is mocked, so the upsert
 * shape (one row per workspace+platform+key, preserving human triage by NOT
 * overwriting status), the JSON evidence round-trip + filter params on read, and
 * the triage UPDATE ... RETURNING (null when no row) are all asserted with no DB.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { saveRecommendations, listRecommendations, triageRecommendation } from "@/lib/platform-scan/recommend/store";
import type { AutomationRecommendation } from "@/lib/platform-scan/recommend/types";

const REC: AutomationRecommendation = {
  key: "security_remediation:headers",
  category: "security_remediation",
  priority: "high",
  title: "Add a security-headers middleware",
  rationale: "headers missing",
  suggestedAction: "set them in middleware",
  source: "finding:security",
  evidence: { count: 2 },
};

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: "rec-1",
  platform: "acme",
  key: REC.key,
  category: REC.category,
  priority: REC.priority,
  title: REC.title,
  rationale: REC.rationale,
  suggested_action: REC.suggestedAction,
  source: REC.source,
  evidence: JSON.stringify(REC.evidence),
  status: "proposed",
  created_at: "2026-06-27T00:00:00.000Z",
  ...over,
});

beforeEach(() => jest.clearAllMocks());

it("saveRecommendations upserts each rec on (workspace_id, platform, key) and never overwrites status", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [] });
  const second: AutomationRecommendation = { ...REC, key: "operational:sast", title: "SAST" };
  const n = await saveRecommendations("ws-1", "acme", [REC, second]);

  expect(n).toBe(2);
  expect(mockWriteQuery).toHaveBeenCalledTimes(2);
  const [sql, params] = mockWriteQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_automation_recommendations/);
  expect(sql).toMatch(/ON CONFLICT \(workspace_id, platform, key\) DO UPDATE/);
  // The UPDATE SET list must NOT touch status (human triage is preserved).
  const setClause = sql.slice(sql.indexOf("DO UPDATE SET"));
  expect(setClause).not.toMatch(/\bstatus\b/);
  // Evidence is serialized to a JSON string.
  expect(params[0]).toBe("ws-1");
  expect(params[1]).toBe("acme");
  expect(params[2]).toBe(REC.key);
  expect(params[9]).toBe(JSON.stringify(REC.evidence));
});

it("listRecommendations parses the evidence JSON string into an object and passes the filter params", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [dbRow()] });
  const rows = await listRecommendations("ws-1", { platform: "acme", status: "proposed" });

  expect(rows).toHaveLength(1);
  expect(rows[0].evidence).toEqual({ count: 2 });
  expect(typeof rows[0].evidence).toBe("object");
  expect(rows[0].suggestedAction).toBe(REC.suggestedAction);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "acme", "proposed"]);
});

it("listRecommendations defaults the platform/status filter params to null", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  await listRecommendations("ws-1");
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", null, null]);
});

it("triageRecommendation issues UPDATE ... RETURNING and returns the parsed row", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [dbRow({ status: "accepted" })] });
  const updated = await triageRecommendation("ws-1", "rec-1", "accepted", "admin-1");

  const [sql, params] = mockWriteQuery.mock.calls[0];
  expect(sql).toMatch(/UPDATE instinct_automation_recommendations/);
  expect(sql).toMatch(/RETURNING/);
  expect(params).toEqual(["ws-1", "rec-1", "accepted", "admin-1"]);
  expect(updated).not.toBeNull();
  expect(updated!.status).toBe("accepted");
  expect(updated!.evidence).toEqual({ count: 2 });
});

it("triageRecommendation returns null when no row matches", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [] });
  expect(await triageRecommendation("ws-1", "missing", "dismissed", "admin-1")).toBeNull();
});
