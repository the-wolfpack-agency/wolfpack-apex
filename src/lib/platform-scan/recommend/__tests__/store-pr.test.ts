/**
 * Store tests for the remediation-PR persistence helpers. The db boundary is
 * mocked, so getRecommendationById's (workspace_id, id) lookup + prUrl parse and
 * setRecommendationPr's UPDATE ... RETURNING (pr_url + pr_opened_at + accepted)
 * are asserted with no DB touched.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { getRecommendationById, setRecommendationPr } from "@/lib/platform-scan/recommend/store";

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: "rec-12345678",
  platform: "wolfpack-auto",
  key: "security_remediation:headers",
  category: "security_remediation",
  priority: "high",
  title: "Add a security-headers middleware",
  rationale: "3 responses missing headers.",
  suggested_action: "Set the headers in middleware.",
  source: "finding:security",
  evidence: JSON.stringify({ count: 3 }),
  status: "proposed",
  created_at: "2026-06-27T00:00:00.000Z",
  pr_url: null,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("getRecommendationById", () => {
  it("selects by (workspace_id, id) and parses prUrl + evidence", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [dbRow({ pr_url: "https://github.com/o/r/pull/7" })] });
    const row = await getRecommendationById("ws-1", "rec-12345678");

    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE workspace_id = \$1 AND id = \$2/);
    expect(params).toEqual(["ws-1", "rec-12345678"]);
    expect(row).not.toBeNull();
    expect(row!.id).toBe("rec-12345678");
    expect(row!.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(row!.evidence).toEqual({ count: 3 });
  });

  it("returns null when no row matches", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getRecommendationById("ws-1", "missing")).toBeNull();
  });
});

describe("setRecommendationPr", () => {
  it("UPDATEs pr_url + pr_opened_at + status='accepted' with RETURNING and returns the parsed row", async () => {
    mockWriteQuery.mockResolvedValue({
      rows: [dbRow({ status: "accepted", pr_url: "https://github.com/o/r/pull/7" })],
    });
    const updated = await setRecommendationPr("ws-1", "rec-12345678", "https://github.com/o/r/pull/7", "admin-1");

    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_automation_recommendations/);
    expect(sql).toMatch(/pr_url = \$3/);
    expect(sql).toMatch(/pr_opened_at = NOW\(\)/);
    expect(sql).toMatch(/status = 'accepted'/);
    expect(sql).toMatch(/RETURNING/);
    expect(params).toEqual(["ws-1", "rec-12345678", "https://github.com/o/r/pull/7", "admin-1"]);

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("accepted");
    expect(updated!.prUrl).toBe("https://github.com/o/r/pull/7");
  });

  it("returns null when no row matches", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [] });
    expect(await setRecommendationPr("ws-1", "missing", "https://x", "admin-1")).toBeNull();
  });
});
