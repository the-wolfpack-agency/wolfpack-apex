/**
 * Drift store: capturing a baseline, and a drift check that auto-pauses a
 * critically-drifted active agent and notifies its owner. The DB and the
 * lifecycle/notify side effects are mocked.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));
const mockGetAgent = jest.fn();
const mockSetAgentState = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
  setAgentState: (...a: unknown[]) => mockSetAgentState(...a),
}));
const mockNotify = jest.fn();
jest.mock("@/lib/notifications/in-app", () => ({ notify: (...a: unknown[]) => mockNotify(...a) }));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { captureBaseline, runDriftCheck } from "@/lib/agents/drift/store";

function decisionRows(tool: string, tier: string, outcome: string, block: boolean, n: number) {
  return Array.from({ length: n }, () => ({ tool, risk_tier: tier, intended_outcome: outcome, would_block: block }));
}

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockGetAgent.mockReset();
  mockSetAgentState.mockReset();
  mockNotify.mockReset();
  mockTrackEvent.mockReset();
  mockWriteQuery.mockResolvedValue({ rows: [] });
});

describe("captureBaseline", () => {
  it("snapshots the behavior distribution and upserts it", async () => {
    mockSafeQuery.mockResolvedValue({ rows: decisionRows("read", "low", "allow", false, 20) });
    const out = await captureBaseline("agent-1", "ws-1");
    expect(out?.decisionCount).toBe(20);
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/instinct_agent_baselines/);
    expect(mockTrackEvent).toHaveBeenCalledWith("agent.baseline_captured", "agent-1", "agent", expect.any(Object));
  });
});

describe("runDriftCheck", () => {
  it("reports insufficient_data and pauses nothing when there is no baseline", async () => {
    // First safeQuery: baseline lookup (empty). Second: recent samples.
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/instinct_agent_baselines/.test(sql)) return { rows: [] };
      return { rows: decisionRows("read", "low", "allow", false, 20) };
    });
    const out = await runDriftCheck("agent-1", "ws-1");
    expect(out.verdict).toBe("insufficient_data");
    expect(out.action).toBe("none");
    expect(mockSetAgentState).not.toHaveBeenCalled();
  });

  it("auto-pauses an active agent and notifies the owner on critical drift", async () => {
    const baselineMetrics = { count: 30, blockRate: 0, tierDist: { low: 1 }, outcomeDist: { allow: 1 }, toolDist: { read: 1 } };
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/instinct_agent_baselines/.test(sql)) {
        return { rows: [{ agent_id: "agent-1", workspace_id: "ws-1", metrics: baselineMetrics, decision_count: 30, captured_at: "t" }] };
      }
      // Recent window: an entirely different tool + all blocked (drifted hard).
      return { rows: decisionRows("wipe", "critical", "deny", true, 20) };
    });
    mockGetAgent.mockResolvedValue({ id: "agent-1", state: "active", ownerUserId: "owner-1", role: "ops", workspaceId: "ws-1" });

    const out = await runDriftCheck("agent-1", "ws-1");

    expect(out.verdict).toBe("critical");
    expect(out.action).toBe("paused");
    expect(mockSetAgentState).toHaveBeenCalledWith("agent-1", "ws-1", "paused", { userId: "system", role: "system" });
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-1", category: "agent" }));
    expect(mockTrackEvent).toHaveBeenCalledWith("agent.auto_paused", "agent-1", "agent", expect.any(Object));
  });

  it("does not pause an already-paused agent even on critical drift", async () => {
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/instinct_agent_baselines/.test(sql)) {
        return { rows: [{ agent_id: "agent-1", workspace_id: "ws-1", metrics: { count: 30, blockRate: 0, tierDist: { low: 1 }, outcomeDist: { allow: 1 }, toolDist: { read: 1 } }, decision_count: 30, captured_at: "t" }] };
      }
      return { rows: decisionRows("wipe", "critical", "deny", true, 20) };
    });
    mockGetAgent.mockResolvedValue({ id: "agent-1", state: "paused", ownerUserId: "owner-1", role: "ops", workspaceId: "ws-1" });
    const out = await runDriftCheck("agent-1", "ws-1");
    expect(out.verdict).toBe("critical");
    expect(out.action).toBe("none");
    expect(mockSetAgentState).not.toHaveBeenCalled();
  });
});
