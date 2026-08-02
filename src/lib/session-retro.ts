/**
 * Session retrospective: turning "that took four rounds" into a reusable ask.
 *
 * WHY THIS EXISTS
 *
 * The operator asked, after a session that took several rounds: "what could I
 * have asked in a more effective manner?" That is the right question, and
 * asking it once produces one insight. Asking it every session, in a fixed
 * shape, produces a pattern — and a pattern is something the next session can
 * be handed instead of discovering again.
 *
 * The failure this addresses is not sloppy prompting. It is that a request and
 * the work it implies are written at different altitudes: an operator states an
 * outcome, and an agent needs the outcome PLUS the constraints that are obvious
 * to the person and invisible to the agent. Every extra round is one of those
 * constraints arriving late.
 *
 * So the taxonomy below is deliberately about MISSING INFORMATION rather than
 * about phrasing. "Be clearer" is not actionable. "You did not say which repo,
 * and I guessed wrong" is.
 *
 * Pure: no filesystem, no clock, no network. The scaffold script supplies the
 * facts and this decides what they mean, so every rule here is unit tested.
 */

/**
 * Why a session needed more rounds than it should have.
 *
 * Each cause names information that existed in the operator's head and not in
 * the request. The `ask` field is the sentence that would have carried it.
 */
export type FrictionCause =
  | "unstated-target"
  | "unstated-constraint"
  | "unstated-done"
  | "assumed-context"
  | "scope-discovered"
  | "directive-echo"
  | "agent-error";

export interface FrictionTaxonomyEntry {
  cause: FrictionCause;
  /** What was missing, in the operator's terms. */
  meaning: string;
  /** The sentence that would have carried it. */
  ask: string;
  /** True when the round was the agent's fault, not the request's. */
  agentFault: boolean;
}

export const FRICTION_TAXONOMY: readonly FrictionTaxonomyEntry[] = [
  {
    cause: "unstated-target",
    meaning: "which repo, branch, environment or surface the work applies to",
    ask: "Name the repo and branch in the first sentence.",
    agentFault: false,
  },
  {
    cause: "unstated-constraint",
    meaning: "a rule that was going to be applied anyway, but only after it was broken",
    ask: "State the constraint up front rather than as a correction.",
    agentFault: false,
  },
  {
    cause: "unstated-done",
    meaning: "what finished looks like, so the work stopped in the wrong place",
    ask: "Say what you will check to decide it is done.",
    agentFault: false,
  },
  {
    cause: "assumed-context",
    meaning: "a fact known to the operator that the agent could not see",
    ask: "Paste the fact, or say where to find it.",
    agentFault: false,
  },
  {
    cause: "scope-discovered",
    meaning: "the work grew because the codebase turned out to be different than expected",
    ask: "Nothing. This is the good kind of round — the discovery was the value.",
    agentFault: false,
  },
  {
    cause: "directive-echo",
    meaning:
      "the request restated standing rules that are already loaded automatically every session, which costs tokens without changing behaviour",
    ask: "State only what is DIFFERENT about this task. The standing directives are already in context.",
    agentFault: false,
  },
  {
    cause: "agent-error",
    meaning: "the agent shipped something wrong, or did not verify before handing over",
    ask: "Nothing. This one is on the agent, and belongs in a guardrail, not a better prompt.",
    agentFault: true,
  },
];

export interface RetroInput {
  /** What the operator asked for, in their words. */
  ask: string;
  /** Number of operator messages it took to reach done. */
  rounds: number;
  /** Why each extra round happened. One entry per avoidable round. */
  causes: FrictionCause[];
  /** Optional: the sentence that would have collapsed the rounds. */
  betterAsk?: string;
}

