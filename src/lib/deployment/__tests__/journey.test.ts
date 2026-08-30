/**
 * The classifier decides whether a deployment is ready, so it has to be right
 * about the two answers that fool every shallow measure.
 *
 * A product tour is long, fluent, on topic, and useless to the person who
 * asked. A setup refusal is short and negative and is exactly what a correct
 * deployment should say. Score those two backwards and the report is worse than
 * no report: it passes the broken thing and fails the working one.
 */
import {
  classifyAnswer,
  judgeStep,
  scoreJourney,
  type JourneyStep,
  type StepResult,
} from "@/lib/deployment/journey";
import {
  buildJourney,
  moduleSteps,
  UNIVERSAL_STEPS,
  WOLFPACK_PROBES,
} from "@/lib/deployment/first-day-journey";

const step = (over: Partial<JourneyStep> = {}): JourneyStep => ({
  id: "s",
  ask: "q",
  expect: ["substantive"],
  budgetMs: 5_000,
  because: "because this is a representative first-day action",
  ...over,
});

const result = (answer: string, latencyMs: number | null = 1_000): StepResult => ({
  step: step(),
  kind: classifyAnswer({ answer, latencyMs }),
  latencyMs,
  answer,
});

describe("classifying what came back", () => {
  /* VERBATIM from production 2026-08-29, the answer to "what are the payment
     terms in our SOW?" This is the thing we sell. */
  it("recognises a real answer from a real document", () => {
    expect(
      classifyAnswer({
        answer:
          "Here's what the brain has on this: viaPeople Work Order.docx.pdf (chunk 7) > 50% ($6,000.00) is due within 30 days of the execution of this Work Order.",
        latencyMs: 1790,
      }),
    ).toBe("substantive");
  });

  /* VERBATIM from production. This is a GOOD outcome: it explains the gap and
     names the fix. Scoring it as a failure would make the report cry wolf on a
     correctly-behaving deployment. */
  it("treats a setup refusal as its own kind, not as a failure", () => {
    expect(
      classifyAnswer({
        answer:
          "I understood the question, but financials are not connected yet, so there is no figure to read. Connect QuickBooks in Admin, Connectors and I will be able to answer this.",
        latencyMs: 1237,
      }),
    ).toBe("needs_setup");
  });

  /* THE ONE THAT WAS ACTUALLY BROKEN, verbatim. Long, fluent, on topic, and it
     never touched a document. Every shallow "did it answer" measure passes it. */
  it("catches a product tour returned in place of an answer", () => {
    expect(
      classifyAnswer({
        answer:
          "Docs — Generated and uploaded documents. What you can do - Browse every document with title, type, and last-edited timestamp. How to use it 1. Open Docs from the left",
        latencyMs: 1238,
      }),
    ).toBe("product_tour");
  });

  it("catches an internal error reaching the reader", () => {
    for (const leak of [
      "Couldn't reach the DMS driver: fetch failed",
      "parameters failed validation for search_mail",
      "TypeError: cannot read property 'id' of undefined",
    ]) {
      expect(`${leak} => ${classifyAnswer({ answer: leak, latencyMs: 500 })}`).toBe(
        `${leak} => broken`,
      );
    }
  });

  /* A leak wrapped in a friendly sentence is still a leak, which is why order
     of checks matters. */
  it("reports a leak even when the sentence around it is polite", () => {
    expect(
      classifyAnswer({
        answer: "Sorry about that, I tried to reach the inventory service but fetch failed.",
        latencyMs: 900,
      }),
    ).toBe("broken");
  });

  it("recognises an honest empty result", () => {
    expect(classifyAnswer({ answer: 'No results found for "xyz".', latencyMs: 700 })).toBe("empty");
  });

  it("reports nothing rendered as no_answer rather than empty", () => {
    /* Distinct on purpose: "we searched and found nothing" and "the page never
       responded" send somebody to completely different places. */
    expect(classifyAnswer({ answer: "", latencyMs: null })).toBe("no_answer");
    expect(classifyAnswer({ answer: "ok", latencyMs: 200 })).toBe("no_answer");
  });
});

