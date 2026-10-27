/**
 * Forcefield for the Web - posture: turn a classification into an action, gated
 * by how much the site trusts the system to act.
 *
 * WATCH-FIRST, BY DESIGN. A new site starts in "monitor": the system watches and
 * reports, and NEVER blocks. You see your agent traffic and where the risks are
 * before anything is turned away. Only after that watching has earned trust do
 * you graduate to "enforce" - and even then, the ONLY thing hard-blocked at the
 * page level is a decoy trip (high-confidence). A weak "suspicious" hint is
 * always report-only, because a page-level signal is not proof, and the real
 * hard enforcement for a determined attacker belongs at the network edge with
 * these signals feeding it. The difference between watched, reported, and
 * actively blocked is stated plainly and never blurred.
 *
 * This mirrors OGIAM's own monitor -> enforce graduation, so the mental model is
 * the same across the platform.
 */

import type { WebVerdict } from "./classify";

export type WebPosture = "monitor" | "enforce";

export type WebAction =
  | "allow" // a normal visitor: nothing to do
  | "welcome" // a known good agent: give it the documented, trusted path
  | "report" // record the signal for the dashboard; do NOT block
  | "block"; // turn the request away (only a decoy trip, only in enforce)

export interface WebPostureDecision {
  action: WebAction;
  /** True only when the request is actually turned away. */
  blocked: boolean;
  /** True when a signal is recorded to the dashboard (report or block). */
  recorded: boolean;
  reason: string;
}

/**
 * Decide what to do with a classified request under the site's posture.
 * Deterministic. In monitor mode nothing is ever blocked; the strongest outcome
 * is "report". In enforce mode, ONLY a decoy trip escalates to "block".
 */
export function decideWebAction(verdict: WebVerdict, posture: WebPosture): WebPostureDecision {
  switch (verdict.class) {
    case "known_agent":
      return { action: "welcome", blocked: false, recorded: false, reason: verdict.reason };

    case "trapped": {
      // The one act-worthy signal. Blocked only once the site has graduated to
      // enforce; in monitor it is still just reported (watch-first).
      if (posture === "enforce") {
        return { action: "block", blocked: true, recorded: true, reason: `decoy trip: ${verdict.reason}` };
      }
      return {
        action: "report",
        blocked: false,
        recorded: true,
        reason: `decoy trip recorded (monitor mode - not blocked): ${verdict.reason}`,
      };
    }

    case "suspicious":
      // Weak page-level signal. Reported in BOTH postures, blocked in NEITHER.
      return { action: "report", blocked: false, recorded: true, reason: verdict.reason };

    case "normal":
    default:
      return { action: "allow", blocked: false, recorded: false, reason: verdict.reason };
  }
}
