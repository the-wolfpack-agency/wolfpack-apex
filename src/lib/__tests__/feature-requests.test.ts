/**
 * Feature Request Library Tests
 */

// Mock db before imports. writeQuery is the strict path — it throws
// on any failure (missing DATABASE_URL, pg error, unexpected row count)
// so the test-side mock mirrors that behaviour explicitly. safeQuery
// is the lenient path used for reads.
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();

class MockWriteQueryError extends Error {
  readonly code: "no_database" | "db_error" | "unexpected_row_count";
  readonly expected?: number;
  readonly actual?: number;
  constructor(message: string, code: "no_database" | "db_error" | "unexpected_row_count", extra?: { expected?: number; actual?: number }) {
    super(message);
    this.name = "WriteQueryError";
    this.code = code;
    this.expected = extra?.expected;
    this.actual = extra?.actual;
  }
}

jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: MockWriteQueryError,
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  submitFeatureRequest,
  analyzeFeatureRequest,
  voteOnFeature,
  updateFeatureStatus,
  getFeatureRequests,
  getFeaturePipeline,
} from "@/lib/feature-requests";

describe("Feature Requests Library", () => {
  const originalDbUrl = process.env.DATABASE_URL;
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  describe("submitFeatureRequest", () => {
    it("inserts a feature request, reads it back, and tracks analytics (verified-write path)", async () => {
      process.env.DATABASE_URL = "postgres://test";
      const mockFeature = {
        id: "fr-1",
        title: "Add dark mode",
        description: "Support dark mode toggle",
        submitted_by: "user-1",
        status: "submitted",
        priority: "medium",
        target_product: null,
        analysis: {},
        comparisons: [],
        votes: 0,
        comments: [],
        estimated_hours: null,
        estimated_cost: null,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      };

      // INSERT ... RETURNING * with expectRows: 1 — a zero-rows
      // response throws, which is the silent-discard defense. The
      // end-to-end proof that the row actually committed lives in
      // tests/e2e/feature-requests-data-flow.spec.ts (real POST →
      // independent GET → assert equality against a real DB).
      mockWriteQuery.mockResolvedValueOnce({ rows: [mockFeature] });

      const result = await submitFeatureRequest("Add dark mode", "Support dark mode toggle", "user-1");

      expect(result).toEqual(mockFeature);
      expect(mockWriteQuery).toHaveBeenCalledTimes(1);
      expect(mockWriteQuery.mock.calls[0][0]).toContain("INSERT INTO instinct_feature_requests");
      expect(mockWriteQuery.mock.calls[0][2]).toEqual({ expectRows: 1 });
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "feature.request_submitted",
        "user-1",
        "unknown",
        expect.objectContaining({ feature_id: "fr-1", title: "Add dark mode" }),
      );
    });

    it("returns demo data in shadow mode (DATABASE_URL unset) without calling writeQuery", async () => {
      delete process.env.DATABASE_URL;

      const result = await submitFeatureRequest("Test feature", "Description", "user-1");

      expect(result).not.toBeNull();
      expect(result!.title).toBe("Test feature");
      expect(result!.id).toMatch(/^demo-fr-/);
      expect(result!.status).toBe("submitted");
      expect(mockWriteQuery).not.toHaveBeenCalled();
    });

    it("passes target_product and priority through to the INSERT", async () => {
      process.env.DATABASE_URL = "postgres://test";
      const mockFeature = { id: "fr-2" };
      mockWriteQuery.mockResolvedValueOnce({ rows: [mockFeature] });

      await submitFeatureRequest("Feature", "Desc", "user-1", "wolfpack-auto", "critical");

      expect(mockWriteQuery.mock.calls[0][1]).toEqual([
        "Feature", "Desc", "user-1", "wolfpack-auto", "critical",
      ]);
    });

    it("throws WriteQueryError when the INSERT returns zero rows (silent-discard defense)", async () => {
      process.env.DATABASE_URL = "postgres://test";
      // Simulate the auto-updatable view or RLS policy silently dropping
      // the INSERT — writeQuery sees zero rows and throws.
      mockWriteQuery.mockRejectedValueOnce(
        new MockWriteQueryError("row-count mismatch", "unexpected_row_count", { expected: 1, actual: 0 }),
      );

      await expect(
        submitFeatureRequest("Feature", "Desc", "user-1"),
      ).rejects.toThrow("row-count mismatch");

      // Analytics must fire for the failure so the learning loop sees
      // silent-discard events even when the caller re-throws.
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "feature.request_write_failed",
        "user-1",
        "unknown",
        expect.objectContaining({ reason: "unexpected_row_count", expected: 1, actual: 0 }),
      );
    });

    it("propagates pg errors wrapped as WriteQueryError(db_error)", async () => {
      process.env.DATABASE_URL = "postgres://test";
      // Underlying pg error (unique constraint, timeout, whatever) —
      // writeQuery wraps as db_error. The library function re-throws
      // without swallowing so the API route can surface an HTTP error
      // instead of returning a phantom-success 200.
      mockWriteQuery.mockRejectedValueOnce(
        new MockWriteQueryError("writeQuery failed: unique violation", "db_error"),
      );

      await expect(
        submitFeatureRequest("Feature", "Desc", "user-1"),
      ).rejects.toThrow("unique violation");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "feature.request_write_failed",
        "user-1",
        "unknown",
        expect.objectContaining({ reason: "db_error" }),
      );
    });
  });

  describe("analyzeFeatureRequest", () => {
    it("estimates low complexity for simple requests", async () => {
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{ id: "fr-1", title: "Fix typo", description: "Fix a typo in the readme", submitted_by: "user-1" }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false }) // similar features
        .mockResolvedValueOnce({ rows: [], fromCache: false }); // update

      const analysis = await analyzeFeatureRequest("fr-1");

      expect(analysis).not.toBeNull();
      expect(analysis!.complexity).toBe("low");
      expect(analysis!.estimated_hours_min).toBe(4);
      expect(analysis!.estimated_hours_max).toBe(8);
      expect(analysis!.estimated_cost_min).toBe(600);
      expect(analysis!.estimated_cost_max).toBe(1200);
    });

    it("estimates high complexity for database + authentication requests", async () => {
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{
            id: "fr-2",
            title: "Add OAuth SSO authentication",
            description: "Implement OAuth2 SSO with database migration for user sessions and real-time websocket notifications",
            submitted_by: "user-1",
          }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      const analysis = await analyzeFeatureRequest("fr-2");

      expect(analysis).not.toBeNull();
      expect(["high", "very_high"]).toContain(analysis!.complexity);
      expect(analysis!.keywords_matched.length).toBeGreaterThan(0);
      expect(analysis!.keywords_matched).toEqual(
        expect.arrayContaining(["authentication"]),
      );
    });

    it("estimates medium complexity for API/dashboard requests", async () => {
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{
            id: "fr-3",
            title: "Add export endpoint",
            description: "Create an API endpoint to export dashboard data to CSV with pagination support",
            submitted_by: "user-1",
          }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      const analysis = await analyzeFeatureRequest("fr-3");

      expect(analysis).not.toBeNull();
      expect(["medium", "high"]).toContain(analysis!.complexity);
    });

    it("detects risk factors", async () => {
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{
            id: "fr-4",
            title: "Security audit",
            description: "Full security review with data migration and performance testing of third-party integrations",
            submitted_by: "user-1",
          }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      const analysis = await analyzeFeatureRequest("fr-4");

      expect(analysis!.risk_factors.length).toBeGreaterThan(0);
    });

    it("returns null for non-existent request", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const analysis = await analyzeFeatureRequest("non-existent");
      expect(analysis).toBeNull();
    });

    it("tracks feature.request_analyzed event", async () => {
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{ id: "fr-5", title: "Simple", description: "Simple thing", submitted_by: "user-1" }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      await analyzeFeatureRequest("fr-5");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "feature.request_analyzed",
        "user-1",
        "unknown",
        expect.objectContaining({ feature_id: "fr-5" }),
      );
    });

    it("cost estimation uses $150/hr rate", async () => {
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{ id: "fr-6", title: "Test", description: "Quick test", submitted_by: "user-1" }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      const analysis = await analyzeFeatureRequest("fr-6");

      expect(analysis!.estimated_cost_min).toBe(analysis!.estimated_hours_min * 150);
      expect(analysis!.estimated_cost_max).toBe(analysis!.estimated_hours_max * 150);
    });
  });

  describe("voteOnFeature", () => {
    it("increments votes and returns new count", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ votes: 5 }], fromCache: false });

      const votes = await voteOnFeature("fr-1", "user-1");

      expect(votes).toBe(5);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("votes = votes + 1");
    });

    it("tracks analytics on vote", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ votes: 3 }], fromCache: false });

      await voteOnFeature("fr-1", "user-1");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        expect.any(String),
        "user-1",
        "unknown",
        expect.objectContaining({ action: "vote" }),
      );
    });
  });

  describe("updateFeatureStatus", () => {
    it("updates status and returns updated record", async () => {
      const updated = { id: "fr-1", status: "approved" };
      mockSafeQuery.mockResolvedValueOnce({ rows: [updated], fromCache: false });

      const result = await updateFeatureStatus("fr-1", "approved", "user-1");

      expect(result).toEqual(updated);
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["approved", "fr-1"]);
    });

    it("tracks feature.request_approved for approved status", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "fr-1", status: "approved" }], fromCache: false });

      await updateFeatureStatus("fr-1", "approved", "user-1");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "feature.request_approved",
        "user-1",
        "unknown",
        expect.objectContaining({ feature_id: "fr-1" }),
      );
    });

    it("tracks feature.request_rejected for rejected status", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "fr-1", status: "rejected" }], fromCache: false });

      await updateFeatureStatus("fr-1", "rejected", "user-1");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "feature.request_rejected",
        "user-1",
        "unknown",
        expect.objectContaining({ feature_id: "fr-1" }),
      );
    });

    it("returns null for non-existent request", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await updateFeatureStatus("non-existent", "approved", "user-1");
      expect(result).toBeNull();
    });
  });

  describe("getFeatureRequests", () => {
    it("returns all features without filters", async () => {
      const features = [{ id: "fr-1" }, { id: "fr-2" }];
      mockSafeQuery.mockResolvedValueOnce({ rows: features, fromCache: false });

      const result = await getFeatureRequests();

      expect(result).toEqual(features);
      expect(mockSafeQuery.mock.calls[0][0]).not.toContain("WHERE");
    });

    it("filters by status", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getFeatureRequests("approved");

      expect(mockSafeQuery.mock.calls[0][0]).toContain("WHERE");
      expect(mockSafeQuery.mock.calls[0][0]).toContain("status = $1");
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["approved"]);
    });

    it("filters by target_product", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getFeatureRequests(undefined, "wolfpack-auto");

      expect(mockSafeQuery.mock.calls[0][0]).toContain("target_product = $1");
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["wolfpack-auto"]);
    });

    it("combines both filters", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getFeatureRequests("submitted", "wolfpack-apex");

      expect(mockSafeQuery.mock.calls[0][0]).toContain("status = $1");
      expect(mockSafeQuery.mock.calls[0][0]).toContain("target_product = $2");
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["submitted", "wolfpack-apex"]);
    });
  });

  describe("getFeaturePipeline", () => {
    it("queries the v_feature_pipeline view", async () => {
      const pipeline = [
        { status: "submitted", count: 5, avg_hours: 20, avg_cost: 3000, total_votes: 12 },
        { status: "approved", count: 3, avg_hours: 40, avg_cost: 6000, total_votes: 25 },
      ];
      mockSafeQuery.mockResolvedValueOnce({ rows: pipeline, fromCache: false });

      const result = await getFeaturePipeline();

      expect(result).toEqual(pipeline);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("v_feature_pipeline");
    });
  });
});
