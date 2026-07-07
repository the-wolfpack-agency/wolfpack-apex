/**
 * Unit tests for checkAndNotify - the proactive release-gate notifier.
 *
 * Hardened after a prod EMAIL-SPAM incident; the pins below encode the new
 * conservative policy (all deps mocked, frozen clock, zero network/DB):
 *
 *   - EMAIL OFF BY DEFAULT: no email unless deps.emailEnabled === true; in-app
 *     is always attempted; email fires only when explicitly enabled.
 *   - DEDUPE FAILS CLOSED: a listRecentNotifs failure -> ZERO notifications this
 *     run + observable (logged + dedupeUnavailable:true).
 *   - RECORD ON ATTEMPT: a change whose in-app (and email, when on) BOTH fail
 *     still records the dedupe row, so the next run does NOT re-send (no loop).
 *   - PER-STATE THRESHOLDS: ready_to_merge pings promptly (0h, the "waiting to
 *     deploy" signal); awaiting_approval at 4h; checks_failing / merge_conflict
 *     only once STALLED (8h - an unattended red PR, not active dev);
 *     checks_running is transient and NEVER notified.
 *   - PER-RUN CAP of 3 enforced, oldest-first, surplus suppressed + logged.
 *   - a state CHANGE between notifiable states re-fires (escalation).
 *   - gate.degraded / a gate throw -> NO notifications + a degraded signal.
 */

import {
  checkAndNotify,
  blockedMessage,
  DEFAULT_THRESHOLD_HOURS,
  STALL_THRESHOLD_HOURS,
  MAX_NOTIFY_PER_RUN,
  type CheckAndNotifyDeps,
  type NotifRecord,
} from "@/lib/deploy/release-gate-notify";
import type { BlockingChange, ReleaseGateStatus } from "@/lib/deploy/release-gate";

const NOW = 1_700_000_000_000;

function change(over: Partial<BlockingChange> = {}): BlockingChange {
  return {
    number: 42,
    title: "Add the thing",
    url: "https://github.com/the-wolfpack-agency/wolfpack-apex/pull/42",
    author: "octocat",
    headSha: "abc123",
    state: "awaiting_approval",
    reason: "Waiting on your approval",
    ageHours: 5,
    ...over,
  };
}

