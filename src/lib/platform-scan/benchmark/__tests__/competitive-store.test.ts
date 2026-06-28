/**
 * competitive-store round-trip (db mocked).
 *
 * recordCompetitorRun writes one row per (tool, target) with recall/precision/
 * findings broken out and the full CompetitiveReport as JSONB; listRecentCompetitorRuns
 * reads recent rows back shaped for the dashboard. Both degrade gracefully
 * (writeQuery throw -> {id:null} and never re-throws; safeQuery -> [] with no DB) so
 * a store hiccup never loses the scored run nor 500s the dashboard. Mirrors
 * benchmark-store.test.ts.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  recordCompetitorRun,
  listRecentCompetitorRuns,
} from "@/lib/platform-scan/benchmark/competitive-store";
import type { CompetitiveReport } from "@/lib/platform-scan/benchmark/competitive";

const REPORT: CompetitiveReport = {
  target: "vampi",
  ours: { recall: 0.4, precision: 0.9, matched: ["security:SQL injection"] },
  tools: [
    { tool: "nuclei", label: "Nuclei", recall: 0.2, precision: 1, matched: [], findings: 3 },
  ],
  rivalOnlyGaps: [
    { findingClass: "security:Broken object level authorization (IDOR)", tools: ["nuclei"] },
  ],
  parity: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteQuery.mockResolvedValue({ rows: [] });
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("recordCompetitorRun", () => {
  test("inserts one row with metrics broken out + report as JSON, returns a comp_ id", async () => {
    const { id } = await recordCompetitorRun({
      tool: "nuclei",
      target: "vampi",
      recall: 0.2,
      precision: 1,
      findings: 3,
      report: REPORT,
    });
    expect(id).toMatch(/^comp_/);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_competitor_benchmark_runs/i);
    expect(params[0]).toBe(id);
    expect(params[1]).toBe("nuclei"); // tool
    expect(params[2]).toBe("vampi"); // target
    expect(params[3]).toBe(0.2); // recall
    expect(params[4]).toBe(1); // precision
    expect(params[5]).toBe(3); // findings
    expect(JSON.parse(params[6] as string)).toMatchObject({ target: "vampi", parity: false });
  });

  test("degrades to {id:null} when writeQuery throws (never re-throws)", async () => {
    mockWriteQuery.mockRejectedValue(new Error("db down"));
    const { id } = await recordCompetitorRun({
      tool: "zap",
      target: "vampi",
      recall: 0,
      precision: 1,
      findings: 0,
      report: REPORT,
    });
    expect(id).toBeNull();
  });
});

describe("listRecentCompetitorRuns", () => {
  test("reads rows back shaped for the dashboard (newest-first), default + cap clamps", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "comp_1",
          run_at: "2026-06-28T00:00:00.000Z",
          tool: "nuclei",
          target: "vampi",
          recall: 0.2,
          precision: 1,
          findings: 3,
          report: REPORT,
        },
      ],
      fromCache: false,
    });
    const rows = await listRecentCompetitorRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "comp_1",
      tool: "nuclei",
      target: "vampi",
      recall: 0.2,
      precision: 1,
      findings: 3,
    });
    expect(rows[0].report.target).toBe("vampi");
    // default limit 50; clamps a huge request to 200 and a 0 to 1.
    expect(mockSafeQuery.mock.calls[0][1]).toEqual([50]);
    await listRecentCompetitorRuns(99999);
    expect(mockSafeQuery.mock.calls[1][1]).toEqual([200]);
    await listRecentCompetitorRuns(0);
    expect(mockSafeQuery.mock.calls[2][1]).toEqual([1]);
  });

  test("degrades to [] with no DB", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    expect(await listRecentCompetitorRuns()).toEqual([]);
  });
});
