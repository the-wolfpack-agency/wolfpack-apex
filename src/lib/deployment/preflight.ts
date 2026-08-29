/**
 * Is this deployment ready to hand to a client?
 *
 * WHY A CHECKLIST AND NOT A JUDGEMENT
 *
 * Everything verified today was verified against OUR instance, with our
 * documents, our connectors and an account that has existed for months. A fresh
 * client deployment shares none of that, and the failures it will hit are the
 * ones nobody sees because our instance has long since passed them.
 *
 * So the checks are ordered by what BLOCKS what. An instance with no database
 * cannot have a corpus; one with no corpus cannot answer a document question;
 * one whose deploy has not propagated is being tested in the wrong place
 * entirely. Reporting those as three independent failures sends somebody
 * chasing the last one first.
 *
 * EMPTY IS NOT BROKEN, AND THAT DISTINCTION IS MOST OF THE VALUE. A new
 * deployment with no documents is working correctly and is not ready. A
 * deployment that HAS documents and cannot retrieve them is broken. Those need
 * completely different responses and look identical in a pass/fail column, so
 * every check reports which it is.
 */

export type CheckState =
  /** Ready. */
  | "ok"
  /** Working correctly, and something has to be supplied before it is useful. */
  | "needs_setup"
  /** Something is wrong that setup will not fix. */
  | "broken"
  /** Could not be determined. Never reported as ok. */
  | "unknown";

export interface Check {
  id: string;
  /** What this proves, in the words somebody would use to ask for it. */
  proves: string;
  state: CheckState;
  detail: string;
  /**
   * Checks that cannot be trusted until this one is ok.
   *
   * Ordering is the point: an instance with no database cannot have a corpus,
   * so reporting both failures side by side buries the one that matters.
   */
  blocks: string[];
}

export interface Preflight {
  checks: Check[];
  /** True only when nothing is broken AND nothing is unknown. */
  readyToHandOver: boolean;
  /** What has to happen next, in order. Empty when ready. */
  todo: string[];
}

/** Ordered worst-first: broken before unknown before needs_setup. */
const SEVERITY: Record<CheckState, number> = {
  broken: 0,
  unknown: 1,
  needs_setup: 2,
  ok: 3,
};

/**
 * Decide readiness and what to do next.
 *
 * Pure, so the ordering logic is testable without standing up a deployment,
 * which is the part most likely to be wrong and the part hardest to check by
 * hand.
 */
export function assessPreflight(checks: Check[]): Preflight {
  const byId = new Map(checks.map((c) => [c.id, c]));

  /* A check whose blocker is not ok is REPORTED but not counted against
     readiness: it could not have passed, and listing it as its own failure is
     how one root cause becomes five tickets. */
  const isBlocked = (c: Check): boolean =>
    checks.some((other) => other.blocks.includes(c.id) && other.state !== "ok");

  const actionable = checks.filter((c) => !isBlocked(c));
  const ready = actionable.every((c) => c.state === "ok");

  const todo = [...actionable]
    .filter((c) => c.state !== "ok")
    .sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state])
    .map((c) => `${c.proves}: ${c.detail}`);

  /* Anything blocked is added AFTER, so the list reads in the order somebody
     should work it rather than in the order the checks happened to run. */
  const blocked = checks
    .filter((c) => isBlocked(c) && c.state !== "ok")
    .map((c) => `(after the above) ${c.proves}: ${c.detail}`);

  void byId;
  return { checks, readyToHandOver: ready, todo: [...todo, ...blocked] };
}

/** The report as lines somebody can paste into a handover note. */
export function describePreflight(p: Preflight): string[] {
  const mark: Record<CheckState, string> = {
    ok: "ok  ",
    needs_setup: "todo",
    broken: "FAIL",
    unknown: "??  ",
  };
  const lines = p.checks.map((c) => `  ${mark[c.state]}  ${c.proves} — ${c.detail}`);
  lines.push("");
  lines.push(
    p.readyToHandOver
      ? "  Ready to hand over."
      : "  Not ready. In order:",
  );
  for (const t of p.todo) lines.push(`    - ${t}`);
  return lines;
}
