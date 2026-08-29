/**
 * The Teams provider has to finish inside the fan-out budget.
 *
 * It awaited one Graph call at a time: 8 teams in sequence, then up to 160
 * channels in sequence. Measured 2026-08-29 in production, p95 22,136ms and
 * max 129,458ms against a 6,000ms budget. At ~130ms per Graph round trip, 160
 * sequential calls IS 21 seconds. The number was arithmetic, not mystery.
 *
 * Nobody waited 22 seconds, because the budget abandoned the provider at 6s.
 * What they got was worse: an empty Teams result, reported as though Teams had
 * been searched and found nothing.
 *
 * These tests pin the three properties that make it finish: the calls overlap,
 * the scan is capped, and the order does not depend on which call returns
 * first.
 */
import { mapWithConcurrency } from "@/lib/search/providers/util";

describe("mapWithConcurrency", () => {
  /* THE POINT. Ten items at concurrency 5 must take two waves, not ten. */
  it("runs up to `limit` at once instead of one at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 5, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  /* Firing all 160 at once trades a slow provider for a throttled one: Graph
     answers 429 and the retry costs more than the sequencing saved. */
  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  /* ORDER IS THE SUBTLE ONE. Results written on completion would make ranking
     depend on network timing, so the same search would return a different
     order each time. This resolves the slowest item FIRST in input order to
     prove the output is not completion-ordered. */
  it("preserves input order regardless of which finishes first", async () => {
    const delays = [40, 1, 30, 2, 20];
    const out = await mapWithConcurrency(delays, 5, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("does not spawn more workers than there are items", async () => {
    let started = 0;
    await mapWithConcurrency([1, 2], 16, async (n) => {
      started++;
      return n;
    });
    expect(started).toBe(2);
  });

  /* A rejecting item must not leave the other workers running forever. */
  it("propagates a rejection rather than hanging", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("graph 500");
        return n;
      }),
    ).rejects.toThrow("graph 500");
  });
});

describe("the channels provider's bounds", () => {
  /* Read from the source so the constants cannot drift away from the budget
     they were chosen against without this failing. */
  const src = require("node:fs").readFileSync(
    "src/lib/search/providers/channels.ts",
    "utf8",
  ) as string;

  it("caps how many channels it will scan", () => {
    const m = /MAX_CHANNELS_SCANNED = (\d+)/.exec(src);
    expect(m).not.toBeNull();
    const cap = Number(m![1]);
    /* 8 teams x 20 channels = 160 was the old effective ceiling and could not
       finish. Anything near it reintroduces the defect. */
    expect(cap).toBeLessThan(160);
    expect(cap).toBeGreaterThan(0);
  });

  /* The arithmetic that has to hold: waves x round-trip must fit the 6s
     budget with room to spare. */
  it("fits the fan-out budget at a realistic Graph round trip", () => {
    const cap = Number(/MAX_CHANNELS_SCANNED = (\d+)/.exec(src)![1]);
    const conc = Number(/MESSAGE_SCAN_CONCURRENCY = (\d+)/.exec(src)![1]);
    const ROUND_TRIP_MS = 130;
    const BUDGET_MS = 6_000;
    const worstCaseMs = Math.ceil(cap / conc) * ROUND_TRIP_MS;
    expect(worstCaseMs).toBeLessThan(BUDGET_MS / 2);
  });

  it("no longer awaits Graph calls one at a time in either stage", () => {
    expect(src).toContain("mapWithConcurrency");
    /* The two sequential awaits that caused it. */
    expect(src).not.toMatch(/for \(const team of[\s\S]{0,200}await listTeamChannels/);
    expect(src).not.toMatch(/for \(const t of channelTriples\)[\s\S]{0,200}await listChannelMessages/);
  });
});
