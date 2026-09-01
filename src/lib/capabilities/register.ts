/**
 * What this product claims it can do, and what has ever actually done it.
 *
 * WHY THIS EXISTS, FROM ONE DAY'S FINDINGS. Four capabilities were built,
 * tested, configured in production, and had never run once:
 *
 *   OCR on scanned documents. Wired into the repair with a cost policy and an
 *   audit trail, credentials resolving in production. Zero calls, ever,
 *   because the failure reason that should have queued a scan was missing from
 *   a list.
 *
 *   Query expansion. Its trigger is a judge rejection and the production path
 *   passed no judge, so its only exercise was a harness nobody could start.
 *
 *   The document repair. Ran nightly for weeks and reported success while
 *   repairing nothing, because the identity it ran as could never hold a
 *   Microsoft token.
 *
 *   The retrieval eval. Refused to run for want of a deployment that was in
 *   fact configured, because the script never loaded its environment.
 *
 * Every one was found by accident, weeks late, usually while chasing something
 * else. None of them failed loudly. A capability that nothing exercises does
 * not degrade, it simply never was, and the code reads identically either way.
 *
 * SO EVIDENCE IS A SIDE EFFECT OF WORKING, NEVER A SELF-REPORT. A configured
 * credential proves nothing: three of the four above had every variable set. A
 * passing test proves nothing either: all four had those. The only thing that
 * counts here is a trace the system leaves when the capability actually did
 * its job on real data.
 *
 * SUCCESS SIGNALS ONLY, WHICH IS A REAL CONSTRAINT ON WHAT BELONGS HERE. A
 * degradation event never firing is good news, so it can never be evidence
 * that something works. Those live in the health checks, and mixing the two
 * would produce a register that reads worst when the product is healthiest.
 */

/** How a capability proves itself, using traces it already leaves. */
export type Evidence =
  /** An analytics event the working path emits. */
  | { kind: "event"; event: string; atLeast?: number }
  /** A count from a table, for capabilities that leave rows rather than events. */
  | { kind: "count"; label: string; atLeast: number };

export interface Capability {
  id: string;
  /** What we say it does, in the words we would say it to a client. */
  claim: string;
  /** The trace it leaves when it genuinely runs. */
  provenBy: Evidence;
  /**
   * Why anybody cares, so a red line is actionable rather than a chore.
   *
   * Written for whoever reads the failing job at 7am, not for the person who
   * added the entry.
   */
  matters: string;
}

/**
 * Days after which a demonstration stops counting as current.
 *
 * Long enough that a quiet fortnight is not an alarm, short enough that a
 * capability which silently broke in January is not still trading on a
 * February success.
 */
export const FRESH_DAYS = 45;

export const CAPABILITIES: Capability[] = [
  {
    id: "ocr",
    claim: "We can read a scanned document that has no extractable text.",
    provenBy: { kind: "event", event: "brain.document_ocred" },
    matters:
      "56 scanned documents in the corpus are unanswerable without it. It was fully built and had run zero times for months.",
  },
  {
    id: "query_expansion",
    claim: "When a question's words do not match the corpus, we ask again in other words.",
    provenBy: { kind: "event", event: "brain.query_expanded" },
    matters:
      "Worth 8 points of retrieval recall on the labeled set. Its trigger is a judge rejection, so it goes dark the moment the judge is unwired.",
  },
  {
    id: "document_repair",
    claim: "Documents that failed on a bug we have since fixed get re-read automatically.",
    /* A RUN HAPPENING IS NOT A RUN WORKING, and the first version of this
       entry proved itself with brain.reprocess_run, which fires whether the
       run repaired fifty documents or none. That is precisely the failure
       this register was built after: the job ran nightly for weeks, emitted
       that event every time, and repaired nothing. The register would have
       called it demonstrated and been wrong in the same way the job was. */
    provenBy: { kind: "count", label: "runs that actually repaired a document", atLeast: 1 },
    matters:
      "The job reported success while repairing nothing for weeks, because a run firing its event is not a run doing its job.",
  },
  {
    id: "semantic_retrieval",
    claim: "Search finds a passage by meaning, not only by the words it contains.",
    provenBy: { kind: "count", label: "queries with a semantic hit", atLeast: 1 },
    matters:
      "252 real queries once went by with not one semantic hit while every dashboard number looked healthy. Half the search was dead for over a month.",
  },
  {
    id: "model_switching",
    claim: "The router picks the cheapest model that can do the job, across vendors.",
    provenBy: { kind: "count", label: "distinct models used in 30 days", atLeast: 2 },
    matters:
      "The whole cost argument rests on it. A router that always picks the same model is indistinguishable from one that cannot pick another.",
  },
  {
    id: "relevance_judge",
    claim: "We can tell a confident retrieval from the wrong place, and refuse it.",
    provenBy: { kind: "event", event: "brain.retrieval_judged_irrelevant" },
    matters:
      "It is the only check that catches a retrieval which reads perfectly and answers a different question. Every score-based gate passes those.",
  },
];

export type Verdict =
  /** Ran recently. The claim is currently true. */
  | "demonstrated"
  /** Ran once, but not lately. The claim was true and may not be now. */
  | "stale"
  /** Has never run. The claim is a claim. */
  | "never"
  /** The evidence could not be read, which is not the same as absent. */
  | "unknown";

export interface CapabilityStatus {
  capability: Capability;
  verdict: Verdict;
  /** How many times the evidence has been seen. */
  observations: number;
  /** When it last happened, when that is known. */
  lastSeen: string | null;
}

/**
 * Turn an observation into a verdict.
 *
 * Separated from the reading so the RULE can be tested without a database,
 * which matters: the rule is the part that says whether a claim holds.
 */
export function verdictFor(
  observations: number | null,
  lastSeen: string | null,
  required: number,
  now: Date,
): Verdict {
  /* Null means the query failed. An unreadable signal and an absent one lead
     to opposite actions, and this whole register exists because those two look
     alike from a distance. */
  if (observations === null) return "unknown";
  if (observations < required) return "never";
  if (!lastSeen) return "stale";
  const age = (now.getTime() - new Date(lastSeen).getTime()) / 86_400_000;
  return age <= FRESH_DAYS ? "demonstrated" : "stale";
}

/** What a job should exit non-zero on. */
export function isFailing(status: CapabilityStatus): boolean {
  return status.verdict === "never";
}

/**
 * One line a person can act on.
 *
 * Names the capability, the verdict, and why it matters, because a register
 * that only prints ids gets skimmed and then ignored.
 */
export function describe(status: CapabilityStatus): string {
  const { capability: c, verdict, observations, lastSeen } = status;
  const seen =
    verdict === "never"
      ? "never once"
      : verdict === "unknown"
        ? "could not be checked"
        : `${observations.toLocaleString()} times, last ${lastSeen?.slice(0, 10)}`;
  return `${verdict.toUpperCase().padEnd(13)} ${c.id.padEnd(20)} ${seen}\n    ${c.claim}\n    ${c.matters}`;
}
