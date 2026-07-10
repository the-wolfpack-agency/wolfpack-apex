/**
 * Model-eval store: an eval that persists a regression, audits it, and notifies
 * the owner (no auto-pause); a stable eval that persists nothing; and the
 * fleet-standings read that filters out under-sampled agents. DB and all side
 * effects are mocked.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));
const mockGetAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
}));
const mockNotify = jest.fn();
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...a: unknown[]) => mockNotify(...a),
}));
const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  runModelEvalCheck,
  getFleetModelStandings,
  listModelRegressionsSince,
} from "@/lib/agents/evals/store";

/** Per-model outcome rows as fetchModelOutcomes' query returns them (recent first). */
function outcomeRows(
  rows: Array<{ model: string; total: number; succeeded: number }>,
) {
  return rows.map((r, i) => ({
    agent_id: "agt-1",
    model: r.model,
    total: r.total,
    succeeded: r.succeeded,
    last_seen: `2026-07-0${i + 1}T00:00:00Z`,
  }));
}

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockGetAgent.mockReset();
  mockNotify.mockReset();
  mockRecordAudit.mockReset();
  mockTrackEvent.mockReset();
  mockWriteQuery.mockResolvedValue({ rows: [] });
  mockRecordAudit.mockResolvedValue({ ok: true });
  mockNotify.mockResolvedValue({ id: "n1" });
  mockGetAgent.mockResolvedValue({
    id: "agt-1",
    name: "Scout",
    ownerUserId: "user-1",
    role: "member",
    state: "active",
  });
});

describe("runModelEvalCheck", () => {
  it("persists, audits, notifies (no pause) on a regression", async () => {
    // newest model 'new' 0.50 vs prior 'old' 0.90 -> -0.40 regression.
    mockSafeQuery.mockResolvedValueOnce({
      rows: outcomeRows([
        { model: "new", total: 20, succeeded: 10 },
        { model: "old", total: 20, succeeded: 18 },
      ]),
    });

    const out = await runModelEvalCheck("agt-1", "ws-1");

    expect(out.verdict).toBe("regressed");
    expect(out.persisted).toBe(true);

    // ledger write
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(
      /instinct_agent_model_regressions/,
    );

    // both analytics events
    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain("agent.model_evaluated");
    expect(events).toContain("agent.model_regression_detected");

    // hash-chained audit
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][0].action).toBe(
      "agent.model_regression_detected",
    );

    // owner notified, high priority, correct deep link
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const n = mockNotify.mock.calls[0][0];
    expect(n.userId).toBe("user-1");
    expect(n.priority).toBe("high");
    expect(n.actionUrl).toBe("/admin/agents/agt-1");
  });

  it("records only the eval event and persists nothing when stable", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: outcomeRows([
        { model: "new", total: 20, succeeded: 17 }, // 0.85
        { model: "old", total: 20, succeeded: 18 }, // 0.90
      ]),
    });

    const out = await runModelEvalCheck("agt-1", "ws-1");

    expect(out.verdict).toBe("stable");
    expect(out.persisted).toBe(false);
    expect(mockWriteQuery).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toEqual(["agent.model_evaluated"]);
  });

  it("returns insufficient_data (no writes) with a single model", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: outcomeRows([{ model: "only", total: 30, succeeded: 20 }]),
    });
    const out = await runModelEvalCheck("agt-1", "ws-1");
    expect(out.verdict).toBe("insufficient_data");
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});

describe("getFleetModelStandings", () => {
  it("evaluates each active agent and drops under-sampled ones", async () => {
    // 1st query: workspace-wide per-(agent,model) outcomes.
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          // agt-A: regressed (newest 'z' 0.5 vs 'y' 0.9)
          { agent_id: "agt-A", model: "z", total: 20, succeeded: 10, last_seen: "2026-07-05" },
          { agent_id: "agt-A", model: "y", total: 20, succeeded: 18, last_seen: "2026-07-01" },
          // agt-B: only one model -> insufficient, dropped
          { agent_id: "agt-B", model: "z", total: 30, succeeded: 25, last_seen: "2026-07-05" },
        ],
      })
      // 2nd query: names for active agents.
      .mockResolvedValueOnce({
        rows: [
          { id: "agt-A", name: "Alpha" },
          { id: "agt-B", name: "Bravo" },
        ],
      });

    const standings = await getFleetModelStandings("ws-1");

    expect(standings).toHaveLength(1);
    expect(standings[0].agentId).toBe("agt-A");
    expect(standings[0].agentName).toBe("Alpha");
    expect(standings[0].verdict).toBe("regressed");
    expect(standings[0].delta).toBeCloseTo(-0.4, 5);
  });

  it("returns [] when no agent has any model-stamped runs", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const standings = await getFleetModelStandings("ws-1");
    expect(standings).toEqual([]);
  });
});

describe("listModelRegressionsSince", () => {
  beforeEach(() => mockSafeQuery.mockReset());

  it("scopes by workspace + since instant and maps rows", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "r1", agent_id: "agt-x", baseline_model: "old", candidate_model: "new",
          baseline_success_rate: 0.9, candidate_success_rate: 0.5, delta: -0.4,
          baseline_samples: 20, candidate_samples: 20, verdict: "regressed",
          created_at: "2026-07-10T01:00:00Z",
        },
      ],
    });
    const out = await listModelRegressionsSince("ws-1", "2026-07-10T00:00:00Z");
    expect(out).toHaveLength(1);
    expect(out[0].candidateModel).toBe("new");
    expect(out[0].delta).toBe(-0.4);
    // query is scoped by workspace + since + regressed-only.
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/verdict = 'regressed'/);
    expect(sql).toMatch(/created_at >= \$2/);
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("2026-07-10T00:00:00Z");
  });
});
