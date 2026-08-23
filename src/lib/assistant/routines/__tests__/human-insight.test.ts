/**
 * Reading what the human steps say.
 *
 * This file decides what the product tells somebody about their own week, so
 * the tests are mostly about restraint: what it must NOT say, and when it must
 * say nothing at all.
 */
import { readHumanSteps, MIN_RUNS_FOR_A_FINDING, type HumanStepRow } from "../human-insight";

const row = (over: Partial<HumanStepRow> = {}): HumanStepRow => ({
  routineId: "morning",
  stepIndex: 4,
  label: "Rehearse the opening out loud",
  humanAction: "do",
  asked: 20,
  completed: 20,
  skipped: 0,
  avgMsWhenDone: 6 * 60 * 1000,
  ...over,
});

describe("saying nothing, which is most of the job", () => {
  it("stays quiet until a step has been asked enough times", () => {
    /* Turning one skipped rehearsal into a finding is the most damaging thing
       this file could do. */
    for (let asked = 1; asked < MIN_RUNS_FOR_A_FINDING; asked += 1) {
      expect(readHumanSteps([row({ asked, completed: 0, skipped: asked })])).toEqual([]);
    }
  });

  it("says nothing at all when there is nothing recorded", () => {
    expect(readHumanSteps([])).toEqual([]);
  });
});

describe("work that is not happening", () => {
  const skipped = row({ asked: 12, completed: 3, skipped: 9 });

  it("names it plainly, with the numbers to check", () => {
    const [f] = readHumanSteps([skipped]);
    expect(f.kind).toBe("not_happening");
    expect(f.observation).toContain("12");
    expect(f.observation).toContain("3");
  });

  it("offers both readings instead of choosing one", () => {
    /* The same number fits "this does not matter" and "this matters and is not
       getting done", and only the person knows which. Picking for them is how
       a useful signal becomes a wrong accusation. */
    const [f] = readHumanSteps([skipped]);
    expect(f.suggestion).toMatch(/not as important/i);
    expect(f.suggestion).toMatch(/matters and is not getting done/i);
  });

  it("never turns a skip into a mark against the person", () => {
    /* A product that scores people gets one of two responses, and both destroy
       the data: they stop running routines, or they tick the box without doing
       the thing. */
    const [f] = readHumanSteps([skipped]);
    const text = `${f.observation} ${f.suggestion}`.toLowerCase();
    for (const word of ["you failed", "failure", "compliance", "should have", "poor", "unacceptable"]) {
      expect(text).not.toContain(word);
    }
  });

  it("reads a skipped REVIEW differently from skipped work", () => {
    /* Skipping a rehearsal and skipping a checkpoint are different problems
       with different fixes, and one sentence for both would be advice about
       neither. */
    const doing = readHumanSteps([skipped])[0];
    const review = readHumanSteps([
      row({ humanAction: "review", asked: 12, completed: 2, skipped: 10 }),
    ])[0];

    expect(review.suggestion).toMatch(/not checking anything/i);
    expect(doing.suggestion).toMatch(/not as important/i);
    expect(doing.suggestion).not.toBe(review.suggestion);
  });
});

describe("work a tool could help with", () => {
  it("flags a habit that is done every time and costs real minutes", () => {
    const [f] = readHumanSteps([row({ asked: 20, completed: 20, avgMsWhenDone: 12 * 60 * 1000 })]);
    expect(f.kind).toBe("worth_a_tool");
    expect(f.observation).toMatch(/12 minutes/);
  });

  it("does not name a product, because that would be guessing at the problem", () => {
    /* "Buy a recorder" is a guess. "Part of this looks mechanical" is an
       observation they can act on with what they already have. */
    const [f] = readHumanSteps([row({ avgMsWhenDone: 15 * 60 * 1000 })]);
    expect(f.suggestion).toMatch(/which part of it is mechanical/i);
    expect(f.suggestion).not.toMatch(/recorder|buy|purchase|subscribe/i);
  });

  it("leaves the judgement with the person", () => {
    const [f] = readHumanSteps([row({ avgMsWhenDone: 15 * 60 * 1000 })]);
    expect(f.suggestion).toMatch(/judgement stays with you/i);
  });

  it("does not flag a quick habit as expensive", () => {
    expect(readHumanSteps([row({ avgMsWhenDone: 45_000 })])[0].kind).toBe("healthy");
  });
});

