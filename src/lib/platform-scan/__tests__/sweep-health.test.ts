/**
 * sweep-health unit tests. Pins the observability + alerting contract that makes
 * a broken continuous sweep VISIBLE:
 *   - all targets succeed   -> status ok, sweep_completed fired, NO alert, run row recorded
 *   - one target errors     -> caught (sweep continues), status partial, alert sent, sweep_failed fired, run row recorded
 *   - all targets error      -> status failed, alert sent, sweep_failed fired
 *   - top-level throw        -> caught, status failed, results=[], alert + run row recorded (never re-throws)
 *   - status-change dedup    -> a persistently-broken sweep alerts only on transition into unhealthy, not every tick
 *   - decideStatus           -> the pure status table
 *   - zero targets / all skipped -> no_targets, sweep_no_targets fired (never sweep_completed), alert
 *   - a skipped target is never a success (some assessed + some skipped -> partial)
 * All deps are injected: no real DB, no real email, no real analytics row.
 */
import {
  recordSweepRun,
  runSweepWithHealth,
  decideStatus,
  engagementOutcome,
  pentestOutcome,
  type SweepHealthDeps,
  type SweepRunRecord,
  type SweepStatus,
} from "@/lib/platform-scan/sweep-health";

function makeDeps(overrides: Partial<SweepHealthDeps> = {}): {
  deps: SweepHealthDeps;
  inserted: SweepRunRecord[];
  notifies: unknown[];
  events: Array<{ event: string; meta: Record<string, unknown> }>;
  setPrevious: (s: SweepStatus | null) => void;
} {
  const inserted: SweepRunRecord[] = [];
  const notifies: unknown[] = [];
  const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
  let prev: SweepStatus | null = null;

  const deps: SweepHealthDeps = {
    insertRun: async (row) => {
      inserted.push(row);
    },
    previousStatus: async () => prev,
    notify: (async (input: unknown) => {
      notifies.push(input);
      return { id: "n1" } as never;
    }) as SweepHealthDeps["notify"],
    trackEvent: ((event: string, _id: string, _role: string, meta: Record<string, unknown>) => {
      events.push({ event, meta });
    }) as SweepHealthDeps["trackEvent"],
    now: () => new Date("2026-06-27T12:00:00.000Z"),
    newId: () => "swp_fixed",
    ...overrides,
  };
  return { deps, inserted, notifies, events, setPrevious: (s) => (prev = s) };
}

const actor = { id: "cron", role: "system" };
const started = new Date("2026-06-27T11:59:00.000Z");

describe("decideStatus", () => {
  it("ok only when every target was assessed", () => {
    expect(decideStatus(3, 0, false)).toBe("ok");
    expect(decideStatus(3, 0, false, 0)).toBe("ok");
  });
  it("no_targets when nothing was assessed (zero targets, or all skipped)", () => {
    expect(decideStatus(0, 0, false)).toBe("no_targets");
    expect(decideStatus(0, 0, false, 4)).toBe("no_targets");
  });
  it("partial when some were assessed and others skipped (a skip is not a success)", () => {
    expect(decideStatus(2, 0, false, 1)).toBe("partial");
  });
  it("failed when targets failed and none succeeded, even with skips", () => {
    expect(decideStatus(0, 2, false, 3)).toBe("failed");
  });
  it("partial when some succeed and some fail", () => {
    expect(decideStatus(2, 1, false)).toBe("partial");
  });
  it("failed when all attempted targets fail", () => {
    expect(decideStatus(0, 3, false)).toBe("failed");
  });
  it("failed on a top-level throw regardless of counts", () => {
    expect(decideStatus(0, 0, true)).toBe("failed");
  });
});

