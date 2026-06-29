/**
 * release-gate-notify.ts - PROACTIVELY notify the responsible person when a
 * built change has been blocking production past a threshold.
 *
 * THE PROBLEM THIS SOLVES
 *
 *   A PR can sit open against the production branch for hours - awaiting
 *   approval, with a red check, or behind a conflict - and nobody is told. A PR
 *   recently blocked prod for 19 HOURS with no signal: not the author, not an
 *   admin, not the client waiting on the deploy. The release gate
 *   (src/lib/deploy/release-gate.ts) makes the block VISIBLE in-product; this
 *   module makes it LOUD - but never SPAMMY.
 *
 * CONSERVATIVE-BY-DEFAULT NOTIFY POLICY (hardened after a prod EMAIL-SPAM
 * incident: this module emailed about EVERY open PR, re-sent on every cron tick
 * because the dedupe read failed open and a failing email never recorded a
 * dedupe row, and the emails bounced). The policy is now: silence beats spam.
 *
 *   1. EMAIL IS OFF BY DEFAULT. `deps.emailEnabled` gates the email channel
 *      entirely; unless it is explicitly `true` we send IN-APP ONLY. The cron
 *      route only flips it on when RELEASE_GATE_EMAIL_ALERTS === "1". The user
 *      got EMAIL spam - email is the loud, bounce-prone channel, so it is
 *      opt-in, not default.
 *
 *   2. DEDUPE FAILS CLOSED FOR NOISE. If the dedupe ledger read throws we CANNOT
 *      verify what we already sent, so we send NOTHING this run (skip the whole
 *      sweep) and surface it (log + `dedupeUnavailable` in the result). Missing
 *      one ping is the lesser evil; re-notifying on every tick is the spam loop.
 *
 *   3. RECORD DEDUPE ON ATTEMPT, NOT ON DELIVERY. The dedupe row is written
 *      whenever a channel was ATTEMPTED for a (pr, state) - regardless of
 *      whether delivery succeeded. A bouncing/failing channel therefore can NOT
 *      loop: a genuine state CHANGE re-fires (new dedupe key) and the in-app
 *      surface still shows every block, so a single missed delivery is covered.
 *
 *   4. NOTIFY ONLY USER-ACTIONABLE STATES. We ping ONLY `ready_to_merge` and
 *      `awaiting_approval` - the states a human (reviewer / promoter) must clear.
 *      `checks_running` / `checks_failing` / `merge_conflict` are the author's
 *      normal dev workflow, not an inbox-worthy production stall, and are
 *      skipped (still counted in `checked`, never notified).
 *
 *   5. RAISED AGE THRESHOLD. Only a change blocking prod for >= 4h pings, so a
 *      30-minute-old PR mid-review never triggers a notification.
 *
 *   6. PER-RUN CAP. At most MAX_NOTIFY_PER_RUN (oldest-first) are notified in one
 *      run; if more were eligible the surplus is LOGGED (and reflected in
 *      `suppressed`). No data is lost - the in-app banner / page still lists all
 *      blocking changes. This caps a burst when many PRs are open at once.
 *
 * HONEST DEGRADE still holds: if the gate read came back `degraded` we did NOT
 * actually see the open PRs (empty list is "could not check", not "all clear"),
 * so we send NOTHING and surface the degrade.
 *
 * DEDUPE KEY: per (pr_number, state) per cooldown, backed by migration 207's
 * instinct_release_gate_notifications ledger (system-wide, recipient-independent
 * - unlike the in-app notify() dedup which is per-user + resets on read). A
 * steady-state block stays quiet after the first ping; a genuine ESCALATION
 * (state changed) is a new event and re-fires.
 *
 * DELIVERY is best-effort + observable: a send/persist failure on one channel
 * must NOT throw out of the cron (the next PR still runs) but MUST be logged and
 * reflected in `failures` so a monitor can see it.
 *
 * Everything is dependency-injected so the unit tests run with zero network /
 * DB and a frozen clock. The route layer (src/app/api/cron/release-gate-check)
 * wires the real gate read, the real dedupe persistence, and the real in-app +
 * email senders (PR author + admins).
 */

import type {
  BlockingChange,
  ReleaseBlockState,
  ReleaseGateStatus,
  ReleaseGateDeps,
} from "@/lib/deploy/release-gate";
import type { InstinctEventType } from "@/lib/analytics";

