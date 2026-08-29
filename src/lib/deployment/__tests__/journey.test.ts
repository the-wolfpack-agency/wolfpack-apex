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
import { FIRST_DAY } from "@/lib/deployment/first-day-journey";

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

describe("the first-day journey itself", () => {
  it("asks about documents, which is what Phase 1 sells", () => {
    expect(FIRST_DAY.some((s) => /document|sow/i.test(s.ask))).toBe(true);
  });

  /* Every step must say why it exists, or the report cannot explain a failure
     to somebody who did not write the journey. */
  it("explains why every step is in it", () => {
    for (const s of FIRST_DAY) {
      expect(`${s.id}:${s.because.length > 20}`).toBe(`${s.id}:true`);
      expect(s.expect.length).toBeGreaterThan(0);
      expect(s.budgetMs).toBeGreaterThan(0);
    }
  });

  it("uses unique ids so results join across runs", () => {
    expect(new Set(FIRST_DAY.map((s) => s.id)).size).toBe(FIRST_DAY.length);
  });

  /* Proves the classifier is not simply flagging every long answer: exactly one
     step legitimately expects a tour, and it is the one where a tour is right. */
  it("allows a product tour only where a tour is the correct answer", () => {
    expect(
      FIRST_DAY.filter((s) => s.expect.includes("product_tour")).map((s) => s.id),
    ).toEqual(["capability"]);
  });
});