describe("judging a step", () => {
  it("passes when the answer is the kind the step expects", () => {
    expect(
      judgeStep(result("Here's what the brain has on this: the terms are net 30 per the SOW.")).ok,
    ).toBe(true);
  });

  /* A refusal is green ONLY where the journey says a refusal is acceptable. */
  it("passes a setup refusal only where the step allows it", () => {
    const answer = "Calendar is not connected yet. Connect Microsoft in Admin to enable this.";
    const lenient = { ...result(answer), step: step({ expect: ["substantive", "needs_setup"] }) };
    expect(judgeStep(lenient).ok).toBe(true);
    const strict = { ...result(answer), step: step({ expect: ["substantive"] }) };
    expect(judgeStep(strict).ok).toBe(false);
  });

  /* The message has to send somebody to the prompt, not to the logs. */
  it("names the problem in words that point at the cause", () => {
    const r = {
      ...result(
        "Docs — What you can do - Browse every document. How to use it 1. Open Docs from the left",
      ),
      step: step({ expect: ["substantive"] }),
    };
    const v = judgeStep(r);
    expect(v.ok).toBe(false);
    expect(v.problem).toContain("explained a feature instead of answering");
  });

  it("fails a correct answer that took too long", () => {
    const r = {
      ...result(
        "Here's what the brain has on this: net 30 from invoice date per the agreement.",
        9_000,
      ),
      step: step({ budgetMs: 5_000 }),
    };
    expect(judgeStep(r).ok).toBe(false);
    expect(judgeStep(r).problem).toContain("9000ms");
  });
});

describe("the report", () => {
  it("is ready only when every step behaved", () => {
    const good = [result("Here's what the brain has on this: the answer is net 30 per the SOW.")];
    expect(scoreJourney(good).ready).toBe(true);
    const bad = [
      ...good,
      {
        ...result("What you can do - Browse every document. How to use it 1. Open it"),
        step: step({ id: "b" }),
      },
    ];
    expect(scoreJourney(bad).ready).toBe(false);
  });

  /* A reader starts at the top and should find the worst thing there. */
  it("puts the worst problem first", () => {
    const rs: StepResult[] = [
      { ...result('No results found for "x".'), step: step({ id: "empty" }) },
      { ...result("Couldn't reach the driver: fetch failed"), step: step({ id: "leak" }) },
      {
        ...result("What you can do - Browse every document. How to use it 1. Open"),
        step: step({ id: "tour" }),
      },
    ];
    expect(scoreJourney(rs).problems.map((p) => p.step.id)).toEqual(["leak", "tour", "empty"]);
  });
});

describe("the journey must not depend on our data", () => {
  /* THE FLAW THIS FIXES. The first version asked "what are the payment terms
     in our SOW?", a real question with a real answer in OUR corpus and none at
     all in anybody else's. Pointed at a client on their first day it would
     have failed and reported the product broken, when the truth was they do
     not have our documents. */
  it("has no step mentioning our own documents", () => {
    for (const s of UNIVERSAL_STEPS) {
      expect(`${s.id}:${/\bSOW\b|wolfpack|viaPeople/i.test(s.ask)}`).toBe(`${s.id}:false`);
    }
  });

  it("runs on a deployment with no configuration at all", () => {
    const steps = buildJourney();
    /* Universal behaviour plus every module's declared capability. Both are
       portable by construction; only the corpus probes are deployment-specific,
       and there are none here. */
    expect(steps.length).toBe(UNIVERSAL_STEPS.length + moduleSteps().length);
    expect(steps.every((s) => s.ask.length > 0)).toBe(true);
  });

  it("adds corpus steps only when somebody supplies their own question", () => {
    const steps = buildJourney({ corpusProbes: [{ ask: "what is our refund window?" }] });
    expect(steps.length).toBe(UNIVERSAL_STEPS.length + moduleSteps().length + 1);
    /* Corpus probes come last, so a reader sees portable checks before
       deployment-specific ones. */
    expect(steps.at(-1)!.ask).toBe("what is our refund window?");
  });

  /* A supplied question is one the owner says their documents answer, so
     finding nothing is a real failure rather than an honest miss. The
     universal steps are the opposite: they must tolerate an empty corpus. */
  it("does not accept empty for a question the owner says is answerable", () => {
    const step = buildJourney({ corpusProbes: [{ ask: "what is our refund window?" }] }).at(-1)!;
    expect(step.expect).toEqual(["substantive"]);
  });

  it("lets the universal steps pass on a deployment holding nothing", () => {
    const search = UNIVERSAL_STEPS.find((s) => s.id === "document-search-responds")!;
    expect(search.expect).toContain("empty");
    const cal = UNIVERSAL_STEPS.find((s) => s.id === "calendar")!;
    expect(cal.expect).toContain("needs_setup");
  });

  /* Our own probes are configuration, not part of the product's definition of
     working, so they must not leak back into the universal list. */
  it("keeps our probes out of the universal steps", () => {
    const universalAsks = new Set(UNIVERSAL_STEPS.map((s) => s.ask));
    for (const p of WOLFPACK_PROBES) {
      expect(`${p.ask}:${universalAsks.has(p.ask)}`).toBe(`${p.ask}:false`);
    }
  });

  it("explains why every universal step exists", () => {
    for (const s of UNIVERSAL_STEPS) {
      expect(`${s.id}:${s.because.length > 20}`).toBe(`${s.id}:true`);
      expect(s.expect.length).toBeGreaterThan(0);
    }
  });

  it("uses unique ids so results join across runs", () => {
    const steps = buildJourney({ corpusProbes: WOLFPACK_PROBES });
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
  });

  /* Proves the classifier is not simply flagging every long answer: exactly one
     step legitimately expects a tour, and it is the one where a tour is right. */
  it("allows a product tour only where a tour is the correct answer", () => {
    expect(
      UNIVERSAL_STEPS.filter((s) => s.expect.includes("product_tour")).map((s) => s.id),
    ).toEqual(["capability"]);
  });

  /* Confabulation must never be acceptable. */
  it("never allows an invented answer to the impossible question", () => {
    const nonsense = UNIVERSAL_STEPS.find((s) => s.id === "nonsense")!;
    expect(nonsense.expect).not.toContain("substantive");
  });
});