/**
 * Default: a change blocking prod for >= 4h is a genuine stall worth a proactive
 * ping. Raised from 30 min so a freshly-opened PR mid-review never fires - that
 * is normal dev workflow, not a production stall.
 */
export const DEFAULT_THRESHOLD_HOURS = 4;

/** Default cooldown: do not re-notify the same (pr, state) within 6 hours. */
export const DEFAULT_COOLDOWN_HOURS = 6;

/**
 * Hard cap on notifications per sweep, oldest-first. Prevents a burst when many
 * PRs are open at once; the surplus is logged + reported, never lost (the in-app
 * page still lists every blocking change).
 */
export const MAX_NOTIFY_PER_RUN = 3;

/**
 * The ONLY states we proactively notify on: the ones a HUMAN must clear. The
 * other states (checks_running / checks_failing / merge_conflict) are the
 * author's normal dev workflow, not an inbox-worthy production stall.
 */
export const NOTIFIABLE_STATES: ReadonlySet<ReleaseBlockState> = new Set<ReleaseBlockState>([
  "ready_to_merge",
  "awaiting_approval",
]);

/** A persisted dedupe record (one logical (pr_number, state) we already pinged). */
export interface NotifRecord {
  prNumber: number;
  state: string;
  /** Epoch ms when we last notified this (pr, state). */
  notifiedAtMs: number;
}

/** The two delivery channels. Used in the analytics payload + the summary. */
export type NotifyChannel = "in_app" | "email";

/** Result of attempting one channel for one blocking change. */
export interface ChannelOutcome {
  channel: NotifyChannel;
  ok: boolean;
}

/**
 * Injectable collaborators. The route wires real implementations; tests inject
 * fakes. Senders are intentionally given the WHOLE BlockingChange so the route
 * layer owns recipient resolution (PR author + admins) and copy - this lib owns
 * the WHEN (threshold + dedupe + honest-degrade), not the addressing.
 */
export interface CheckAndNotifyDeps {
  /** Read the live gate. Defaults injected by the route to the real getReleaseGate. */
  getReleaseGate: (deps?: ReleaseGateDeps) => Promise<ReleaseGateStatus>;
  /** Recent dedupe rows (route reads migration 207's ledger). */
  listRecentNotifs: () => Promise<NotifRecord[]>;
  /** Persist that we notified (pr, state). Route UPSERTs migration 207's ledger. */
  recordNotif: (rec: { prNumber: number; state: string; notifiedAtMs: number }) => Promise<void>;
  /** Deliver the in-app notification(s) to the responsible person(s). */
  sendInApp: (change: BlockingChange) => Promise<void>;
  /** Deliver the email(s) to the responsible person(s). */
  sendEmail: (change: BlockingChange) => Promise<void>;
  /** Analytics. Same signature as trackEvent. */
  track: (
    type: InstinctEventType,
    userId: string,
    role: string,
    payload: Record<string, string | number | boolean>,
  ) => void;
  /** Clock - epoch ms. Injected so age + cooldown math is deterministic. */
  now: () => number;
  /**
   * Gate the EMAIL channel. Email is OFF unless this is explicitly `true`; the
   * default (false/undefined) is IN-APP ONLY. The route flips it on only when
   * RELEASE_GATE_EMAIL_ALERTS === "1". This is the primary spam fix - email is
   * the loud, bounce-prone channel, so it is opt-in.
   */
  emailEnabled?: boolean;
  /** Override the age threshold (hours). Defaults to DEFAULT_THRESHOLD_HOURS. */
  thresholdHours?: number;
  /** Override the re-notify cooldown (hours). Defaults to DEFAULT_COOLDOWN_HOURS. */
  cooldownHours?: number;
  /** Override the per-run notify cap. Defaults to MAX_NOTIFY_PER_RUN. */
  maxNotifyPerRun?: number;
}

export interface CheckAndNotifyResult {
  /** Number of blocking changes considered (0 when degraded). */
  checked: number;
  /** Number of blocking changes for which at least one channel was attempted. */
  notified: number;
  /** True when the gate read was degraded; no notifications were sent. */
  degraded: boolean;
  /** Detail of the degrade, when degraded. */
  degradedDetail?: string;
  /** Count of channel/persist failures across the run (observability). */
  failures: number;
  /**
   * True when we could NOT read the dedupe ledger, so we sent NOTHING this run
   * (fail-closed for noise). Surfaced so a monitor sees the deliberate silence.
   */
  dedupeUnavailable: boolean;
  /**
   * Eligible changes that crossed the threshold + a notifiable state but were
   * NOT sent this run because the per-run cap was hit. Always 0 in normal runs;
   * the in-app page still lists them, so no data is lost.
   */
  suppressed: number;
}

