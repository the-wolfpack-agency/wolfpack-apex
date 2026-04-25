/**
 * Tests for porsche-classes/delta — pure diff between two snapshots.
 *
 * Covers all four cases the migration-safety + ingest paths depend on:
 *   1. baseline (prev = null)
 *   2. added-only
 *   3. dropped-only
 *   4. mixed
 */

import { computeDelta } from "../delta";

describe("computeDelta", () => {
  it("baseline — prev null returns added=curr, dropped=[], baseline=true", () => {
    const d = computeDelta(null, ["alice", "bob"]);
    expect(d).toEqual({
      added: ["alice", "bob"],
      dropped: [],
      net_change: 2,
      is_baseline: true,
    });
  });

  it("added-only — net_change is positive", () => {
    const d = computeDelta(["alice"], ["alice", "bob"]);
    expect(d).toEqual({
      added: ["bob"],
      dropped: [],
      net_change: 1,
      is_baseline: false,
    });
  });

  it("dropped-only — net_change is negative", () => {
    const d = computeDelta(["alice", "bob"], ["alice"]);
    expect(d).toEqual({
      added: [],
      dropped: ["bob"],
      net_change: -1,
      is_baseline: false,
    });
  });

  it("mixed — added + dropped, net = added - dropped", () => {
    const d = computeDelta(["alice", "bob"], ["alice", "carol", "dan"]);
    expect(d).toEqual({
      added: ["carol", "dan"],
      dropped: ["bob"],
      net_change: 1,
      is_baseline: false,
    });
  });

  it("equal sets — no change", () => {
    const d = computeDelta(["alice", "bob"], ["alice", "bob"]);
    expect(d).toEqual({
      added: [],
      dropped: [],
      net_change: 0,
      is_baseline: false,
    });
  });

  it("empty curr against non-empty prev — everyone dropped", () => {
    const d = computeDelta(["alice", "bob"], []);
    expect(d).toEqual({
      added: [],
      dropped: ["alice", "bob"],
      net_change: -2,
      is_baseline: false,
    });
  });

  it("baseline with empty curr is still baseline", () => {
    const d = computeDelta(null, []);
    expect(d.is_baseline).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.dropped).toEqual([]);
    expect(d.net_change).toBe(0);
  });

  it("output added/dropped are sorted", () => {
    const d = computeDelta(["x"], ["zoe", "alex", "brad"]);
    expect(d.added).toEqual(["alex", "brad", "zoe"]);
  });
});