describe("pauses that are not earning their place", () => {
  it("flags a review always waved through in seconds", () => {
    const [f] = readHumanSteps([
      row({ humanAction: "review", label: "Check the draft", asked: 30, completed: 30, avgMsWhenDone: 4_000 }),
    ]);
    expect(f.kind).toBe("pause_not_earning");
    expect(f.suggestion).toMatch(/removing the pause/i);
  });

  it("keeps the pause where the step before it can be wrong in a way that matters", () => {
    const [f] = readHumanSteps([
      row({ humanAction: "review", asked: 30, completed: 30, avgMsWhenDone: 4_000 }),
    ]);
    expect(f.suggestion).toMatch(/can be wrong in a way that matters/i);
  });

  it("does not flag a review somebody actually spends time on", () => {
    const [f] = readHumanSteps([
      row({ humanAction: "review", asked: 30, completed: 30, avgMsWhenDone: 3 * 60 * 1000 }),
    ]);
    expect(f.kind).toBe("healthy");
  });
});

describe("saying so when things are fine", () => {
  it("reports a healthy step rather than going quiet", () => {
    /* A routine where everything is working should say so. Silence reads as
       "the feature is broken", and the person stops looking. */
    const [f] = readHumanSteps([row({ asked: 10, completed: 10, avgMsWhenDone: 2 * 60 * 1000 })]);
    expect(f.kind).toBe("healthy");
    expect(f.suggestion).toMatch(/nothing to change/i);
  });
});

describe("what to read first", () => {
  it("puts work that is not happening above everything else", () => {
    const findings = readHumanSteps([
      row({ stepIndex: 1, humanAction: "review", asked: 30, completed: 30, avgMsWhenDone: 3_000 }),
      row({ stepIndex: 2, asked: 20, completed: 20, avgMsWhenDone: 20 * 60 * 1000 }),
      row({ stepIndex: 3, asked: 20, completed: 4, skipped: 16 }),
      row({ stepIndex: 4, asked: 20, completed: 20, avgMsWhenDone: 90_000 }),
    ]);
    expect(findings.map((f) => f.kind)).toEqual([
      "not_happening",
      "worth_a_tool",
      "pause_not_earning",
      "healthy",
    ]);
  });

  it("reports a completion rate on every finding, so nothing is asserted without a number", () => {
    for (const f of readHumanSteps([row(), row({ stepIndex: 9, asked: 20, completed: 2, skipped: 18 })])) {
      expect(f.completionRate).toBeGreaterThanOrEqual(0);
      expect(f.completionRate).toBeLessThanOrEqual(1);
    }
  });
});

describe("late is not the same as long", () => {
  /* The finding nobody else produces. Everybody measures the tech; nobody
     measures when the human part actually happens, so nobody notices that the
     problem with somebody's preparation is WHEN they do it. */
  const step = (over: Partial<HumanStepRow> = {}): HumanStepRow => ({
    routineId: "morning",
    stepIndex: 2,
    label: "Prepare for the client call",
    humanAction: "do",
    asked: 20,
    completed: 20,
    skipped: 0,
    avgMsWhenDone: 60 * 60 * 1000,
    fastestMs: 4 * 60 * 1000,
    ...over,
  });

  it("calls out a step that is always done late, not one that is always slow", () => {
    const [f] = readHumanSteps([step()]);
    expect(f.kind).toBe("left_late");
    expect(f.observation).toMatch(/as little as 4 minutes/i);
    expect(f.suggestion).toMatch(/waiting rather than work/i);
  });

  it("says why late matters, in terms of the work rather than the clock", () => {
    /* "Preparation done after the thing it was for did not happen" is the
       insight; "60 minutes" is just a number. */
    const [f] = readHumanSteps([step()]);
    expect(f.suggestion).toMatch(/after the thing it was for/i);
  });

  it("still calls a genuinely expensive step expensive", () => {
    /* Consistently slow even at its best is effort, not delay, and it wants a
       tool rather than a different slot in the day. */
    const [f] = readHumanSteps([
      step({ avgMsWhenDone: 40 * 60 * 1000, fastestMs: 35 * 60 * 1000 }),
    ]);
    expect(f.kind).toBe("worth_a_tool");
  });

  it("does not call ordinary variance lateness", () => {
    /* One quick run and one slow one is a normal week, not a finding. */
    const [f] = readHumanSteps([
      step({ avgMsWhenDone: 12 * 60 * 1000, fastestMs: 8 * 60 * 1000 }),
    ]);
    expect(f.kind).toBe("worth_a_tool");
  });

  it("says nothing about lateness when there is no best run to compare", () => {
    /* Without the fastest run the average is unreadable, and guessing which
       shape it has would be inventing the finding. */
    const [f] = readHumanSteps([step({ fastestMs: null })]);
    expect(f.kind).toBe("worth_a_tool");
  });

  it("ranks being late above being expensive", () => {
    /* Usually the cheaper fix, and the more surprising thing to be told. */
    const findings = readHumanSteps([
      step({ stepIndex: 1, avgMsWhenDone: 40 * 60 * 1000, fastestMs: 35 * 60 * 1000 }),
      step({ stepIndex: 2 }),
    ]);
    expect(findings.map((f) => f.kind)).toEqual(["left_late", "worth_a_tool"]);
  });
});