/**
 * Build the plain-language message body shared by both channels. Never echoes a
 * GitHub enum - `change.reason` is already the operator-facing plain string the
 * gate produced.
 */
export function blockedMessage(change: BlockingChange): string {
  return (
    `PR #${change.number} is blocking production: ${change.reason}. ` +
    `Promote or approve: ${change.url}`
  );
}

/**
 * Has this exact (pr_number, state) already been notified inside the cooldown
 * window? A state CHANGE is NOT deduped - it is a new notifiable event.
 */
function alreadyNotified(
  change: BlockingChange,
  recent: NotifRecord[],
  nowMs: number,
  cooldownMs: number,
): boolean {
  return recent.some(
    (r) =>
      r.prNumber === change.number &&
      r.state === change.state &&
      nowMs - r.notifiedAtMs < cooldownMs,
  );
}

/**
 * The core sweep. Reads the gate; for every blocking change past the threshold
 * that has NOT been notified for its current state within the cooldown, sends
 * in-app + email to the responsible person, records the dedupe row, and fires
 * the analytics events.
 *
 * Returns a summary; NEVER throws (best-effort per channel, per change).
 */
export async function checkAndNotify(
  deps: CheckAndNotifyDeps,
): Promise<CheckAndNotifyResult> {
  const nowMs = deps.now();
  const thresholdHours = deps.thresholdHours ?? DEFAULT_THRESHOLD_HOURS;
  const cooldownMs = (deps.cooldownHours ?? DEFAULT_COOLDOWN_HOURS) * 3_600_000;
  const maxNotify = deps.maxNotifyPerRun ?? MAX_NOTIFY_PER_RUN;
  const emailEnabled = deps.emailEnabled === true;

  let gate: ReleaseGateStatus;
  try {
    gate = await deps.getReleaseGate();
  } catch (err) {
    // A throw from the gate read is itself a degrade - we could NOT check, so we
    // must NOT claim all-clear. Surface the observable degraded signal and bail.
    const detail = `Release-gate read threw: ${(err as Error).message}`;
    return degrade(detail);
  }

  // HONEST DEGRADE: an empty blocking list under `degraded` means "could not
  // check", NOT "nothing blocking". Send nothing, surface the degrade.
  if (gate.degraded) {
    return degrade(gate.degraded.detail);
  }

  // FAIL CLOSED FOR NOISE: if we cannot read the dedupe ledger we cannot verify
  // what we already sent, so we send NOTHING this run rather than risk
  // re-notifying every change on every tick (the observed spam loop). Missing a
  // ping is the lesser evil; the in-app page still lists every block.
  const recent = await listRecentOrNull(deps);
  if (recent === null) {
    return {
      checked: gate.blocking.length,
      notified: 0,
      degraded: false,
      failures: 0,
      dedupeUnavailable: true,
      suppressed: 0,
    };
  }

  // Eligible = past threshold, in a USER-ACTIONABLE state, and not already
  // notified for this (pr, state) inside the cooldown. checks_running /
  // checks_failing / merge_conflict are the author's dev workflow - skipped
  // (still counted in `checked`, never notified). Oldest-first so the per-run
  // cap pings the most-stalled changes when many are open at once.
  const eligible = gate.blocking
    .filter((change) => {
      if (change.ageHours < thresholdHours) return false;
      if (!NOTIFIABLE_STATES.has(change.state)) return false;
      if (alreadyNotified(change, recent, nowMs, cooldownMs)) return false;
      return true;
    })
    .sort((a, b) => b.ageHours - a.ageHours);

  const toNotify = eligible.slice(0, maxNotify);
  const suppressed = eligible.length - toNotify.length;
  if (suppressed > 0) {
    console.warn(
      `[release-gate-notify] per-run cap ${maxNotify} hit: notifying ${toNotify.length}, ` +
        `suppressing ${suppressed} eligible change(s) this run (still visible in-app).`,
    );
  }

  let notified = 0;
  let failures = 0;

  for (const change of toNotify) {
    // Always emit the detection signal so the learning loop sees every
    // threshold-crossing notifiable block, even if a later send fails.
    safeTrack(deps, "deploy.release_blocked_detected", {
      pr_number: change.number,
      state: change.state,
      reason: change.reason,
      age_hours: change.ageHours,
    });

    // Best-effort per channel: a failure on one MUST NOT stop the other, and
    // MUST be observable (logged + counted).
    const inAppOk = await tryChannel(
      () => deps.sendInApp(change),
      `in-app PR #${change.number}`,
    );
    if (inAppOk) {
      safeTrack(deps, "deploy.release_unblock_notified", {
        pr_number: change.number,
        channel: "in_app" satisfies NotifyChannel,
        age_hours: change.ageHours,
      });
    } else {
      failures += 1;
    }

    // EMAIL OFF BY DEFAULT: only attempt the loud, bounce-prone email channel
    // when it is explicitly enabled. The default run is in-app only.
    let emailOk = false;
    if (emailEnabled) {
      emailOk = await tryChannel(
        () => deps.sendEmail(change),
        `email PR #${change.number}`,
      );
      if (emailOk) {
        safeTrack(deps, "deploy.release_unblock_notified", {
          pr_number: change.number,
          channel: "email" satisfies NotifyChannel,
          age_hours: change.ageHours,
        });
      } else {
        failures += 1;
      }
    }

    // Record the dedupe row whenever a channel was ATTEMPTED for this (pr,
    // state) - regardless of delivery success. A bouncing/failing channel must
    // NOT loop: recording on attempt stops the re-send-every-tick spam. A
    // genuine state CHANGE re-fires (new dedupe key) and the in-app surface
    // still shows the block, so a single missed delivery is covered. (In-app is
    // always attempted above, so a channel was always attempted here.) The
    // persist itself is best-effort + observable.
    const persistOk = await tryChannel(
      () =>
        deps.recordNotif({
          prNumber: change.number,
          state: change.state,
          notifiedAtMs: nowMs,
        }),
      `persist dedupe PR #${change.number}`,
    );
    if (!persistOk) failures += 1;

    if (inAppOk || emailOk) notified += 1;
  }

  return {
    checked: gate.blocking.length,
    notified,
    degraded: false,
    failures,
    dedupeUnavailable: false,
    suppressed,
  };
}

