/**
 * Red-team runner. Reuses the REAL gate path (buildAction + decide) so it proves
 * what the live gate would do, not a copy of the policy. An attack is "blocked"
 * when the gate's intended outcome is anything other than "allow" (deny,
 * escalate, or transform all neutralize it). An attack the gate allows is a vuln.
 *
 * Pure + offline: no DB, no network, no model. The deps are injectable so a test
 * can feed a deliberately-weakened decide() and prove the runner actually detects
 * a regression (the harness has teeth).
 */
import { buildAction } from "@/lib/ogiam/action";
import { decide } from "@/lib/ogiam/policy";
import { RED_TEAM_ATTACKS } from "./corpus";
import type { RedTeamAttack, RedTeamReport, RedTeamFinding } from "./types";

export interface RedTeamDeps {
  buildAction: typeof buildAction;
  decide: typeof decide;
}

const defaultDeps: RedTeamDeps = { buildAction, decide };

export function runRedTeam(
  attacks: RedTeamAttack[] = RED_TEAM_ATTACKS,
  deps: RedTeamDeps = defaultDeps,
): RedTeamReport {
  const vulns: RedTeamFinding[] = [];
  const byCategory: Record<string, { run: number; blocked: number }> = {};
  let blocked = 0;

  for (const attack of attacks) {
    const cat = (byCategory[attack.category] ??= { run: 0, blocked: 0 });
    cat.run += 1;

    const { action } = deps.buildAction(attack.input);
    const decision = deps.decide(action, { mode: "enforce" });
    const wasBlocked = decision.intendedOutcome !== "allow";

    if (wasBlocked) {
      blocked += 1;
      cat.blocked += 1;
    } else {
      vulns.push({
        attackId: attack.id,
        category: attack.category,
        technique: attack.technique,
        outcome: decision.intendedOutcome,
        ruleId: decision.ruleId,
      });
    }
  }

  return {
    attacksRun: attacks.length,
    blocked,
    vulns,
    passRate: attacks.length === 0 ? 1 : blocked / attacks.length,
    byCategory,
  };
}
