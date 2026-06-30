/**
 * Unit tests for governance drift alerting.
 *
 * Two layers:
 *   1. detectAlerts (pure): a pass-rate drop fires; a steady/improving rate does
 *      not; a new vuln fires per attack id; a new ungoverned surface fires, an old
 *      one (outside the window) does not.
 *   2. scanAndDispatch: a fresh condition dispatches via the notifications layer
 *      and emits the analytics event; a re-observed condition is deduped (the
 *      dedupe-row INSERT returns zero rows) and does NOT re-dispatch. The
 *      notifications layer + DB are mocked.
 */

const mockSafeQuery = jest.fn();
const mockFanout = jest.fn();
const mockListRuns = jest.fn();
const mockListSurfaces = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/notifications/team-fanout", () => ({
  fanoutToTeam: (...a: unknown[]) => mockFanout(...a),
}));
jest.mock("@/lib/ai-redteam/store", () => ({
  listRuns: (...a: unknown[]) => mockListRuns(...a),
}));
jest.mock("@/lib/ai-surface/store", () => ({
  listSurfaces: (...a: unknown[]) => mockListSurfaces(...a),
}));

import { detectAlerts, scanAndDispatch } from "../governance-alerts";

const NOW = new Date("2026-06-29T00:00:00Z");

describe("detectAlerts (pure)", () => {
  it("fires a pass-rate-drop alert when the latest run dropped vs the previous", () => {
    const alerts = detectAlerts({
      redteamRuns: [
        { passRate: 0.8, vulns: 2, createdAt: "2026-06-29T00:00:00Z" },
        { passRate: 1, vulns: 0, createdAt: "2026-06-28T00:00:00Z" },
      ],
      surfaces: [],
      now: NOW,
    });
    expect(alerts.map((a) => a.kind)).toContain("redteam_passrate_drop");
  });

  it("does NOT fire a drop alert when the pass rate is steady or improving", () => {
    const steady = detectAlerts({
      redteamRuns: [
        { passRate: 1, vulns: 0, createdAt: "2026-06-29T00:00:00Z" },
        { passRate: 1, vulns: 0, createdAt: "2026-06-28T00:00:00Z" },
      ],
      surfaces: [],
      now: NOW,
    });
    expect(steady.find((a) => a.kind === "redteam_passrate_drop")).toBeUndefined();

    const improving = detectAlerts({
      redteamRuns: [
        { passRate: 1, vulns: 0, createdAt: "2026-06-29T00:00:00Z" },
        { passRate: 0.9, vulns: 1, createdAt: "2026-06-28T00:00:00Z" },
      ],
      surfaces: [],
      now: NOW,
    });
    expect(improving.find((a) => a.kind === "redteam_passrate_drop")).toBeUndefined();
  });

  it("fires one new-vuln alert per attack id on the latest run", () => {
    const alerts = detectAlerts({
      redteamRuns: [
        {
          passRate: 0.75,
          vulns: 2,
          createdAt: "2026-06-29T00:00:00Z",
          vulnAttackIds: ["atk-1", "atk-2"],
        },
      ],
      surfaces: [],
      now: NOW,
    });
    const vulnAlerts = alerts.filter((a) => a.kind === "redteam_new_vuln");
    expect(vulnAlerts).toHaveLength(2);
    // Distinct fingerprints per attack id.
    expect(new Set(vulnAlerts.map((a) => a.fingerprint)).size).toBe(2);
  });

  it("fires a new-ungoverned-surface alert for a recent surface, not an old one", () => {
    const alerts = detectAlerts({
      redteamRuns: [],
      surfaces: [
        {
          id: "ais_new",
          governed: false,
          provider: "openai",
          kind: "api_key",
          location: "src/x.ts:1",
          firstSeenAt: "2026-06-28T00:00:00Z", // within 7d window
        },
        {
          id: "ais_old",
          governed: false,
          provider: "openai",
          kind: "ai_sdk",
          location: "src/y.ts:1",
          firstSeenAt: "2026-01-01T00:00:00Z", // outside window
        },
        {
          id: "ais_governed",
          governed: true,
          provider: "openai",
          kind: "ai_sdk",
          location: "src/z.ts:1",
          firstSeenAt: "2026-06-28T00:00:00Z",
        },
      ],
      now: NOW,
      newSurfaceWindowDays: 7,
    });
    const surfaceAlerts = alerts.filter((a) => a.kind === "new_ungoverned_surface");
    expect(surfaceAlerts).toHaveLength(1);
    expect(surfaceAlerts[0].metadata.surface_id).toBe("ais_new");
    // An api_key surface is critical severity.
    expect(surfaceAlerts[0].severity).toBe("critical");
  });
});

describe("scanAndDispatch", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Default: the dedupe INSERT returns one row (a fresh claim).
    mockSafeQuery.mockResolvedValue({ rows: [{ id: "galert_x" }], fromCache: false });
    mockFanout.mockResolvedValue({ recipientCount: 3, skipped: 0 });
  });

  it("dispatches a fresh alert through the notifications layer with the analytics event", async () => {
    const result = await scanAndDispatch({
      workspaceId: "default",
      actorId: "cron",
      actorRole: "system",
      now: NOW,
      redteamRuns: [
        { passRate: 0.8, vulns: 1, createdAt: "2026-06-29T00:00:00Z" },
        { passRate: 1, vulns: 0, createdAt: "2026-06-28T00:00:00Z" },
      ],
      surfaces: [],
    });

    expect(result.dispatched).toBe(1);
    expect(result.deduped).toBe(0);
    expect(mockFanout).toHaveBeenCalledTimes(1);
    expect(mockFanout).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "security",
        source: "governance-alerts",
        analyticsEvent: "ogiam.drift_alert_dispatched",
        analyticsPayload: expect.objectContaining({ alert_kind: "redteam_passrate_drop" }),
      }),
    );
  });

  it("dedupes: a re-observed condition (zero-row claim) does NOT re-dispatch", async () => {
    // The dedupe INSERT ON CONFLICT DO NOTHING returns zero rows → already seen.
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    const result = await scanAndDispatch({
      workspaceId: "default",
      actorId: "cron",
      actorRole: "system",
      now: NOW,
      redteamRuns: [
        { passRate: 0.8, vulns: 1, createdAt: "2026-06-29T00:00:00Z" },
        { passRate: 1, vulns: 0, createdAt: "2026-06-28T00:00:00Z" },
      ],
      surfaces: [],
    });

    expect(result.detected).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.deduped).toBe(1);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it("no regression → nothing dispatched", async () => {
    const result = await scanAndDispatch({
      workspaceId: "default",
      actorId: "cron",
      actorRole: "system",
      now: NOW,
      redteamRuns: [
        { passRate: 1, vulns: 0, createdAt: "2026-06-29T00:00:00Z" },
        { passRate: 1, vulns: 0, createdAt: "2026-06-28T00:00:00Z" },
      ],
      surfaces: [],
    });
    expect(result.detected).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });
});
