/**
 * spend-anomaly - the deterministic spike rule, a backtest against the real
 * production series, and the once-per-bucket-per-day alert contract.
 */
const mockQuery = jest.fn();
const mockTrackEventAwait = jest.fn();
const mockFanoutToTeam = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: (...a: unknown[]) => mockTrackEventAwait(...a) }));
jest.mock("@/lib/notifications/team-fanout", () => ({ fanoutToTeam: (...a: unknown[]) => mockFanoutToTeam(...a) }));

import {
  evaluateSpendWindow,
  detectSpendAnomalies,
  runSpendAnomalyScan,
  liveSpendAnomalyDeps,
  anomalyDayKey,
  describeAnomaly,
  type SpendAnomalyDeps,
  type SpendWindow,
} from "@/lib/ai/spend-anomaly";
import { UNATTRIBUTED_BUCKET } from "@/lib/ai/spend-guard";

const w = (over: Partial<SpendWindow>): SpendWindow => ({
  bucket: "ws_a",
  last24hUsd: 0,
  last24hCalls: 10,
  trailingUsd: 7,
  trailingCalls: 70,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("evaluateSpendWindow", () => {
  it("alerts when last-24h is over 3x the trailing mean AND over $5", () => {
    // mean = 7 / 7 = $1; 3x = $3; $6 clears both
    const a = evaluateSpendWindow(w({ last24hUsd: 6 }));
    expect(a).toMatchObject({ reason: "spike", meanDailyUsd: 1, multiple: 6 });
  });

  it("does NOT alert under the $5 floor, however large the multiple", () => {
    expect(evaluateSpendWindow(w({ trailingUsd: 0.7, last24hUsd: 4.99 }))).toBeNull();
  });

  it("does NOT alert at exactly 3x the mean", () => {
    // mean = 70 / 7 = $10; 3x = $30
    expect(evaluateSpendWindow(w({ trailingUsd: 70, last24hUsd: 30 }))).toBeNull();
    expect(evaluateSpendWindow(w({ trailingUsd: 70, last24hUsd: 30.01 }))).not.toBeNull();
  });

  it("history with $0 spend still counts as history: the $5 floor applies, not the $25 one", () => {
    const a = evaluateSpendWindow(w({ trailingUsd: 0, trailingCalls: 40, last24hUsd: 6 }));
    expect(a).toMatchObject({ reason: "spike", multiple: null });
  });

  it("NO history: alerts only over $25", () => {
    expect(evaluateSpendWindow(w({ trailingUsd: 0, trailingCalls: 0, last24hUsd: 25 }))).toBeNull();
    expect(evaluateSpendWindow(w({ trailingUsd: 0, trailingCalls: 0, last24hUsd: 25.01 }))).toMatchObject({
      reason: "new_spend",
      meanDailyUsd: 0,
      multiple: null,
    });
  });

  it("treats non-finite or negative figures as 0 rather than alerting on garbage", () => {
    expect(evaluateSpendWindow(w({ last24hUsd: Number.NaN }))).toBeNull();
    expect(evaluateSpendWindow(w({ last24hUsd: -100 }))).toBeNull();
  });

  it("applies to the unattributed bucket exactly like a workspace", () => {
    expect(evaluateSpendWindow(w({ bucket: UNATTRIBUTED_BUCKET, last24hUsd: 6 }))?.bucket).toBe(UNATTRIBUTED_BUCKET);
  });
});

describe("backtest: the production daily series, 2026-10-01 to 2026-10-24 (measured 2026-10-24)", () => {
  /* Real figures, all unattributed. The ten days at ~$24 are the ai-code-ci-fix
     dogfooding run. The rule should fire as it starts and then fall quiet once
     that rate has become the mean. */
  const series: Array<[string, number]> = [
    ["2026-10-01", 0.88], ["2026-10-02", 3.83], ["2026-10-03", 1.58], ["2026-10-04", 7.65],
    ["2026-10-05", 3.49], ["2026-10-06", 0.42], ["2026-10-07", 0.29], ["2026-10-08", 13.89],
    ["2026-10-09", 23.86], ["2026-10-10", 23.98], ["2026-10-11", 24.0], ["2026-10-12", 23.81],
    ["2026-10-13", 23.89], ["2026-10-14", 23.58], ["2026-10-15", 23.71], ["2026-10-16", 23.73],
    ["2026-10-17", 23.84], ["2026-10-18", 15.84], ["2026-10-19", 0.36], ["2026-10-20", 0.27],
    ["2026-10-21", 0.26], ["2026-10-22", 0.28], ["2026-10-23", 0.29],
  ];

  it("fires on 2026-10-08, 09 and 10, and on no other day", () => {
    const fired: string[] = [];
    for (let i = 7; i < series.length; i++) {
      const trailing = series.slice(i - 7, i).reduce((s, [, v]) => s + v, 0);
      const a = evaluateSpendWindow({
        bucket: UNATTRIBUTED_BUCKET,
        last24hUsd: series[i][1],
        last24hCalls: 100,
        trailingUsd: trailing,
        trailingCalls: 100,
      });
      if (a) fired.push(series[i][0]);
    }
    expect(fired).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
  });
});

describe("detectSpendAnomalies / describeAnomaly", () => {
  it("returns only the anomalous buckets", () => {
    const out = detectSpendAnomalies([w({ bucket: "quiet", last24hUsd: 1 }), w({ bucket: "loud", last24hUsd: 50 })]);
    expect(out.map((a) => a.bucket)).toEqual(["loud"]);
  });

  it("says which bucket, how much, and what to check", () => {
    const [a] = detectSpendAnomalies([w({ bucket: UNATTRIBUTED_BUCKET, last24hUsd: 50 })]);
    const { title, body } = describeAnomaly(a);
    expect(title).toContain("$50.00");
    expect(title).toContain("calls with no workspace");
    expect(body).toContain("trailing 7-day daily mean of $1.00");
    expect(body).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
  });

  it("dayKey is the UTC date", () => {
    expect(anomalyDayKey(new Date("2026-10-24T03:30:00Z"))).toBe("2026-10-24");
  });
});

describe("runSpendAnomalyScan", () => {
  function deps(windows: SpendWindow[], alerted: string[] = []): SpendAnomalyDeps & {
    record: jest.Mock;
    fanout: jest.Mock;
    listAlerted: jest.Mock;
  } {
    return {
      listWindows: jest.fn().mockResolvedValue(windows),
      listAlerted: jest.fn().mockResolvedValue(new Set(alerted)),
      record: jest.fn().mockResolvedValue(undefined),
      fanout: jest.fn().mockResolvedValue(undefined),
    };
  }
  const NOW = new Date("2026-10-24T10:15:00Z");

  it("records then alerts each new anomaly through the team fanout, scoped to the spend owner", async () => {
    const d = deps([w({ bucket: "ws_a", last24hUsd: 50 }), w({ bucket: "ws_b", last24hUsd: 1 })]);
    const r = await runSpendAnomalyScan(d, NOW);
    expect(r).toEqual({ day: "2026-10-24", scanned: 2, detected: 1, dispatched: 1, alreadyAlerted: 0 });
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ bucket: "ws_a" }), "2026-10-24");
    const input = d.fanout.mock.calls[0][0];
    expect(input).toMatchObject({
      category: "security",
      source: "ai-spend-anomaly",
      sourceId: "ws_a:2026-10-24",
      analyticsEvent: "ai.spend_anomaly_alert_dispatched",
      recipientEmails: ["homyk@thewolfpack.agency"],
    });
    /* Ledger first, bell second: a failed fanout cannot cause a re-alert. */
    expect(d.record.mock.invocationCallOrder[0]).toBeLessThan(d.fanout.mock.invocationCallOrder[0]);
  });

  it("is IDEMPOTENT per day: a bucket already alerted today is skipped", async () => {
    const d = deps([w({ bucket: "ws_a", last24hUsd: 50 }), w({ bucket: "ws_c", last24hUsd: 60 })], ["ws_a"]);
    const r = await runSpendAnomalyScan(d, NOW);
    expect(r).toMatchObject({ detected: 2, dispatched: 1, alreadyAlerted: 1 });
    expect(d.listAlerted).toHaveBeenCalledWith("2026-10-24");
    expect(d.record).toHaveBeenCalledTimes(1);
    expect(d.record.mock.calls[0][0].bucket).toBe("ws_c");
  });

  it("does not read the ledger at all when nothing is anomalous", async () => {
    const d = deps([w({ last24hUsd: 1 })]);
    const r = await runSpendAnomalyScan(d, NOW);
    expect(r).toMatchObject({ detected: 0, dispatched: 0 });
    expect(d.listAlerted).not.toHaveBeenCalled();
    expect(d.fanout).not.toHaveBeenCalled();
  });

  it("a failed fanout does not throw (the record is already written)", async () => {
    const d = deps([w({ last24hUsd: 50 })]);
    d.fanout.mockRejectedValueOnce(new Error("notify down"));
    await expect(runSpendAnomalyScan(d, NOW)).resolves.toMatchObject({ dispatched: 1 });
  });

  it("a failed read THROWS to the caller rather than reporting a clean scan", async () => {
    const d = deps([]);
    (d.listWindows as jest.Mock).mockRejectedValueOnce(new Error("db down"));
    await expect(runSpendAnomalyScan(d, NOW)).rejects.toThrow("db down");
  });
});