describe("outcome classifiers", () => {
  it("treats an error: skip as a failure and a benign skip as a skip, never a success", () => {
    expect(engagementOutcome({ platform: "a", skipped: "error:boom" })).toEqual({
      target: "a",
      ok: false,
      reason: "error:boom",
    });
    expect(engagementOutcome({ platform: "b", skipped: "no_static_target" })).toEqual({
      target: "b",
      ok: false,
      skipped: true,
      reason: "no_static_target",
    });
    expect(engagementOutcome({ platform: "c" })).toEqual({ target: "c", ok: true });
    expect(pentestOutcome({ platform: "d", skipped: "error:x" })).toMatchObject({ ok: false });
    expect(pentestOutcome({ platform: "d", skipped: "error:x" }).skipped).toBeUndefined();
    expect(pentestOutcome({ platform: "e", skipped: "no_active_scope" })).toMatchObject({
      ok: false,
      skipped: true,
    });
  });
});

describe("recordSweepRun", () => {
  it("all targets succeed -> ok, sweep_completed, NO alert, run recorded", async () => {
    const { deps, inserted, notifies, events } = makeDeps();
    const res = await recordSweepRun(
      {
        kind: "engagement",
        actor,
        startedAt: started,
        outcomes: [
          { target: "a", ok: true },
          { target: "b", ok: true },
        ],
      },
      deps,
    );

    expect(res.status).toBe("ok");
    expect(res.alerted).toBe(false);
    expect(notifies).toHaveLength(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: "engagement", status: "ok", targetsSucceeded: 2 });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("platform.sweep_completed");
    expect(events[0].meta).toMatchObject({ kind: "engagement", targets: 2, succeeded: 2, failed: 0 });
  });

  it("one target errors -> partial, alert sent, sweep_failed fired, run recorded with the failed reason", async () => {
    const { deps, inserted, notifies, events } = makeDeps();
    const res = await recordSweepRun(
      {
        kind: "engagement",
        actor,
        startedAt: started,
        outcomes: [
          { target: "a", ok: true },
          { target: "b", ok: false, reason: "error:fetch failed" },
        ],
      },
      deps,
    );

    expect(res.status).toBe("partial");
    expect(res.alerted).toBe(true);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ category: "security", priority: "high", source: "sweep_health" });
    expect(events[0].event).toBe("platform.sweep_failed");
    // The failed target's reason is durably recorded (no data lost).
    expect(inserted[0].outcomes).toEqual(
      expect.arrayContaining([{ target: "b", ok: false, reason: "error:fetch failed" }]),
    );
  });

  it("all targets fail -> failed + alert", async () => {
    const { deps, notifies, events } = makeDeps();
    const res = await recordSweepRun(
      {
        kind: "pentest",
        actor,
        startedAt: started,
        outcomes: [
          { target: "a", ok: false, reason: "error:x" },
          { target: "b", ok: false, reason: "error:y" },
        ],
      },
      deps,
    );

    expect(res.status).toBe("failed");
    expect(res.alerted).toBe(true);
    expect(notifies).toHaveLength(1);
    expect(events[0].event).toBe("platform.sweep_failed");
  });

  it("a 'ux'-kind run records, derives status, and alerts exactly like the security kinds", async () => {
    // Continuous UX sweep shares the SAME ledger + alerting path (migration 200
    // widened the kind CHECK; SweepKind gained 'ux'). An all-ok ux run fires
    // sweep_completed with no alert...
    const okDeps = makeDeps();
    const ok = await recordSweepRun(
      {
        kind: "ux",
        actor,
        startedAt: started,
        outcomes: [
          { target: "/", ok: true },
          { target: "/dashboard", ok: true },
        ],
      },
      okDeps.deps,
    );
    expect(ok.status).toBe("ok");
    expect(ok.alerted).toBe(false);
    expect(okDeps.notifies).toHaveLength(0);
    expect(okDeps.inserted[0]).toMatchObject({ kind: "ux", status: "ok", targetsSucceeded: 2 });
    expect(okDeps.events[0].event).toBe("platform.sweep_completed");
    expect(okDeps.events[0].meta).toMatchObject({ kind: "ux", targets: 2, succeeded: 2 });

    // ...and a failing ux target alerts + fires sweep_failed, with a kind-derived
    // label ("ux sweep", not the old pentest fallback).
    const badDeps = makeDeps();
    const bad = await recordSweepRun(
      {
        kind: "ux",
        actor,
        startedAt: started,
        outcomes: [
          { target: "/", ok: true },
          { target: "/login", ok: false, reason: "error:blank render" },
        ],
      },
      badDeps.deps,
    );
    expect(bad.status).toBe("partial");
    expect(bad.alerted).toBe(true);
    expect(badDeps.notifies).toHaveLength(1);
    expect(badDeps.notifies[0]).toMatchObject({
      category: "security",
      source: "sweep_health",
      sourceId: "ux:partial",
    });
    expect(badDeps.notifies[0]).toMatchObject({ title: expect.stringContaining("ux sweep") });
    expect(badDeps.events[0].event).toBe("platform.sweep_failed");
    expect(badDeps.inserted[0].outcomes).toEqual(
      expect.arrayContaining([{ target: "/login", ok: false, reason: "error:blank render" }]),
    );
  });

  it("status-change dedup applies to 'ux' too: a still-broken ux sweep does NOT re-alert", async () => {
    const { deps, notifies, events, setPrevious } = makeDeps();
    setPrevious("failed");
    const res = await recordSweepRun(
      {
        kind: "ux",
        actor,
        startedAt: started,
        outcomes: [{ target: "/", ok: false, reason: "error:csp" }],
      },
      deps,
    );
    expect(res.status).toBe("failed");
    expect(res.alerted).toBe(false);
    expect(notifies).toHaveLength(0);
    expect(events[0].event).toBe("platform.sweep_failed");
  });

  it("status-change dedup: a still-broken sweep does NOT re-alert, but still records + fires analytics", async () => {
    const { deps, notifies, events, setPrevious } = makeDeps();
    setPrevious("failed"); // previous tick was already failed

    const res = await recordSweepRun(
      {
        kind: "pentest",
        actor,
        startedAt: started,
        outcomes: [{ target: "a", ok: false, reason: "error:x" }],
      },
      deps,
    );

    expect(res.status).toBe("failed");
    expect(res.alerted).toBe(false); // no spam
    expect(notifies).toHaveLength(0);
    // analytics + ledger still fire every tick.
    expect(events[0].event).toBe("platform.sweep_failed");
  });

  it("re-alerts when status changes from partial to failed (a worse state is a transition)", async () => {
    const { deps, notifies, setPrevious } = makeDeps();
    setPrevious("partial");
    const res = await recordSweepRun(
      {
        kind: "pentest",
        actor,
        startedAt: started,
        outcomes: [{ target: "a", ok: false, reason: "error:x" }],
      },
      deps,
    );
    expect(res.status).toBe("failed");
    expect(notifies).toHaveLength(1);
  });

  it("never throws even if the ledger insert and notifier both fail", async () => {
    const { deps } = makeDeps({
      insertRun: async () => {
        throw new Error("db down");
      },
      notify: (async () => {
        throw new Error("resend down");
      }) as SweepHealthDeps["notify"],
    });
    const res = await recordSweepRun(
      {
        kind: "engagement",
        actor,
        startedAt: started,
        outcomes: [{ target: "a", ok: false, reason: "error:x" }],
      },
      deps,
    );
    expect(res.status).toBe("failed");
    expect(res.alerted).toBe(false); // notify failed -> not alerted, but no throw
  });
});