/**
 * Honest-degrade exit. We could NOT determine the gate, so we send NOTHING (a
 * false all-clear is the lie that ships a broken deploy) and make the silence
 * observable: a logged degraded signal + a `degraded: true` summary the cron
 * route surfaces and a monitor can alert on.
 */
function degrade(detail: string): CheckAndNotifyResult {
  console.error("[release-gate-notify] DEGRADED, not notifying:", detail);
  return {
    checked: 0,
    notified: 0,
    degraded: true,
    degradedDetail: detail,
    failures: 0,
    dedupeUnavailable: false,
    suppressed: 0,
  };
}

/** Run a channel, swallow + log + report any throw. Returns delivered-ok. */
async function tryChannel(fn: () => Promise<void>, label: string): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[release-gate-notify] ${label} failed:`, (err as Error).message);
    return false;
  }
}

/** Tracking must never throw out of the sweep. */
function safeTrack(
  deps: CheckAndNotifyDeps,
  type: InstinctEventType,
  payload: Record<string, string | number | boolean>,
): void {
  try {
    deps.track(type, "cron", "system", payload);
  } catch (err) {
    console.error("[release-gate-notify] track failed:", (err as Error).message);
  }
}

/**
 * Read the dedupe ledger. Returns `null` on failure - NOT an empty list. A null
 * signals the caller to FAIL CLOSED FOR NOISE: when we cannot read what we
 * already sent we send NOTHING this run, rather than treating "unknown" as
 * "nothing sent yet" and re-notifying every change on every tick (the spam
 * loop). The failure is logged so the deliberate silence is observable; the
 * caller also surfaces it as `dedupeUnavailable` in the result.
 */
async function listRecentOrNull(deps: CheckAndNotifyDeps): Promise<NotifRecord[] | null> {
  try {
    return await deps.listRecentNotifs();
  } catch (err) {
    console.error(
      "[release-gate-notify] listRecentNotifs failed - failing CLOSED, sending nothing this run:",
      (err as Error).message,
    );
    return null;
  }
}