export interface RetroFinding {
  /** Rounds that better information would have removed. */
  avoidableRounds: number;
  /** Rounds caused by the agent, which a better prompt cannot fix. */
  agentRounds: number;
  /** Rounds that were discovery, which are not waste. */
  discoveryRounds: number;
  /** Distinct asks that would have helped, deduplicated, in taxonomy order. */
  suggestions: string[];
  /** One line for the handoff doc. */
  headline: string;
}

const entryFor = (cause: FrictionCause): FrictionTaxonomyEntry =>
  FRICTION_TAXONOMY.find((e) => e.cause === cause) as FrictionTaxonomyEntry;

/**
 * Read a session's friction and say what would have shortened it.
 *
 * The split matters more than the total. A session that took five rounds
 * because the agent kept shipping bugs is not a prompting problem, and telling
 * the operator to write better requests would be both wrong and rude. Only
 * `agentFault: false` causes produce a suggestion.
 */
export function analyzeRetro(input: RetroInput): RetroFinding {
  const entries = input.causes.map(entryFor);
  const agentRounds = entries.filter((e) => e.agentFault).length;
  const discoveryRounds = entries.filter((e) => e.cause === "scope-discovered").length;
  const avoidableRounds = entries.length - agentRounds - discoveryRounds;

  // Taxonomy order, not first-seen order, so repeated sessions produce a stable
  // list an operator can recognise at a glance.
  const suggestions = FRICTION_TAXONOMY.filter(
    (e) => !e.agentFault && e.cause !== "scope-discovered" && input.causes.includes(e.cause),
  ).map((e) => e.ask);

  let headline: string;
  if (input.rounds <= 1) {
    headline = "One round. Nothing to change.";
  } else if (avoidableRounds === 0 && agentRounds > 0) {
    headline = `${input.rounds} rounds, ${agentRounds} caused by the agent. Not a prompting problem — those belong in guardrails.`;
  } else if (avoidableRounds === 0) {
    headline = `${input.rounds} rounds, all of them discovery. The extra rounds were the value.`;
  } else {
    headline = `${input.rounds} rounds, ${avoidableRounds} avoidable with information stated up front.`;
  }

  return { avoidableRounds, agentRounds, discoveryRounds, suggestions, headline };
}

/**
 * Aggregate across sessions. The single-session insight is worth little; the
 * recurring one is worth changing a habit for, and is the only honest basis for
 * telling an operator that something in their asks is costing them time.
 */
export function recurringCauses(history: RetroInput[], minOccurrences = 2): { cause: FrictionCause; count: number; ask: string }[] {
  const counts = new Map<FrictionCause, number>();
  for (const session of history) {
    // Once per session, not once per round: a session where one missing fact
    // caused three rounds is one habit, not three.
    for (const cause of new Set(session.causes)) counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([cause, count]) => count >= minOccurrences && !entryFor(cause).agentFault)
    .sort((a, b) => b[1] - a[1])
    .map(([cause, count]) => ({ cause, count, ask: entryFor(cause).ask }));
}

/** The handoff-doc section. Written here so the script stays IO-only. */
export function renderRetroSection(input: RetroInput, finding: RetroFinding): string {
  const lines = [
    "## Prompt retrospective",
    "",
    "Filled in at session end, every session. The point is the pattern across",
    "sessions, not the score of any one of them.",
    "",
    `**The ask:** ${input.ask}`,
    `**Rounds:** ${input.rounds}`,
    `**Verdict:** ${finding.headline}`,
    "",
  ];
  if (finding.suggestions.length > 0) {
    lines.push("**What would have collapsed the rounds:**", "");
    for (const s of finding.suggestions) lines.push(`- ${s}`);
    lines.push("");
  }
  if (finding.agentRounds > 0) {
    lines.push(
      `**Not the operator's to fix:** ${finding.agentRounds} round(s) came from agent error. Each one should leave behind a guardrail, not a better prompt.`,
      "",
    );
  }
  if (input.betterAsk) {
    lines.push("**The one-shot version of this request:**", "", "> " + input.betterAsk, "");
  }
  return lines.join("\n");
}
