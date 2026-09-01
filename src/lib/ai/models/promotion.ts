/**
 * Whether a model is ALLOWED to serve, and what it takes to change that.
 *
 * THE PROBLEM THIS IS FOR
 *
 * A client's AI behavior changes without anybody deciding it should. A
 * provider ships new weights under the same name, deprecates a version, or
 * quietly alters a default, and the first anybody knows is that answers got
 * worse. Every gateway is a pass-through by design, so their answer to "the
 * model changed" is "yes, it did".
 *
 * The evaluation half of this already exists: evaluateModelRegression compares
 * a candidate model's task-success rate against the one it replaced, holding
 * the agent fixed so the delta is attributable to the model rather than to a
 * prompt or a data change. It produces a verdict, records it, and puts it on a
 * dashboard.
 *
 * And then nothing happens. A model that regressed keeps serving. Detection
 * with no gate is a report, and a report is a thing somebody reads afterwards
 * to understand why the client was unhappy.
 *
 * SO ELIGIBILITY IS A STATE, NOT AN OPINION
 *
 *   approved     may serve traffic
 *   candidate    may be measured, may not serve
 *   quarantined  may not serve, and says why
 *
 * A model moves between them on EVIDENCE, through decide() below, which is a
 * pure function so the rule can be read, tested and argued with rather than
 * inferred from behavior.
 *
 * IT FAILS OPEN, DELIBERATELY, AND THAT IS THE OPPOSITE OF THE RESIDENCY GATE
 *
 * A model nobody has ruled on serves normally. Refusing every unrecorded model
 * would take down every deployment the moment this shipped, on an estate where
 * nobody has evaluated anything yet: that is not a control, it is an outage
 * with a principled explanation. The residency gate fails closed because the
 * harm there is a record leaving the wrong jurisdiction. The harm here is a
 * slightly worse answer, and refusing to answer at all is strictly worse than
 * that.
 *
 * Quarantine is the one hard stop, and it only follows measured evidence or an
 * explicit human decision.
 */

export type PromotionState = "approved" | "candidate" | "quarantined";

/** What the evals concluded. Mirrors ModelEvalVerdict from the agent evals. */
export type EvalVerdict = "stable" | "regressed" | "improved" | "insufficient_data";

export interface PromotionRecord {
  /** Registry id of the model. */
  modelId: string;
  /** The exact version the provider reported, when it reports one. A model id
   *  is not a version: "gpt-4o" has meant several different sets of weights,
   *  and a rule keyed only on the id cannot tell them apart. */
  version: string | null;
  state: PromotionState;
  /** Why it is in this state, in words, for the page and the audit row. */
  reason: string;
  /** Set when a person made the call rather than the evidence. */
  decidedBy: string | null;
}

export interface PromotionDecision {
  state: PromotionState;
  reason: string;
  /** True when this changes the state the model was already in. */
  changed: boolean;
}

/**
 * Turn evidence into a state.
 *
 * Pure. The inputs are the current record, what the evals concluded, and
 * whether a person has overridden it.
 *
 * A HUMAN DECISION OUTRANKS THE EVIDENCE, both ways. An operator who has looked
 * at a regression and decided it is acceptable must be able to say so, and an
 * operator who distrusts a model that scores well must be able to stop it. The
 * alternative is a system that argues with the person accountable for it, which
 * they will work around by disabling the whole thing.
 */
export function decide(input: {
  current: PromotionState;
  verdict: EvalVerdict;
  /** An explicit human decision, when one has been made. */
  override?: { state: PromotionState; by: string; reason: string };
}): PromotionDecision {
  if (input.override) {
    return {
      state: input.override.state,
      reason: `${input.override.reason} (decided by ${input.override.by})`,
      changed: input.override.state !== input.current,
    };
  }

  switch (input.verdict) {
    case "regressed":
      /* THE WHOLE POINT. Measured worse than the model it replaced, so it stops
         serving until somebody decides otherwise. */
      return {
        state: "quarantined",
        reason: "Task success fell measurably against the model this replaced.",
        changed: input.current !== "quarantined",
      };

    case "improved":
    case "stable":
      /* Evidence promotes a candidate, and never un-quarantines. A model that
         was stopped by a person or by an earlier regression needs a decision to
         come back, not a run of good luck on a later sample. */
      if (input.current === "quarantined") {
        return {
          state: "quarantined",
          reason: "Held: a quarantined model returns by decision, not by a later sample.",
          changed: false,
        };
      }
      return {
        state: "approved",
        reason:
          input.verdict === "improved"
            ? "Task success rose against the model this replaced."
            : "Task success held against the model this replaced.",
        changed: input.current !== "approved",
      };

    case "insufficient_data":
    default:
      /* Not enough evidence is not evidence of a problem. An approved model
         keeps serving; a candidate stays a candidate rather than being promoted
         on silence. */
      return {
        state: input.current === "candidate" ? "candidate" : input.current,
        reason: "Not enough completed work on both models to compare them yet.",
        changed: false,
      };
  }
}

/**
 * May this model serve a request right now?
 *
 * `records` is what has been decided. A model absent from it has never been
 * ruled on and serves normally, which is the fail-open default described above.
 */
export function mayServe(
  modelId: string,
  records: readonly PromotionRecord[],
): { allowed: boolean; state: PromotionState; reason: string } {
  const record = records.find((r) => r.modelId === modelId);
  if (!record) {
    return {
      allowed: true,
      state: "approved",
      reason: "No decision has been recorded for this model.",
    };
  }
  if (record.state === "approved") {
    return { allowed: true, state: "approved", reason: record.reason };
  }
  return { allowed: false, state: record.state, reason: record.reason };
}

/**
 * The best model to use instead of one that may not serve.
 *
 * Order is the caller's preference (cheapest first), so this returns the
 * cheapest replacement that is allowed rather than the first that exists.
 * Returns null when nothing is eligible, which the caller must report rather
 * than resolve by ignoring the gate.
 */
export function substituteFor(
  blocked: string,
  preference: readonly string[],
  records: readonly PromotionRecord[],
): string | null {
  for (const candidate of preference) {
    if (candidate === blocked) continue;
    if (mayServe(candidate, records).allowed) return candidate;
  }
  return null;
}
