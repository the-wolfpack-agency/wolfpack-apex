/**
 * Does the product do what we have written down that it does?
 *
 * WHAT THIS IS FOR. Before a client walkthrough somebody has to know that the
 * prompts in the guide we hand them actually work on the deployment they will
 * be shown. On 2026-08-31 they did not: the guide published "what does our
 * policy say about time off?" and "summarize the onboarding document", and
 * both returned "I could not find a clear answer" against a corpus of 1,251
 * Porsche academy documents that contains neither a time-off policy nor an
 * onboarding document.
 *
 * Nothing was broken. The mechanism works and the contract records it being
 * measured. The examples were generic placeholders, and a generic placeholder
 * demonstrated live on a real corpus looks exactly like a product that cannot
 * answer.
 *
 * TWO DIFFERENT FAILURES, KEPT APART. A prompt can fail because the product
 * does not do the thing (a defect, and the guide is lying), or because this
 * deployment holds nothing to answer it with (a demo script problem, and the
 * product is fine). Reporting them the same way would send somebody debugging
 * retrieval when the real fix is to pick a document the client actually has.
 *
 * THE CONTRACT IS THE SOURCE OF TRUTH, and this only reads it. Adding a module
 * for a CRM or a DMS later means declaring its actions once; the check comes
 * free, and so does the walkthrough script.
 */

export type PromisedShape = "synthesised" | "list" | "form" | "widget";

export interface PromisedPrompt {
  /** Action id from the capability contract, so a failure names the entry. */
  id: string;
  prompt: string;
  returns: PromisedShape;
  /** What the guide tells a client to expect. */
  because: string;
}

export interface ObservedAnswer {
  text: string;
  /** Whatever the turn attributed itself to: brain, tool, ai, knowledge_cache. */
  source: string;
  /** Rows in an accompanying widget, when there was one. */
  widgetRows: number;
  /** Citations the answer carried. */
  sources: number;
  ms: number;
}

export type Verdict =
  /** Delivered what the guide promised. */
  | { prompt: PromisedPrompt; state: "delivers"; observed: ObservedAnswer }
  /** The product did not do the promised thing. The guide is lying. */
  | { prompt: PromisedPrompt; state: "wrong-shape"; observed: ObservedAnswer; why: string }
  /** The product works; this deployment holds nothing to answer it with. */
  | { prompt: PromisedPrompt; state: "nothing-to-answer-with"; observed: ObservedAnswer };

/**
 * The sentence the product returns when retrieval found nothing.
 *
 * Matched on the opening rather than anywhere, so an answer that happens to
 * discuss not finding something is not mistaken for a miss.
 */
const FOUND_NOTHING = /^\s*I could not find a clear answer/i;

/** The count shape: search ran and returned a tally with a widget behind it. */
const COUNT_SHAPE = /^\s*Found \d+ results?\b/i;

/**
 * Judge one answer against what the contract promised.
 *
 * Deliberately blunt about what it can tell. It checks the SHAPE of an answer,
 * never whether the content is correct: a confident wrong answer passes here
 * and is caught by the eval set, which is a different tool for a different
 * question.
 */
export function judge(prompt: PromisedPrompt, observed: ObservedAnswer): Verdict {
  if (FOUND_NOTHING.test(observed.text)) {
    /* NOT A DEFECT, and this distinction is the point of the file. The product
       said honestly that it holds nothing for this. What needs fixing is the
       example, not the retrieval. */
    return { prompt, state: "nothing-to-answer-with", observed };
  }

  if (prompt.returns === "list") {
    /* A count sentence with rows behind it IS the list: the widget is where a
       reader sees them. A count with nothing behind it is not. */
    if (observed.widgetRows > 0 || observed.sources > 0) {
      return { prompt, state: "delivers", observed };
    }
    return {
      prompt,
      state: "wrong-shape",
      observed,
      why: "promised a list to open, returned a count with nothing behind it",
    };
  }

  if (prompt.returns === "synthesised") {
    if (COUNT_SHAPE.test(observed.text)) {
      return {
        prompt,
        state: "wrong-shape",
        observed,
        why: "promised a written answer, returned a result count",
      };
    }
    /* Prose with nothing to cite is the shape this product exists to avoid:
       an answer that reads as grounded and is not. */
    if (observed.sources === 0 && observed.source !== "ai") {
      return {
        prompt,
        state: "wrong-shape",
        observed,
        why: "promised the document it came from, cited nothing",
      };
    }
    return { prompt, state: "delivers", observed };
  }

  /* form and widget: the answer is the surface, so having one is the test. */
  return observed.widgetRows > 0 || observed.sources > 0
    ? { prompt, state: "delivers", observed }
    : {
        prompt,
        state: "wrong-shape",
        observed,
        why: `promised a ${prompt.returns}, returned neither widget nor sources`,
      };
}

export interface Readiness {
  verdicts: Verdict[];
  delivers: Verdict[];
  wrongShape: Verdict[];
  nothingToAnswerWith: Verdict[];
  /** True only when nothing is the wrong shape. */
  contractHolds: boolean;
}

export function assessWalkthrough(verdicts: Verdict[]): Readiness {
  const wrongShape = verdicts.filter((v) => v.state === "wrong-shape");
  return {
    verdicts,
    delivers: verdicts.filter((v) => v.state === "delivers"),
    wrongShape,
    nothingToAnswerWith: verdicts.filter((v) => v.state === "nothing-to-answer-with"),
    /* A deployment with nothing to answer with is NOT a failing contract. It
       is a demo that needs grounding in the client's own documents, which is a
       different job with a different owner. */
    contractHolds: wrongShape.length === 0,
  };
}

/** What to tell somebody, and what to do about it. */
export function describeReadiness(r: Readiness): string {
  const out: string[] = [];
  out.push(
    `${r.delivers.length} of ${r.verdicts.length} promised prompts deliver what the guide says they will.`,
  );

  if (r.wrongShape.length > 0) {
    out.push(
      ``,
      `${r.wrongShape.length} DO NOT, which means the guide we hand a client is wrong:`,
      ``,
    );
    for (const v of r.wrongShape) {
      const why = v.state === "wrong-shape" ? v.why : "";
      out.push(`  ${v.prompt.id}`, `    "${v.prompt.prompt}"`, `    ${why}`, ``);
    }
  }

  if (r.nothingToAnswerWith.length > 0) {
    out.push(
      ``,
      `${r.nothingToAnswerWith.length} work but this deployment holds nothing to answer them with.`,
      `The product is fine; the example is. Ground these in a document the client actually has`,
      `before the walkthrough, or they will look like failures on a shared screen:`,
      ``,
    );
    for (const v of r.nothingToAnswerWith) {
      out.push(`  ${v.prompt.id}: "${v.prompt.prompt}"`);
    }
    out.push(``);
  }

  out.push(
    r.contractHolds
      ? `The contract holds: nothing promised is missing.`
      : `The contract does NOT hold. Fix the product or the promise before the walkthrough.`,
  );
  return out.join("\n");
}