/**
 * The journey generates from the module contract.
 *
 * This is the reason the contract is worth a file of its own. Declaring DMS or
 * CRM capabilities adds their verification automatically, so a module cannot
 * ship claiming an action nobody ever drove against a real deployment. Written
 * by hand, each module's coverage depends on somebody remembering, and
 * documents is the evidence for how that goes: it shipped a "summarise" the
 * engine never honoured and nothing noticed for as long as nobody typed it.
 */
describe("module capabilities become journey steps", () => {
  it("verifies every supported action", () => {
    const ids = moduleSteps().map((s) => s.id);
    expect(ids).toContain("module-documents.ask");
    expect(ids).toContain("module-documents.find");
  });

  /* SUMMARISE JOINED THE JOURNEY ON 2026-08-30, which is the registry driving
     the journey rather than the two being maintained side by side. It sat out
     for as long as it was declared `routes_elsewhere`, because a gap already
     written down must not fail the journey or the report becomes noise and
     people stop reading it. Promoting the declaration added the step, and no
     part of this file had to be told. */
  it("verifies summarise now that it is supported", () => {
    expect(moduleSteps().map((s) => s.id)).toContain("module-documents.summarise");
  });

  /* And the step must demand a real answer. A summarise step that accepted a
     list would reinstate the original defect while looking like coverage. */
  it("holds summarise to a synthesised answer", () => {
    const step = moduleSteps().find((s) => s.id === "module-documents.summarise")!;
    expect(step.expect).toContain("substantive");
    expect(step.expect).not.toContain("list");
  });

  /* The expectation comes from the DECLARED shape, so a module claiming a
     synthesised answer and returning a list fails here rather than in front of
     a client. */
  it("holds a synthesised action to a synthesised answer", () => {
    const ask = moduleSteps().find((s) => s.id === "module-documents.ask")!;
    expect(ask.expect).toContain("substantive");
    expect(ask.expect).not.toContain("needs_setup");
  });

  /* A fresh deployment holds nothing, and that is not the module being broken. */
  it("allows an empty corpus", () => {
    for (const s of moduleSteps()) expect(s.expect).toContain("empty");
  });

  it("includes them in the built journey", () => {
    const ids = buildJourney().map((s) => s.id);
    expect(ids).toContain("module-documents.ask");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("explains each step using the action's own reason", () => {
    for (const s of moduleSteps()) expect(s.because.length).toBeGreaterThan(20);
  });
});
