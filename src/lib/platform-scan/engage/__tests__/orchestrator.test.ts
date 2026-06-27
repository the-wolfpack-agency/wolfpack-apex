/**
 * Continuous Engagement Orchestrator test. Every module the orchestrator
 * composes is mocked, so this asserts the composition contract (which steps
 * run, in what order of dependency, and the returned shape) without a DB, a
 * GitHub fetch, or the Brain. Pins:
 *   - runEngagement happy path runs scan -> profile -> recommend and tracks.
 *   - a manifest with no static target skips before any scan.
 *   - the repo tree is discovered ONCE and reused for the profile.
 *   - runDueEngagements is sweep-isolated: one platform's throw does not abort.
 */
const mockResolveScanTarget = jest.fn();
const mockDiscoverRepoFiles = jest.fn();
const mockScanSource = jest.fn();
const mockDefaultReadFile = jest.fn();
const mockRecordScan = jest.fn();
const mockSummarizeFindings = jest.fn();
const mockListFindings = jest.fn();
const mockListScans = jest.fn();
const mockBuildSystemProfile = jest.fn();
const mockSaveSystemProfile = jest.fn();
const mockListSystemProfiles = jest.fn();
const mockIngestSystemProfile = jest.fn();
const mockRecommendAutomations = jest.fn();
const mockSaveRecommendations = jest.fn();
const mockIngestRecommendation = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/platform-scan/manifests", () => ({
  resolveScanTarget: (...a: unknown[]) => mockResolveScanTarget(...a),
}));
jest.mock("@/lib/platform-scan/static/discover-files", () => ({
  discoverRepoFiles: (...a: unknown[]) => mockDiscoverRepoFiles(...a),
}));
jest.mock("@/lib/platform-scan/static/scan", () => ({
  scanSource: (...a: unknown[]) => mockScanSource(...a),
  defaultReadFile: (...a: unknown[]) => mockDefaultReadFile(...a),
}));
jest.mock("@/lib/platform-scan/store", () => ({
  recordScan: (...a: unknown[]) => mockRecordScan(...a),
  summarizeFindings: (...a: unknown[]) => mockSummarizeFindings(...a),
  listFindings: (...a: unknown[]) => mockListFindings(...a),
  listScans: (...a: unknown[]) => mockListScans(...a),
}));
jest.mock("@/lib/platform-scan/profile/build", () => ({
  buildSystemProfile: (...a: unknown[]) => mockBuildSystemProfile(...a),
}));
jest.mock("@/lib/platform-scan/profile/store", () => ({
  saveSystemProfile: (...a: unknown[]) => mockSaveSystemProfile(...a),
  listSystemProfiles: (...a: unknown[]) => mockListSystemProfiles(...a),
}));
jest.mock("@/lib/platform-scan/profile/brain-ingest", () => ({
  ingestSystemProfile: (...a: unknown[]) => mockIngestSystemProfile(...a),
}));
jest.mock("@/lib/platform-scan/recommend/engine", () => ({
  recommendAutomations: (...a: unknown[]) => mockRecommendAutomations(...a),
}));
jest.mock("@/lib/platform-scan/recommend/store", () => ({
  saveRecommendations: (...a: unknown[]) => mockSaveRecommendations(...a),
}));
jest.mock("@/lib/platform-scan/recommend/brain-ingest", () => ({
  ingestRecommendation: (...a: unknown[]) => mockIngestRecommendation(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { runEngagement, runDueEngagements } from "@/lib/platform-scan/engage/orchestrator";
import type { SystemProfile } from "@/lib/platform-scan/profile/types";

const PROFILE: SystemProfile = {
  platform: "wolfpack-auto",
  surface: { pages: 1, apiRoutes: 1, components: 0, libModules: 0, migrations: 1, tests: 0, totalFiles: 3 },
  entities: ["leads"],
  integrations: [],
  authModel: { publicRoutes: 0, protectedRoutes: 1 },
  riskSummary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
  generatedAt: "2026-06-27T00:00:00.000Z",
};

const REC = {
  key: "k",
  category: "operational",
  priority: "medium",
  title: "t",
  rationale: "",
  suggestedAction: "",
  source: "",
  evidence: {},
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveScanTarget.mockResolvedValue({
    static: { owner: "o", repo: "r", ref: "main", paths: ["db/migrations/001.sql"] },
    routes: [{ auth: "required" }],
  });
  mockDiscoverRepoFiles.mockResolvedValue(["app/page.tsx", "db/migrations/001.sql"]);
  mockDefaultReadFile.mockReturnValue(async () => null);
  mockScanSource.mockResolvedValue({ platform: "wolfpack-auto", findings: [], scannedRoutes: [] });
  mockRecordScan.mockResolvedValue({ scanId: "s1", findingCount: 3, criticalCount: 1, autoResolvedCount: 2 });
  mockBuildSystemProfile.mockResolvedValue(PROFILE);
  mockSaveSystemProfile.mockResolvedValue(undefined);
  mockIngestSystemProfile.mockResolvedValue(undefined);
  mockListScans.mockResolvedValue([
    { platform: "wolfpack-auto", routeCount: 0, findingCount: 0, criticalCount: 0, createdAt: "t" },
  ]);
  mockListFindings.mockResolvedValue([]);
  mockRecommendAutomations.mockReturnValue([REC]);
  mockSaveRecommendations.mockResolvedValue(undefined);
  mockIngestRecommendation.mockResolvedValue(undefined);
  mockSummarizeFindings.mockResolvedValue({
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    total: 0,
  });
});

it("runEngagement runs scan -> profile -> recommend and returns the assessed shape", async () => {
  const res = await runEngagement("default", "wolfpack-auto");

  expect(mockScanSource).toHaveBeenCalledTimes(1);
  expect(mockRecordScan).toHaveBeenCalledTimes(1);
  expect(mockSaveSystemProfile).toHaveBeenCalledWith("default", PROFILE);
  expect(mockIngestSystemProfile).toHaveBeenCalledWith(PROFILE);
  expect(mockSaveRecommendations).toHaveBeenCalledWith("default", "wolfpack-auto", [REC]);
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.engagement_run",
    "engagement",
    "system",
    expect.objectContaining({
      platform: "wolfpack-auto",
      findings: 3,
      criticals: 1,
      auto_resolved: 2,
      recommendations: 1,
    }),
  );

  expect(res).toEqual({
    platform: "wolfpack-auto",
    profiled: true,
    findingCount: 3,
    criticalCount: 1,
    autoResolvedCount: 2,
    recommendationCount: 1,
  });
});

it("skips with no_static_target when the manifest has no static source, never scanning", async () => {
  mockResolveScanTarget.mockResolvedValue({ routes: [], baseUrl: "x" });

  const res = await runEngagement("default", "wolfpack-auto");

  expect(res).toMatchObject({ skipped: "no_static_target", profiled: false });
  expect(mockScanSource).not.toHaveBeenCalled();
  expect(mockRecordScan).not.toHaveBeenCalled();
});

it("discovers the repo tree exactly once and reuses it for the profile", async () => {
  await runEngagement("default", "wolfpack-auto");

  expect(mockDiscoverRepoFiles).toHaveBeenCalledTimes(1);

  // The profile builder gets a discoverFiles dep that resolves to the
  // already-discovered + seeded paths (no second GitHub tree fetch).
  const deps = mockBuildSystemProfile.mock.calls[0][1];
  await expect(deps.discoverFiles()).resolves.toEqual(
    expect.arrayContaining(["app/page.tsx", "db/migrations/001.sql"]),
  );
  expect(mockDiscoverRepoFiles).toHaveBeenCalledTimes(1);
});

it("runDueEngagements returns one result per profile and is isolated against a failing platform", async () => {
  mockListSystemProfiles.mockResolvedValue([
    { platform: "a", profile: PROFILE, entityCount: 0, integrationCount: 0, routeCount: 0, criticalCount: 0, generatedAt: "t" },
    { platform: "b", profile: PROFILE, entityCount: 0, integrationCount: 0, routeCount: 0, criticalCount: 0, generatedAt: "t" },
  ]);
  // First platform's engagement throws (resolveScanTarget rejects once); the
  // second still runs.
  mockResolveScanTarget
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValue({
      static: { owner: "o", repo: "r", ref: "main", paths: ["db/migrations/001.sql"] },
      routes: [{ auth: "required" }],
    });

  const results = await runDueEngagements("default");

  expect(results).toHaveLength(2);
  expect(results[0].platform).toBe("a");
  expect(results[0].skipped).toMatch(/^error:/);
  expect(results[0].profiled).toBe(false);
  // The second platform still completed normally.
  expect(results[1].platform).toBe("b");
  expect(results[1].profiled).toBe(true);
});
