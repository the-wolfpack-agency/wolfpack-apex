/**
 * spend-guard - the spend reader behind the budget governor, and the throttle
 * that keeps its traces findable without flooding analytics.
 *
 * The property that matters most: a failed read THROWS. monthSpendUsd returns
 * 0 on failure, which made "could not read" and "spent nothing" the same
 * number and the router's degraded-open trace unreachable.
 */
import {
  UNATTRIBUTED_BUCKET,
  createSpendReader,
  createTraceThrottle,
  isUnattributed,
  readMonthSpendUsd,
  spendBucketFor,
  type SpendQueryFn,
} from "@/lib/ai/spend-guard";

describe("isUnattributed / spendBucketFor", () => {
  it("treats missing, empty and whitespace ids as unattributed", () => {
    for (const id of [undefined, null, "", "   "]) {
      expect(isUnattributed(id)).toBe(true);
      expect(spendBucketFor(id)).toBe(UNATTRIBUTED_BUCKET);
    }
  });

  it("'default' is a REAL workspace in a single-tenant deployment, never unattributed", () => {
    expect(isUnattributed("default")).toBe(false);
    expect(spendBucketFor("default")).toBe("default");
  });

  it("trims a real id", () => {
    expect(spendBucketFor("  ws_a ")).toBe("ws_a");
  });
});

describe("readMonthSpendUsd", () => {
  it("reads a workspace bucket by exact workspace_id from instinct_events", async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ month_spend_usd: "12.5" }] });
    await expect(readMonthSpendUsd("ws_a", q as SpendQueryFn)).resolves.toBe(12.5);
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("FROM instinct_events");
    expect(sql).toContain("event_type = 'ai.completion'");
    expect(sql).toContain("metadata->>'workspace_id' = $1");
    expect(sql).toContain("date_trunc('month', now())");
    expect(params).toEqual(["ws_a"]);
  });

  it("reads the unattributed bucket as the rows with no workspace_id, with no parameters", async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ month_spend_usd: 3 }] });
    await expect(readMonthSpendUsd(UNATTRIBUTED_BUCKET, q as SpendQueryFn)).resolves.toBe(3);
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("COALESCE(btrim(metadata->>'workspace_id'), '') = ''");
    expect(sql).not.toContain("$1");
    expect(params).toEqual([]);
  });

  it("THROWS when the query does (the whole point)", async () => {
    const q = jest.fn().mockRejectedValue(new Error("db down"));
    await expect(readMonthSpendUsd("ws_a", q as SpendQueryFn)).rejects.toThrow("db down");
  });

  it("throws on a non-numeric figure rather than reading it as 0", async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ month_spend_usd: "NaN-ish" }] });
    await expect(readMonthSpendUsd("ws_a", q as SpendQueryFn)).rejects.toThrow(/non-numeric/);
  });

  it("an empty result or negative sum is 0", async () => {
    await expect(readMonthSpendUsd("ws_a", jest.fn().mockResolvedValue({ rows: [] }) as SpendQueryFn)).resolves.toBe(0);
    await expect(
      readMonthSpendUsd("ws_a", jest.fn().mockResolvedValue({ rows: [{ month_spend_usd: -4 }] }) as SpendQueryFn),
    ).resolves.toBe(0);
  });
});

describe("createSpendReader", () => {
  it("no database is 0, not a failure", async () => {
    const reader = createSpendReader({ resolveQuery: async () => null });
    await expect(reader.read("ws_a")).resolves.toBe(0);
  });

  it("caches per bucket for the TTL, then reads again", async () => {
    let t = 0;
    const q = jest.fn().mockResolvedValue({ rows: [{ month_spend_usd: 7 }] });
    const reader = createSpendReader({ resolveQuery: async () => q as SpendQueryFn, ttlMs: 30_000, now: () => t });
    await reader.read("ws_a");
    await reader.read("ws_a");
    await reader.read(UNATTRIBUTED_BUCKET);
    expect(q).toHaveBeenCalledTimes(2);
    t = 30_000;
    await reader.read("ws_a");
    expect(q).toHaveBeenCalledTimes(3);
  });

  it("does NOT cache a failure: the next call retries", async () => {
    const q = jest
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ rows: [{ month_spend_usd: 9 }] });
    const reader = createSpendReader({ resolveQuery: async () => q as SpendQueryFn, now: () => 0 });
    await expect(reader.read("ws_a")).rejects.toThrow("blip");
    await expect(reader.read("ws_a")).resolves.toBe(9);
  });
});

describe("createTraceThrottle", () => {
  it("emits once per key per window and reports what it held back", () => {
    const th = createTraceThrottle(1_000);
    expect(th.take("a", 0)).toEqual({ emit: true, suppressed: 0 });
    expect(th.take("a", 10).emit).toBe(false);
    expect(th.take("a", 999).emit).toBe(false);
    expect(th.take("b", 999)).toEqual({ emit: true, suppressed: 0 });
    expect(th.take("a", 1_000)).toEqual({ emit: true, suppressed: 2 });
    th.reset();
    expect(th.take("a", 1_001)).toEqual({ emit: true, suppressed: 0 });
  });
});