describe("liveSpendAnomalyDeps", () => {
  it("reads eight days of ai.completion grouped by bucket, with the unattributed sentinel as a parameter", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ bucket: UNATTRIBUTED_BUCKET, last24h_usd: "6.5", last24h_calls: "12", trailing_usd: "7", trailing_calls: "70" }],
    });
    const rows = await liveSpendAnomalyDeps().listWindows();
    expect(rows).toEqual([
      { bucket: UNATTRIBUTED_BUCKET, last24hUsd: 6.5, last24hCalls: 12, trailingUsd: 7, trailingCalls: 70 },
    ]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("event_type = 'ai.completion'");
    expect(sql).toContain("interval '8 days'");
    expect(params).toEqual([UNATTRIBUTED_BUCKET]);
  });

  it("the ledger is ai.spend_anomaly_detected rows for the day key", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ bucket: "ws_a" }] });
    const set = await liveSpendAnomalyDeps().listAlerted("2026-10-24");
    expect([...set]).toEqual(["ws_a"]);
    expect(mockQuery.mock.calls[0][0]).toContain("event_type = 'ai.spend_anomaly_detected'");
    expect(mockQuery.mock.calls[0][1]).toEqual(["2026-10-24"]);
  });

  it("records the anomaly with trackEventAwait (awaited, so the ledger lands before the bell)", async () => {
    const [a] = detectSpendAnomalies([w({ last24hUsd: 50 })]);
    await liveSpendAnomalyDeps().record(a, "2026-10-24");
    expect(mockTrackEventAwait).toHaveBeenCalledWith(
      "ai.spend_anomaly_detected",
      "system",
      "system",
      expect.objectContaining({ bucket: "ws_a", day: "2026-10-24", reason: "spike", last_24h_usd: 50, multiple: 50 }),
    );
  });
});
