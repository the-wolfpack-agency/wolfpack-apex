/**
 * What a task brief left unsaid, and the question that would have settled it.
 *
 * WHERE THIS CAME FROM
 *
 * An operator finished a piece of work and asked: "what could I have asked in a
 * more effective manner?" That question is worth answering mechanically, because
 * the answer is almost never "write more". Every expensive round trip in a task
 * traces back to one of a small number of facts the brief did not carry, and the
 * same handful recur: where it has to work, how you will know it worked, what
 * must not change, what already exists that should be reused.
 *
 * So this reads a brief and reports which of those are missing, each with the
 * one question that would have supplied it.
 *
 * IT MUST BE ABLE TO SAY NOTHING IS WRONG
 *
 * The failure mode of every writing checker is that it always finds something.
 * A reviewer that fires on every input is a reviewer nobody reads, and it would
 * make a well-written brief feel as bad as a careless one. A brief that names
 * its target, its done condition and its boundary scores clean, and there is a
 * test that holds that line.
 *
 * IT IS DETERMINISTIC ON PURPOSE
 *
 * No model call. The dimensions below are the ones that actually cost time in
 * this codebase, and a rule that can be read, argued with and unit-tested is
 * worth more here than a fluent opinion that varies run to run. It also means
 * it is free, so it can run on every agent goal rather than on the ones someone
 * remembered to check.
 *
 * IT REVIEWS THE BRIEF, NOT THE PERSON
 *
 * Every finding names a missing FACT and the question that supplies it. None of
 * them say the brief is bad. A brief is a handoff, and a handoff missing a
 * detail is normal.
 */

export type Dimension =
  | "done-condition"
  | "environment"
  | "scope-boundary"
  | "reuse"
  | "output-shape"
  | "sequencing"
  | "blocking-input";

export interface Finding {
  dimension: Dimension;
  /** What was not stated. */
  missing: string;
  /** The single question that would have supplied it. */
  ask: string;
  /** What it costs when it is absent, in this codebase, concretely. */
  cost: string;
}

export interface PromptReview {
  findings: Finding[];
  /** A rewrite of the brief with a line per missing fact appended as a prompt
   *  to fill in. Never invents an answer: it asks. */
  suggested: string;
  headline: string;
}

/** One rule. `satisfied` returns true when the brief already carries the fact. */
interface Rule extends Omit<Finding, never> {
  satisfied: (text: string) => boolean;
}

const has = (...patterns: RegExp[]) => (text: string) => patterns.some((p) => p.test(text));

