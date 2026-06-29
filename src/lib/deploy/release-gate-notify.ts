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
 *   module makes it LOUD: once a blocker crosses the age threshold we push an
 *   in-app notification + an email to the person who can clear it, then record a
 *   dedupe row so we say it ONCE per (pr, state) per cooldown window - not on
 *   every cron tick (the noise that trains people to ignore the channel).
 *
 * THREE NON-NEGOTIABLES
 *
 *   1. HONEST DEGRADE. If the gate read came back `degraded` we did NOT actually
 *      see the open PRs - the empty blocking list is "could not check", not
 *      "all clear". We MUST NOT send any notification (a false all-clear is the
 *      lie that lets a broken deploy ship) and MUST emit an observable degraded
 *      signal (analytics + log) so the silence is itself surfaced.
 *
 *   2. DEDUPE per (pr_number, state) per cooldown. A steady-state block stays
 *      quiet after the first ping; a genuine ESCALATION (state changed, e.g.
 *      checks_running -> checks_failing) is a new event and re-fires. Backed by
 *      migration 207's instinct_release_gate_notifications ledger (system-wide,
 *      recipient-independent - unlike the in-app notify() dedup which is
 *      per-user + resets on read).
 *
 *   3. BEST-EFFORT, OBSERVABLE delivery. A send/persist failure on one channel
 *      must NOT throw out of the cron (the other channel + the next PR still
 *      run) but MUST be observable: every failure is logged and the persist
 *      failure is reflected in the returned summary so a monitor can see it.
 *
 * Everything is dependency-injected so the unit tests run with zero network /
 * DB and a frozen clock. The route layer (src/app/api/cron/release-gate-check)
 * wires the real gate read, the real dedupe persistence, and the real in-app +
 * email senders (PR author + admins).
 */

import type {
  BlockingChange,
  ReleaseGateStatus,
  ReleaseGateDeps,
} from "@/lib/deploy/release-gate";
import type { InstinctEventType } from "@/lib/analytics";

/** Default: a change blocking prod for >= 30 min is worth a proactive ping. */
export const DEFAULT_THRESHOLD_HOURS = 0.5;

/** Default cooldown: do not re-notify the same (pr, state) within 6 hours. */
export const DEFAULT_COOLDOWN_HOURS = 6;

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
  /** Override the age threshold (hours). Defaults to DEFAULT_THRESHOLD_HOURS. */
  thresholdHours?: number;
  /** Override the re-notify cooldown (hours). Defaults to DEFAULT_COOLDOWN_HOURS. */
  cooldownHours?: number;
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

  const recent = await safeListRecent(deps);

  let notified = 0;
  let failures = 0;

  for (const change of gate.blocking) {
    // Under threshold: not yet worth a proactive ping. (ready_to_merge is still
    // a "blocker" in the gate's vocabulary - a promotable PR that nobody has
    // promoted is exactly the 19h stall - so it IS notified once it ages past
    // the threshold, same as any other state.)
    if (change.ageHours < thresholdHours) continue;

    // Deduped: same (pr, state) already pinged inside the cooldown. A state
    // change would NOT match and so re-fires (genuine escalation).
    if (alreadyNotified(change, recent, nowMs, cooldownMs)) continue;

    // Always emit the detection signal so the learning loop sees every
    // threshold-crossing block, even if a later send fails.
    safeTrack(deps, "deploy.release_blocked_detected", {
      pr_number: change.number,
      state: change.state,
      reason: change.reason,
      age_hours: change.ageHours,
    });

    // Best-effort per channel: a failure on one MUST NOT stop the other, and
    // MUST be observable (logged + counted).
    let anyChannelAttempted = false;

    const inAppOk = await tryChannel(
      () => deps.sendInApp(change),
      `in-app PR #${change.number}`,
    );
    anyChannelAttempted = true;
    if (inAppOk) {
      safeTrack(deps, "deploy.release_unblock_notified", {
        pr_number: change.number,
        channel: "in_app" satisfies NotifyChannel,
        age_hours: change.ageHours,
      });
    } else {
      failures += 1;
    }

    const emailOk = await tryChannel(
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

    // Record the dedupe row ONLY if at least one channel actually delivered.
    // If BOTH channels failed we deliberately do NOT record, so the next cron
    // tick retries rather than going silent on a block we never actually
    // surfaced. The persist itself is best-effort + observable.
    if (anyChannelAttempted && (inAppOk || emailOk)) {
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
    }

    if (inAppOk || emailOk) notified += 1;
  }

  return {
    checked: gate.blocking.length,
    notified,
    degraded: false,
    failures,
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
  return { checked: 0, notified: 0, degraded: true, degradedDetail: detail, failures: 0 };
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

/** Reading the dedupe ledger must never throw out of the sweep. */
async function safeListRecent(deps: CheckAndNotifyDeps): Promise<NotifRecord[]> {
  try {
    return await deps.listRecentNotifs();
  } catch (err) {
    // We could not read the dedupe ledger. Fail SAFE for noise: an empty list
    // means we may re-notify, but that is the lesser evil vs. going silent on a
    // real block. Log so it is observable.
    console.error("[release-gate-notify] listRecentNotifs failed:", (err as Error).message);
    return [];
  }
}