describe("runSweepWithHealth", () => {
  it("classifies orchestrator results and records an ok run with no alert", async () => {
    const { deps, inserted, notifies } = makeDeps();
    const out = await runSweepWithHealth(
      {
        kind: "engagement",
        actor,
        run: async () => [{ platform: "a", skipped: undefined }, { platform: "c" }],
        outcome: engagementOutcome,
      },
      deps,
    );

    expect(out.results).toHaveLength(2);
    expect(out.health.status).toBe("ok");
    expect(notifies).toHaveLength(0);
    expect(inserted[0].status).toBe("ok");
  });

  it("an assessed target plus a skipped one is partial, not ok", async () => {
    const { deps, inserted, events } = makeDeps();
    const out = await runSweepWithHealth(
      {
        kind: "engagement",
        actor,
        run: async () => [
          { platform: "a", skipped: undefined },
          { platform: "b", skipped: "no_static_target" },
        ],
        outcome: engagementOutcome,
      },
      deps,
    );
    expect(out.health).toMatchObject({ status: "partial", targetsSucceeded: 1, targetsFailed: 0, targetsSkipped: 1 });
    expect(inserted[0]).toMatchObject({ status: "partial", targetsSkipped: 1 });
    expect(events.map((e) => e.event)).not.toContain("platform.sweep_completed");
  });

  it("zero targets -> no_targets run, sweep_no_targets fired, never sweep_completed", async () => {
    const { deps, inserted, notifies, events } = makeDeps();
    const out = await runSweepWithHealth(
      { kind: "pentest", actor, run: async () => [], outcome: pentestOutcome },
      deps,
    );
    expect(out.health.status).toBe("no_targets");
    expect(inserted[0]).toMatchObject({ status: "no_targets", targetsTotal: 0 });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("platform.sweep_no_targets");
    expect(events[0].meta).toMatchObject({ kind: "pentest", targets: 0, status: "no_targets" });
    expect(notifies).toHaveLength(1);
    expect(JSON.stringify(notifies[0])).toContain("NO targets");
  });

  it("every target skipped -> no_targets with the skip reasons in the alert", async () => {
    const { deps, notifies, events } = makeDeps();
    const out = await runSweepWithHealth(
      {
        kind: "engagement",
        actor,
        run: async () => [
          { platform: "wolfpack-instinct", skipped: "no_static_target" },
          { platform: "ogiam", skipped: "no_static_target" },
        ],
        outcome: engagementOutcome,
      },
      deps,
    );
    expect(out.health).toMatchObject({ status: "no_targets", targetsSkipped: 2, targetsSucceeded: 0 });
    expect(events[0].event).toBe("platform.sweep_no_targets");
    expect(JSON.stringify(notifies[0])).toContain("ogiam (skipped: no_static_target)");
  });

  it("a persistent no_targets state alerts once, not every tick", async () => {
    const { deps, notifies, setPrevious } = makeDeps();
    setPrevious("no_targets");
    const out = await runSweepWithHealth(
      { kind: "engagement", actor, run: async () => [], outcome: engagementOutcome },
      deps,
    );
    expect(out.health.status).toBe("no_targets");
    expect(out.health.alerted).toBe(false);
    expect(notifies).toHaveLength(0);
  });

  it("one target's error: result -> partial run, sweep continues, alert sent", async () => {
    const { deps, notifies } = makeDeps();
    const out = await runSweepWithHealth(
      {
        kind: "engagement",
        actor,
        run: async () => [
          { platform: "a" },
          { platform: "b", skipped: "error:repo 404" },
        ],
        outcome: engagementOutcome,
      },
      deps,
    );
    expect(out.results).toHaveLength(2); // resilient: both targets present
    expect(out.health.status).toBe("partial");
    expect(notifies).toHaveLength(1);
  });

  it("a top-level orchestrator throw is caught, recorded as failed, alerted, results=[] (never re-throws)", async () => {
    const { deps, inserted, notifies } = makeDeps();
    const out = await runSweepWithHealth(
      {
        kind: "pentest",
        actor,
        run: async () => {
          throw new Error("listScopes failed");
        },
        outcome: pentestOutcome,
      },
      deps,
    );

    expect(out.results).toEqual([]);
    expect(out.health.status).toBe("failed");
    expect(out.health.alerted).toBe(true);
    expect(inserted[0]).toMatchObject({ status: "failed", error: "listScopes failed" });
    expect(notifies).toHaveLength(1);
  });
});
