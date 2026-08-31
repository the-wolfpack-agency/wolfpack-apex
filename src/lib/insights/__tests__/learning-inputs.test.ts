/**
 * Which learning capabilities have data, and which are starved.
 *
 * Eleven extractors have no caller, which reads as somebody forgetting to
 * wire them up. Measured on 2026-08-31 their source tables are empty and the
 * Microsoft sync has never run for mail, calendar, contacts, files or Teams.
 * Those two diagnoses need different people and different work.
 */
import {
  LEARNING_INPUTS,
  readInput,
  assessLearningInputs,
  describeLearningReadiness,
  type LearningInput,
} from "../learning-inputs";

const input: LearningInput = {
  extractor: "mail-signals",
  couldAnswer: "who replies and who does not",
  sources: ["instinct_sent_mail", "instinct_ms_messages"],
};

describe("telling an unwired capability from a starved one", () => {
  it("calls it fed when a source has enough rows to compute from", () => {
    const r = readInput(input, [
      { table: "instinct_sent_mail", rows: 500 },
      { table: "instinct_ms_messages", rows: 0 },
    ]);
    expect(r.state).toBe("fed");
  });

  /* THE FIRST VERSION OF THIS CHECK REPORTED MAIL-SIGNALS AS FED ON FOUR
     ROWS. Every one of these extractors computes a rate or a pattern, and
     four sent emails cannot tell anybody a reply rate. Overstating readiness
     here is discovered by trusting an answer built on it. */
  it("does not call four rows a working signal", () => {
    const r = readInput(input, [
      { table: "instinct_sent_mail", rows: 4 },
      { table: "instinct_ms_messages", rows: 0 },
    ]);
    expect(r.state).toBe("thin");
  });

  /* The code is written and correct. No amount of plumbing fixes this. */
  it("calls it starved when every source is empty", () => {
    const r = readInput(input, [
      { table: "instinct_sent_mail", rows: 0 },
      { table: "instinct_ms_messages", rows: 0 },
    ]);
    expect(r.state).toBe("starved");
  });

  /* A migration that never ran and a sync that never ran are different
     faults, and sending somebody to check the wrong one wastes the afternoon
     this is meant to save. */
  it("tells an absent table from an empty one", () => {
    const r = readInput(input, [
      { table: "instinct_sent_mail", rows: null },
      { table: "instinct_ms_messages", rows: null },
    ]);
    expect(r.state).toBe("no-table");
  });

  it("keeps the counts, so the reason is visible rather than asserted", () => {
    const r = readInput(input, [{ table: "instinct_sent_mail", rows: 0 }]);
    expect(r.counts).toEqual([{ table: "instinct_sent_mail", rows: 0 }]);
  });
});

describe("what it tells somebody", () => {
  const starved = readInput(input, [
    { table: "instinct_sent_mail", rows: 0 },
    { table: "instinct_ms_messages", rows: 0 },
  ]);

  /* The question worth knowing is not which table is empty, it is which
     question this deployment cannot answer yet. */
  it("says what the starved capability could have answered", () => {
    const text = describeLearningReadiness(assessLearningInputs([starved]));
    expect(text).toContain("who replies and who does not");
  });

  it("says plainly that plumbing will not fix it", () => {
    const text = describeLearningReadiness(assessLearningInputs([starved]));
    expect(text).toMatch(/not a wiring problem/i);
    expect(text).toMatch(/decision about what to keep/i);
  });

  it("counts what is working", () => {
    const fed = readInput(input, [{ table: "instinct_sent_mail", rows: 500 }]);
    expect(describeLearningReadiness(assessLearningInputs([fed, starved]))).toMatch(
      /1 of 2 learning capabilities have data/,
    );
  });

  it("says a thin source will answer, and that the answer is worth little", () => {
    const thin = readInput(input, [{ table: "instinct_sent_mail", rows: 4 }]);
    const text = describeLearningReadiness(assessLearningInputs([thin]));
    expect(text).toMatch(/too few to compute a rate or a pattern/i);
    expect(text).toMatch(/quotes once and regrets/i);
  });
});

describe("the declared inventory", () => {
  /* Declared rather than discovered from imports: reading imports finds the
     tables and not what the extractor is FOR. */
  it("says what each extractor could answer, in a person's words", () => {
    for (const i of LEARNING_INPUTS) {
      expect(i.couldAnswer.length).toBeGreaterThan(20);
      expect(i.sources.length).toBeGreaterThan(0);
    }
  });

  it("covers the extractors that have no caller", () => {
    const names = LEARNING_INPUTS.map((i) => i.extractor);
    for (const e of ["mail-signals", "calendar-signals", "file-signals", "team-collaboration-signals"]) {
      expect(names).toContain(e);
    }
  });
});
