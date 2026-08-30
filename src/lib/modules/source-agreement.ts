/**
 * When several systems hold the same fact, answer from one and say when they
 * disagree.
 *
 * THE DECISION THIS ENCODES, MADE BEFORE DMS AND CRM LAND
 *
 * Phase 1 has one source, so "which source" has never been a question. With
 * SharePoint, a CRM and one or more DMS connected, a client's information sits
 * in all of them and the same fact is usually stated differently in each: the
 * CRM has a deal value, the DMS has an order, the contract has the terms.
 *
 * There are two ways to answer that and only one of them survives contact with
 * a client.
 *
 * MERGING loses provenance. An answer synthesised from three systems cannot be
 * cited, and a number a person cannot trace is a number they will not act on.
 * It also hides the interesting case: averaging $12,000 and $12,480 produces a
 * figure that is in neither system.
 *
 * SO: ANSWER FROM ONE SOURCE, CITE IT, AND REPORT DISAGREEMENT SEPARATELY.
 *
 * Disagreement is a FINDING, not a failure to resolve. "The CRM says $12,000
 * and the work order says $12,480" is frequently the most valuable sentence
 * the product can produce, and every design that quietly picks a winner
 * destroys it. A client whose systems disagree needs to know that more than
 * they need a confident single number.
 *
 * WHAT THIS IS NOT. It does not decide which system is authoritative. That is a
 * business rule, it differs per client and per field, and a product that
 * guesses at it will be wrong expensively. It reports what each says and lets
 * the reader, or a configured rule, decide.
 */

/** Where a candidate answer came from. Extends as modules land. */
export type SourceId = "documents" | "crm" | "dms" | "financials";

export interface SourceAnswer {
  source: SourceId;
  /** What that system says, as a person would read it. */
  value: string;
  /** How strongly retrieval backed it, on that source's own scale. */
  confidence: number;
  /** What to cite: a filename, a record id, a URL. */
  citation: string;
}

export type Agreement =
  /** Only one system holds this. Ordinary, and not a weakness. */
  | "single_source"
  /** Several systems, same answer. The strongest signal available. */
  | "corroborated"
  /** Several systems, different answers. A finding in its own right. */
  | "conflicting";

export interface Resolution {
  agreement: Agreement;
  /** The answer to give, from ONE source, so it can be cited. */
  answer: SourceAnswer;
  /** Every source that agreed, including the chosen one. */
  agreedWith: SourceId[];
  /** Sources that said something materially different. Never dropped. */
  conflicts: SourceAnswer[];
}

/**
 * Do two answers mean the same thing?
 *
 * Deliberately crude and deliberately CONSERVATIVE about declaring a conflict.
 * "$12,000" and "12000 USD" are the same fact wearing different punctuation,
 * and reporting those as a disagreement would train people to ignore the
 * warning that matters. Anything this cannot confidently call equal is treated
 * as equal, because a false conflict is worse than a missed one: the first
 * destroys trust in every future conflict, the second is caught by the reader.
 */
export function saysTheSame(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      /* Currency, thousands separators and trailing zeros are formatting, not
         meaning: $12,000.00 and 12000 are one number. */
      .replace(/[$£€,]/g, "")
      .replace(/(\d)\.00\b/g, "$1")
      .replace(/[^a-z0-9.]+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/**
 * Choose one answer and report what the others said.
 *
 * The chosen answer is the most confident, NOT a merge. Confidence is only
 * comparable within a source, so this is a tie-break among candidates that
 * already passed their own retriever's bar, never a cross-source score.
 */
export function resolveAcrossSources(answers: SourceAnswer[]): Resolution | null {
  if (answers.length === 0) return null;

  const ranked = [...answers].sort(
    (a, b) => b.confidence - a.confidence || a.source.localeCompare(b.source),
  );
  const chosen = ranked[0]!;

  const agreedWith = ranked.filter((a) => saysTheSame(a.value, chosen.value)).map((a) => a.source);
  const conflicts = ranked.filter((a) => !saysTheSame(a.value, chosen.value));

  return {
    agreement:
      conflicts.length > 0 ? "conflicting" : agreedWith.length > 1 ? "corroborated" : "single_source",
    answer: chosen,
    agreedWith,
    conflicts,
  };
}

/**
 * The sentence a person reads.
 *
 * Corroboration is stated because it is genuinely reassuring and costs one
 * clause. A conflict is stated in full, with both figures and both sources,
 * because a reader cannot act on "sources disagree" without knowing how.
 */
export function describeAgreement(r: Resolution): string {
  const label: Record<SourceId, string> = {
    documents: "your documents",
    crm: "the CRM",
    dms: "the DMS",
    financials: "the financials",
  };

  if (r.agreement === "single_source") return `From ${label[r.answer.source]}: ${r.answer.citation}.`;

  if (r.agreement === "corroborated") {
    const others = r.agreedWith.filter((s) => s !== r.answer.source).map((s) => label[s]);
    return `From ${label[r.answer.source]} (${r.answer.citation}), and ${others.join(" and ")} agree.`;
  }

  /* NAMES BOTH FIGURES. "Your systems disagree" without the numbers is a
     warning nobody can act on, and it sends somebody to check by hand, which
     is the work this product exists to remove. */
  const disagreements = r.conflicts
    .map((c) => `${label[c.source]} says ${c.value}`)
    .join(", and ");
  return (
    `From ${label[r.answer.source]}: ${r.answer.value} (${r.answer.citation}). ` +
    `Worth knowing that ${disagreements}. These have not been reconciled.`
  );
}
