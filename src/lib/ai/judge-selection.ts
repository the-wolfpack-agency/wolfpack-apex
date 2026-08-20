/**
 * WHO may check the work, and why it must not be a sibling.
 *
 * THE WEAKNESS THIS FIXES
 *
 * The judge shipped in #293 escalated one tier up, within whatever provider
 * selection had already landed on. On a deployment where Anthropic serves
 * everything, that means a Claude answer judged by Claude. That is not an
 * independent check, it is the same training distribution marking its own
 * homework, and it fails in the most expensive way available: quietly, by
 * agreeing.
 *
 * Models from one family do not collude, they CORRELATE, which produces the
 * same outcome and is harder to spot because it looks like confirmation. Two
 * models trained on overlapping data share blind spots, so the second one is
 * most likely to agree exactly where the first was most likely to be wrong.
 *
 * WHY NOT ROUND ROBIN
 *
 * Rotating to the next model gives cycling, not independence. A rotation of
 * Haiku, gpt-4o-mini, Haiku leaves a third of checks same-family, and which
 * third depends on where the pointer happens to be. The property wanted is not
 * "a different model each time", it is "a different LINEAGE from the one that
 * wrote the answer". That is a constraint rather than a rotation, it holds on
 * every call instead of on average, and it is what makes "checked by an
 * independent model" a claim an auditor can actually test.
 *
 * LINEAGE, NOT PROVIDER NAME
 *
 * Serving is not parentage. The same model family reaches us through more than
 * one door: gpt-4o comes from OpenAI directly and from Azure, and a compatible
 * endpoint can serve somebody else's weights entirely. Judging an Azure gpt-4o
 * answer with an OpenAI gpt-4o would pass a provider-name check and be exactly
 * the sibling review this module exists to prevent. So lineage is derived from
 * the model, and the provider is only the fallback when the model says nothing.
 *
 * IT FAILS LOUDLY, NOT QUIETLY
 *
 * When no independent lineage is configured, this returns null and the caller
 * records that the answer went UNCHECKED. Falling back to a sibling and calling
 * it a check would put a reassuring row in an audit log that means nothing,
 * which is worse than an honest gap: a gap gets fixed, and a false reassurance
 * gets cited.
 */

/** A family of models with shared parentage. Free string; only compared. */
export type Lineage = string;

export const LINEAGE_UNKNOWN = "unknown";

/**
 * Model-name patterns to lineage. Ordered, first match wins.
 *
 * Deliberately about the MODEL rather than the vendor serving it, so the same
 * weights reached through a different door still count as the same family.
 */
const MODEL_LINEAGE: ReadonlyArray<[RegExp, Lineage]> = [
  [/claude/i, "anthropic"],
  [/^(?:azure-)?(?:gpt|o[0-9]|chatgpt|davinci)/i, "openai"],
  [/gemini|palm|bison/i, "google"],
  [/llama/i, "meta"],
  [/mistral|mixtral|codestral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/qwen/i, "alibaba"],
  [/command-?r|cohere/i, "cohere"],
  [/grok/i, "xai"],
];

/**
 * Provider names to lineage, used ONLY when the model name says nothing.
 *
 * A provider that resells many families (an aggregator, a self-hosted server)
 * is deliberately absent: guessing "azure" as a lineage would treat Azure's
 * Llama and Azure's gpt-4o as siblings, which is false in the direction that
 * silently blocks a legitimate independent check.
 */
const PROVIDER_LINEAGE: Readonly<Record<string, Lineage>> = {
  anthropic: "anthropic",
  openai: "openai",
};

/** Which family produced this answer. */
export function lineageOf(input: { model?: string; provider?: string }): Lineage {
  const model = (input.model ?? "").trim();
  if (model) {
    for (const [pattern, lineage] of MODEL_LINEAGE) {
      if (pattern.test(model)) return lineage;
    }
  }
  const provider = (input.provider ?? "").trim().toLowerCase();
  return PROVIDER_LINEAGE[provider] ?? LINEAGE_UNKNOWN;
}

export interface JudgeCandidate {
  /** Provider name, as the router knows it. */
  provider: string;
  /** The model this candidate would use, when known. */
  model?: string;
}

export interface JudgeChoice {
  candidate: JudgeCandidate | null;
  /** The lineage that wrote the answer. */
  authorLineage: Lineage;
  /** The lineage that would check it, when one was found. */
  judgeLineage: Lineage | null;
  /** Why, for the analytics row and the audit record. */
  reason:
    | "independent"
    | "no_independent_lineage_configured"
    | "author_lineage_unknown";
}

/**
 * Choose a judge whose lineage differs from the author's.
 *
 * Pure, so the rule is readable and testable without providers or a network.
 *
 * An author of UNKNOWN lineage is refused rather than judged. "Unknown" is not
 * a family, so it cannot be shown to differ from anything, and a check that
 * cannot demonstrate independence must not be recorded as one. The fix is to
 * teach this module the model name, which is a one-line change here.
 */
export function chooseIndependentJudge(
  author: JudgeCandidate,
  candidates: readonly JudgeCandidate[],
): JudgeChoice {
  const authorLineage = lineageOf(author);
  if (authorLineage === LINEAGE_UNKNOWN) {
    return {
      candidate: null,
      authorLineage,
      judgeLineage: null,
      reason: "author_lineage_unknown",
    };
  }

  for (const candidate of candidates) {
    const lineage = lineageOf(candidate);
    if (lineage === LINEAGE_UNKNOWN) continue;
    if (lineage !== authorLineage) {
      return { candidate, authorLineage, judgeLineage: lineage, reason: "independent" };
    }
  }

  return {
    candidate: null,
    authorLineage,
    judgeLineage: null,
    reason: "no_independent_lineage_configured",
  };
}
