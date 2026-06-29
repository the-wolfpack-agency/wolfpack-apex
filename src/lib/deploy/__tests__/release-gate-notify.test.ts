/**
 * Unit tests for checkAndNotify - the proactive release-gate notifier.
 *
 * Pins (all deps mocked, frozen clock, zero network/DB):
 *   - a blocking PR older than threshold + not yet notified -> sends in-app +
 *     email + records the dedupe row + fires both analytics events.
 *   - same PR same state within cooldown -> NOT re-notified.
 *   - a state CHANGE on the same PR -> re-notified (genuine escalation).
 *   - a fresh (under-threshold) PR -> not notified.
 *   - no blocking changes -> nothing sent.
 *   - gate.degraded -> NO notifications + a degraded signal (no false all-clear).
 *   - a gate read that THROWS -> treated as degrade, nothing sent.
 *   - a send failure on one channel -> the other is still attempted, the cron
 *     still returns, and the failure is observable (counted).
 *   - both channels fail -> dedupe row is NOT recorded (next tick retries).
 */

import {
  checkAndNotify,
  blockedMessage,
  DEFAULT_THRESHOLD_HOURS,
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
  test("blockedMessage uses the plain reason + deep link, no GitHub enum", () => {
    const msg = blockedMessage(change());
    expect(msg).toContain("PR #42 is blocking production: Waiting on your approval");
    expect(msg).toContain("https://github.com/the-wolfpack-agency/wolfpack-apex/pull/42");
    expect(msg).not.toContain("awaiting_approval");
  });

  test("a blocking PR over threshold + not yet notified -> in-app + email + record + both events", async () => {
    const { deps, sendInApp, sendEmail, recordNotif, track } = makeDeps();
    const res = await checkAndNotify(deps);

    expect(res).toMatchObject({ checked: 1, notified: 1, degraded: false, failures: 0 });
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
      listRecentNotifs: jest
        .fn()
        .mockResolvedValue([{ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW - 60_000 }]),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 1, notified: 0 });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordNotif).not.toHaveBeenCalled();
  });

  test("a state CHANGE on the same PR re-notifies (escalation is a new event)", async () => {
    const { deps, sendInApp } = makeDeps({
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ state: "checks_failing", reason: "Tests are failing - fix needed" })] })),
      listRecentNotifs: jest
        .fn()
        .mockResolvedValue([{ prNumber: 42, state: "awaiting_approval", notifiedAtMs: NOW - 60_000 }]),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(1);
    expect(sendInApp).toHaveBeenCalledTimes(1);
  });

  test("a fresh (under-threshold) PR is not notified", async () => {
    const { deps, sendInApp, sendEmail } = makeDeps({
      getReleaseGate: jest
        .fn()
        .mockResolvedValue(gate({ blocking: [change({ ageHours: DEFAULT_THRESHOLD_HOURS - 0.1 })] })),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 1, notified: 0 });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("no blocking changes -> nothing sent", async () => {
    const { deps, sendInApp, sendEmail, track } = makeDeps({
      getReleaseGate: jest.fn().mockResolvedValue(gate({ blocking: [] })),
    });
    const res = await checkAndNotify(deps);
    expect(res).toMatchObject({ checked: 0, notified: 0, degraded: false });
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  test("gate.degraded -> NO notifications + degraded signal (no false all-clear)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendInApp, sendEmail, track } = makeDeps({
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
    // Observable: a degraded log line was emitted.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEGRADED"),
      expect.stringContaining("Could not reach GitHub"),
    );
    errSpy.mockRestore();
  });

  test("a gate read that throws is treated as a degrade, nothing sent", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendInApp, sendEmail } = makeDeps({
      getReleaseGate: jest.fn().mockRejectedValue(new Error("boom")),
    });
    const res = await checkAndNotify(deps);
    expect(res.degraded).toBe(true);
    expect(res.degradedDetail).toContain("boom");
    expect(sendInApp).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("a send failure on one channel still attempts the other + is observable", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendEmail, recordNotif, track } = makeDeps({
      sendInApp: jest.fn().mockRejectedValue(new Error("in-app down")),
    });
    const res = await checkAndNotify(deps);

    // The email channel was still attempted...
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // ...the cron still returns + counts the failure...
    expect(res).toMatchObject({ checked: 1, notified: 1, degraded: false });
    expect(res.failures).toBe(1);
    // ...the dedupe row IS recorded because one channel succeeded...
    expect(recordNotif).toHaveBeenCalledTimes(1);
    // ...only the email unblock event fired (not in-app)...
    expect(track).toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      "cron",
      "system",
      expect.objectContaining({ channel: "email" }),
    );
    expect(track).not.toHaveBeenCalledWith(
      "deploy.release_unblock_notified",
      "cron",
      "system",
      expect.objectContaining({ channel: "in_app" }),
    );
    // ...and the failure is observable in the log.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("in-app"),
      expect.stringContaining("in-app down"),
    );
    errSpy.mockRestore();
  });

  test("both channels fail -> dedupe NOT recorded so the next tick retries", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, recordNotif } = makeDeps({
      sendInApp: jest.fn().mockRejectedValue(new Error("in-app down")),
      sendEmail: jest.fn().mockRejectedValue(new Error("email down")),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(0);
    expect(res.failures).toBe(2);
    expect(recordNotif).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("a listRecentNotifs failure fails safe (still notifies, logs)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { deps, sendInApp } = makeDeps({
      listRecentNotifs: jest.fn().mockRejectedValue(new Error("ledger down")),
    });
    const res = await checkAndNotify(deps);
    expect(res.notified).toBe(1);
    expect(sendInApp).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("listRecentNotifs failed"),
      expect.stringContaining("ledger down"),
    );
    errSpy.mockRestore();
  });
});
