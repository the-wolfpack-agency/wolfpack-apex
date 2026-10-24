/**
 * What the "AI red-team" actually is, stated once so every surface that shows
 * it (the /admin/ai-redteam page, the compliance crosswalk, the trust center)
 * says the same true thing.
 *
 * Today it is a FIXED REGRESSION SET: a constant list of literal agent actions
 * (corpus.ts) sent through the real OGIAM buildAction + decide() policy path.
 * It never calls a model, never mutates its inputs, and never discovers a new
 * attack, so a 100% pass rate means "the policy still blocks these N known
 * cases", not "the gate withstands red-teaming". It must not be labeled as
 * red-team coverage. A live adversarial adapter (prompt surface, indirect
 * injection against the router) would change `kind`; until one exists, nothing
 * may count this suite as adversarial-testing coverage.
 */
import { RED_TEAM_ATTACKS } from "./corpus";

export interface RedTeamSuiteDescriptor {
  kind: "fixed_regression" | "live_adversarial";
  /** Number of cases in the suite. */
  cases: number;
  /** Short label for a status line. */
  label: string;
  /** One-sentence plain description. */
  description: string;
  /** What the suite does NOT do (shown next to the pass rate). */
  limits: string;
}

export const RED_TEAM_SUITE: RedTeamSuiteDescriptor = {
  kind: "fixed_regression",
  cases: RED_TEAM_ATTACKS.length,
  label: `Fixed gate regression set (${RED_TEAM_ATTACKS.length} cases)`,
  description: `${RED_TEAM_ATTACKS.length} fixed, hand-written agent actions sent through the real OGIAM policy decide() path on a schedule.`,
  limits: "It never calls a model and never generates new attacks, so a pass means the policy still blocks these known cases. It is not red-team coverage.",
};