function gate(over: Partial<ReleaseGateStatus> = {}): ReleaseGateStatus {
  return {
    productionBranch: "main",
    blocking: [],
    checkedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function makeDeps(over: Partial<CheckAndNotifyDeps> = {}): {
  deps: CheckAndNotifyDeps;
  sendInApp: jest.Mock;
  sendEmail: jest.Mock;
  recordNotif: jest.Mock;
  track: jest.Mock;
} {
  const sendInApp = jest.fn().mockResolvedValue(undefined);
  const sendEmail = jest.fn().mockResolvedValue(undefined);
  const recordNotif = jest.fn().mockResolvedValue(undefined);
  const track = jest.fn();
  const deps: CheckAndNotifyDeps = {
    getReleaseGate: jest.fn().mockResolvedValue(gate({ blocking: [change()] })),
    listRecentNotifs: jest.fn().mockResolvedValue([] as NotifRecord[]),
    recordNotif,
    sendInApp,
    sendEmail,
    track,
    now: () => NOW,
    ...over,
  };
  return { deps, sendInApp, sendEmail, recordNotif, track };
}

describe("checkAndNotify", () => {
  test("DEFAULT_THRESHOLD_HOURS is the raised 4h stall window", () => {
    expect(DEFAULT_THRESHOLD_HOURS).toBe(4);
  });

  test("blockedMessage uses the plain reason + deep link, no GitHub enum", () => {
    const msg = blockedMessage(change());
    expect(msg).toContain("PR #42 is blocking production: Waiting on your approval");
    expect(msg).toContain("https://github.com/the-wolfpack-agency/wolfpack-apex/pull/42");
    expect(msg).not.toContain("awaiting_approval");
  });

  // FIX 1: EMAIL OFF BY DEFAULT.
  test("email is NOT sent when emailEnabled is absent (in-app only by default)", async () => {
    const { deps, sendInApp, sendEmail, recordNotif, track } = makeDeps();
    const res = await checkAndNotify(deps);

    expect(res).toMatchObject({ checked: 1, notified: 1, degraded: false, failures: 0 });
    expect(sendInApp).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
    // Dedupe still recorded (in-app was attempted).
    expect(recordNotif).toHaveBeenCalledWith({ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW });
    // No email unblock event when email is off.
    expect(track).not.toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      "cron",
      "system",
      expect.objectContaining({ channel: "email" }),
    );
    expect(track).toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      "cron",
      "system",
      expect.objectContaining({ channel: "in_app" }),
    );
  });

  test("email is NOT sent when emailEnabled is explicitly false", async () => {
    const { deps, sendEmail } = makeDeps({ emailEnabled: false });
    await checkAndNotify(deps);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("email IS sent only when emailEnabled === true", async () => {
    const { deps, sendInApp, sendEmail, recordNotif, track } = makeDeps({ emailEnabled: true });
    const res = await checkAndNotify(deps);

    expect(res).toMatchObject({ checked: 1, notified: 1, failures: 0 });
    expect(sendInApp).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(recordNotif).toHaveBeenCalledWith({ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW });
    expect(track).toHaveBeenCalledWith(
      "deploy.release_blocked_detected",
      "cron",
      "system",
      expect.objectContaining({ pr_number: 42, state: "awaiting_approval", age_hours: 5 }),
    );
    expect(track).toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      "cron",
      "system",
      expect.objectContaining({ pr_number: 42, channel: "in_app", age_hours: 5 }),
    );
    expect(track).toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      "cron",
      "system",
      expect.objectContaining({ pr_number: 42, channel: "email", age_hours: 5 }),
    );
  });

  test("same PR same state within cooldown -> NOT re-notified", async () => {
    const { deps, sendInApp, sendEmail, recordNotif } = makeDeps({
      emailEnabled: true,
      listRecentNotifs: jest
        .fn()
        .mockResolvedValue([{ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW - 60_000 }]),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 1, notified: 0, dedupeUnavailable: false });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordNotif).not.toHaveBeenCalled();
  });

  // FIX 4: a CHANGE between two notifiable states re-fires (escalation).
  test("a state CHANGE between notifiable states re-notifies", async () => {
    const { deps, sendInApp } = makeDeps({
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ state: "ready_to_merge", reason: "Ready to promote" })] })),
      listRecentNotifs: jest
        .fn()
        .mockResolvedValue([{ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW - 60_000 }]),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(1);
    expect(sendInApp).toHaveBeenCalledTimes(1);
  });

  // FIX 5: RAISED THRESHOLD (4h).
  test("a PR under the 4h threshold is not notified", async () => {
    const { deps, sendInApp, sendEmail } = makeDeps({
      emailEnabled: true,
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ ageHours: DEFAULT_THRESHOLD_HOURS - 0.1 })] })),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 1, notified: 0 });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("a PR at exactly the 4h threshold IS notified", async () => {
    const { deps, sendInApp } = makeDeps({
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ ageHours: DEFAULT_THRESHOLD_HOURS })] })),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(1);
    expect(sendInApp).toHaveBeenCalledTimes(1);
  });

  // checks_running is transient (the run finishes itself) -> NEVER notified,
  // even after 20h. It is still counted in `checked`.
  test("checks_running is counted but NEVER notified (transient)", async () => {
    const { deps, sendInApp, sendEmail, recordNotif, track } = makeDeps({
      emailEnabled: true,
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ state: "checks_running", ageHours: 20 })] })),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 1, notified: 0, suppressed: 0 });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordNotif).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  // ready_to_merge is the "changes built and waiting to deploy" signal: it pings
  // promptly (0h threshold) so a ready change is never sat on silently.
  test("ready_to_merge notifies promptly, even brand new (0h threshold)", async () => {
    const { deps, sendInApp } = makeDeps({
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(
          gate({ blocking: [change({ state: "ready_to_merge", reason: "Ready to promote", ageHours: 0.1 })] }),
        ),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(1);
    expect(sendInApp).toHaveBeenCalledTimes(1);
  });

  // checks_failing / merge_conflict = "stuck, needs a human". They notify ONLY
  // once STALLED (>= STALL_THRESHOLD_HOURS), so active dev (a red check being
  // iterated) stays quiet, but an unattended bump ("tests failing - fix needed")
  // surfaces.
  test.each(["checks_failing", "merge_conflict"] as const)(
    "stall state %s is NOT notified before the stall window",
    async (state) => {
      const { deps, sendInApp } = makeDeps({
        emailEnabled: true,
        getReleaseGate: jest
          .fn()
          .mockResolvedValue(gate({ blocking: [change({ state, ageHours: STALL_THRESHOLD_HOURS - 0.1 })] })),
      });
      const res = await checkAndNotify(deps);
      expect(res).toMatchObject({ checked: 1, notified: 0 });
      expect(sendInApp).not.toHaveBeenCalled();
    },
  );

  test.each(["checks_failing", "merge_conflict"] as const)(
    "stall state %s IS notified once past the stall window",
    async (state) => {
      const { deps, sendInApp } = makeDeps({
        getReleaseGate: jest
          .fn()
          .mockResolvedValue(gate({ blocking: [change({ state, ageHours: STALL_THRESHOLD_HOURS })] })),
      });
      const res = await checkAndNotify(deps);
      expect(res.notified).toBe(1);
      expect(sendInApp).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["ready_to_merge", "awaiting_approval"] as const)(
    "actionable state %s IS notified",
    async (state) => {
      const { deps, sendInApp } = makeDeps({
        getReleaseGate: jest
          .fn()
          .mockResolvedValue(gate({ blocking: [change({ state, ageHours: 10 })] })),
      });
      const res = await checkAndNotify(deps);
      expect(res.notified).toBe(1);
      expect(sendInApp).toHaveBeenCalledTimes(1);
    },
  );

  // A per-state override can quiet or sharpen a single state without touching
  // the others (e.g. silence stall pings for a noisy repo).
  test("stateThresholds override can silence a state (null) or sharpen it", async () => {
    const silenced = makeDeps({
      stateThresholds: { checks_failing: null },
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ state: "checks_failing", ageHours: 40 })] })),
    });
    expect((await checkAndNotify(silenced.deps)).notified).toBe(0);
    expect(silenced.sendInApp).not.toHaveBeenCalled();

    const sharpened = makeDeps({
      stateThresholds: { checks_running: 1 },
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ state: "checks_running", ageHours: 2 })] })),
    });
    expect((await checkAndNotify(sharpened.deps)).notified).toBe(1);
    expect(sharpened.sendInApp).toHaveBeenCalledTimes(1);
  });

  test("no blocking changes -> nothing sent", async () => {
    const { deps, sendInApp, sendEmail, track } = makeDeps({
      getReleaseGate: jest.fn().mockResolvedValue(gate({ blocking: [] })),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 0, notified: 0, degraded: false, suppressed: 0 });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  // FIX 6: PER-RUN CAP.
  test("per-run cap of 3 enforced oldest-first; the rest suppressed + logged", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Five eligible actionable changes of varying ages.
    const blocking = [
      change({ number: 1, ageHours: 5 }),
      change({ number: 2, ageHours: 30 }),
      change({ number: 3, ageHours: 10 }),
      change({ number: 4, ageHours: 50 }),
      change({ number: 5, ageHours: 20 }),
    ];
    const { deps, sendInApp } = makeDeps({
      getReleaseGate: jest.fn().mockResolvedValue(gate({ blocking })),
    });
    const res = await checkAndNotify(deps);

    expect(MAX_NOTIFY_PER_RUN).toBe(3);
    expect(res).toMatchObject({ checked: 5, notified: 3, suppressed: 2 });
    // Oldest-first: PRs 4 (50h), 2 (30h), 5 (20h) get sent; 3 + 1 suppressed.
    const notifiedNumbers = sendInApp.mock.calls.map((c) => (c[0] as BlockingChange).number);
    expect(notifiedNumbers).toEqual([4, 2, 5]);
    // The suppression is observable.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("per-run cap"));
    warnSpy.mockRestore();
  });

  test("gate.degraded -> NO notifications + degraded signal (no false all-clear)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendInApp, sendEmail, track } = makeDeps({
      emailEnabled: true,
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ degraded: { detail: "Could not reach GitHub" } })),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 0, notified: 0, degraded: true });
    expect(res.degradedDetail).toContain("Could not reach GitHub");
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEGRADED"),
      expect.stringContaining("Could not reach GitHub"),
    );
    errSpy.mockRestore();
  });

  test("a gate read that throws is treated as a degrade, nothing sent", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendInApp, sendEmail } = makeDeps({
      emailEnabled: true,
      getReleaseGate: jest.fn().mockRejectedValue(new Error("boom")),
    });
    const res = await checkAndNotify(deps);
    expect(res.degraded).toBe(true);
    expect(res.degradedDetail).toContain("boom");
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("a send failure on in-app is observable + still records dedupe (no loop)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, recordNotif } = makeDeps({
      sendInApp: jest.fn().mockRejectedValue(new Error("in-app down")),
    });
    const res = await checkAndNotify(deps);

    // Nothing delivered (email is off by default), but the failure is counted...
    expect(res).toMatchObject({ checked: 1, notified: 0, degraded: false });
    expect(res.failures).toBe(1);
    // FIX 3: dedupe recorded on ATTEMPT even though delivery failed -> no loop.
    expect(recordNotif).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("in-app"),
      expect.stringContaining("in-app down"),
    );
    errSpy.mockRestore();
  });

  // FIX 3: a change whose every attempted channel FAILS still records the dedupe
  // row, so the next run does NOT re-send (the observed bounce-loop is closed).
  test("both channels fail -> dedupe IS recorded so the next run does not loop", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, recordNotif } = makeDeps({
      emailEnabled: true,
      sendInApp: jest.fn().mockRejectedValue(new Error("in-app down")),
      sendEmail: jest.fn().mockRejectedValue(new Error("email down")),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(0);
    expect(res.failures).toBe(2);
    expect(recordNotif).toHaveBeenCalledWith({ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW });
    errSpy.mockRestore();
  });

  // FIX 2: DEDUPE FAILS CLOSED FOR NOISE.
  test("a listRecentNotifs failure fails CLOSED -> ZERO notifications + observable", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendInApp, sendEmail, recordNotif } = makeDeps({
      emailEnabled: true,
      listRecentNotifs: jest.fn().mockRejectedValue(new Error("ledger down")),
    });
    const res = await checkAndNotify(deps);
    // Sends NOTHING this run - the spam loop's root cause is the read-failed-open
    // path, so we now stay quiet rather than re-notify everything.
    expect(res).toMatchObject({ checked: 1, notified: 0, degraded: false, dedupeUnavailable: true });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordNotif).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("listRecentNotifs failed"),
      expect.stringContaining("ledger down"),
    );
    errSpy.mockRestore();
  });
});