const RULES: Rule[] = [
  {
    dimension: "done-condition",
    missing: "how you would know it worked",
    ask: "What would you check to accept this? Name the screen, the command or the assertion.",
    cost: "Without it, work is reported as done on the evidence that happens to be to hand, which is usually a passing unit test rather than the thing you would have looked at.",
    satisfied: has(
      /\b(verif|accept|prove|proof|assert|confirm)\w*\b/i,
      /\bhow (?:I|we|you)('| a)?ll? know\b/i,
      /\b(test|tests|tested|coverage|e2e|end.to.end)\b/i,
      /\bdefinition of done\b/i,
    ),
  },
  {
    dimension: "environment",
    missing: "where it has to work",
    ask: "Does this have to work on the deployed URL, or is local enough? Which URL?",
    cost: "Local green and production green are different claims. Naming the URL is the difference between a fix and a fix that is live.",
    satisfied: has(
      /https?:\/\//i,
      /\b(production|prod|deployed|live|staging|preview|localhost|local)\b/i,
      /\.(?:com|dev|app|io|vercel\.app)\b/i,
    ),
  },
  {
    dimension: "scope-boundary",
    missing: "what must not change",
    ask: "What is out of scope, or must not be touched?",
    cost: "An unbounded brief gets an interpretation. That is how a small ask returns as a redesign, and how a surface you were about to demo moves under you.",
    satisfied: has(
      /\b(only|just|do not|don't|avoid|without|leave|keep|unchanged|untouched|out of scope|nothing else)\b/i,
      /\bnot? (?:a )?(?:refactor|redesign|rewrite)\b/i,
    ),
  },
  {
    dimension: "reuse",
    missing: "what already exists that should be reused",
    ask: "Is there an existing file, script or surface this should build on rather than duplicate?",
    cost: "This repo already carries two comparison engines and two routers because a brief did not name the one that existed. Naming it is cheaper than finding the duplicate later.",
    satisfied: has(
      /\b(reuse|existing|already|extend|build on|same as|like the|instead of (?:building|creating))\b/i,
      /\bsrc\/|\.tsx?\b|\bnpm run\b|\bscripts\//i,
    ),
  },
  {
    dimension: "output-shape",
    missing: "where the result should land",
    ask: "Where does the result go: a PR, a page in the product, a document, a message?",
    cost: "The work gets done and then has to be moved. Saying it up front usually changes how it is built, not just where it is put.",
    satisfied: has(
      /\b(pr|pull request|commit|push|branch|merge)\b/i,
      /\b(page|route|dashboard|report|doc|document|wiki|email|artifact|script|cli)\b/i,
    ),
  },
  {
    dimension: "sequencing",
    missing: "whether the parts are ordered",
    ask: "Do these need to happen in order, or can they run in parallel?",
    cost: "Independent work run in sequence wastes time; dependent work run in parallel produces a merge conflict or a half-built feature.",
    // Only asked of a brief that actually has several parts.
    satisfied: has(
      /\b(first|then|once|after|before|finally|next|order|sequence|in parallel|simultaneous\w*|at the same time|blocked by|depends on)\b/i,
    ),
  },
  {
    dimension: "blocking-input",
    missing: "what it needs from you that it cannot get itself",
    ask: "Is there a credential, an environment variable or an approval this needs, and where does it come from?",
    cost: "The work reaches the thing it cannot do and stops. Naming it means it is ready when the work gets there, rather than a round trip after.",
    satisfied: has(
      /\b(credential|key|keys|token|secret|env|environment variable|access|permission|approval|account|login)\b/i,
      // "the keys are already set" answers the question as completely as
      // "I will provide a key" does. The first version only matched the offer
      // and flagged a brief that had already settled it, which is the checker
      // firing on a fact it was given.
      /\b(?:already|are|is) (?:set|configured|provisioned|in place)\b/i,
      /\bI(?:'ll| will) (?:provide|set|configure|add)\b/i,
    ),
  },
];

/** A brief with a single ask does not need a sequencing plan, and asking for one
 *  would be the checker inventing work. Counted from the shapes people actually
 *  use to join tasks together. */
function partCount(text: string): number {
  const bullets = (text.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/g) ?? []).length;
  const joiners = (text.match(/\b(?:also|then|additionally|as well as|and then|once complete)\b/gi) ?? []).length;
  // Sentence count is deliberately NOT a signal. The first version treated more
  // than three sentences as multi-part, which flagged a single task described
  // carefully - the one brief in the set that needed no help at all. A reviewer
  // that penalises detail teaches people to write less, which is the opposite
  // of what it is for. Bullets and explicit joiners are what actually mark a
  // brief as carrying several asks.
  return Math.max(bullets, joiners + 1);
}

export function reviewPrompt(text: string): PromptReview {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return {
      findings: [],
      suggested: "",
      headline: "There is nothing to review.",
    };
  }

  const multipart = partCount(trimmed) > 1;

  const findings = RULES.filter((r) => {
    if (r.dimension === "sequencing" && !multipart) return false;
    return !r.satisfied(trimmed);
  }).map(({ satisfied: _satisfied, ...f }) => f);

  const headline =
    findings.length === 0
      ? "This brief carries everything the work needs. Nothing to add."
      : `${findings.length} thing${findings.length === 1 ? "" : "s"} the work will have to guess at: ${findings
          .map((f) => f.missing)
          .join("; ")}.`;

  // The suggestion APPENDS questions rather than rewriting the brief. Rewriting
  // it would mean inventing the answers, and a confident wrong assumption
  // written back in the operator's own voice is worse than the omission.
  const suggested =
    findings.length === 0
      ? trimmed
      : `${trimmed}\n\n${findings.map((f) => `- ${f.ask}`).join("\n")}`;

  return { findings, suggested, headline };
}
