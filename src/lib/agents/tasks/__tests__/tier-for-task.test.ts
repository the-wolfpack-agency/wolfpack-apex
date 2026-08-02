/**
 * Choosing a tier from the work rather than hardcoding the expensive one.
 *
 * From real production data: the router page reported "0% served by the
 * cheapest tier" with both Azure models available. The router was correct; its
 * only caller asked for `large` unconditionally, so the cheap model could never
 * win however cheap it was.
 *
 * The tests that matter are the ones stopping this from over-correcting. A
 * wrong answer produced cheaply costs more than a right one produced dearly, so
 * the bar for downgrading is positive evidence that a task is mechanical.
 */
import { estimateTokens, tierForTask, type TaskShape } from "../tier-for-task";

const shape = (over: Partial<TaskShape> = {}): TaskShape => ({
  inherited: false,
  groundingSnippets: 0,
  stepCount: 2,
  instructionChars: 200,
  ...over,
});

describe("only a replay is downgraded", () => {
  it("sends an inherited plan to the cheap tier", () => {
    // The one signal strong enough. An inherited plan replays steps that
    // already succeeded, so the model follows rather than decides.
    const d = tierForTask(shape({ inherited: true }));
    expect(d.tier).toBe("small");
    expect(d.reason).toMatch(/inherited/);
  });

  it("keeps an EXPLORING run on the capable tier even when grounded", () => {
    // The correction an existing executor test forced. An exploring run decides
    // the plan, and that plan can be promoted and replayed — getting it wrong
    // cheaply poisons every future run that inherits it.
    const d = tierForTask(shape({ groundingSnippets: 5 }));
    expect(d.tier).toBe("large");
    expect(d.reason).toMatch(/may be reused/);
  });

  it("keeps an ungrounded exploring run on the capable tier", () => {
    expect(tierForTask(shape()).tier).toBe("large");
  });
});

describe("length overrides everything", () => {
  it("keeps a LONG inherited plan on the capable tier", () => {
    // Replay or not, a long plan compounds any weakness in the model.
    expect(tierForTask(shape({ inherited: true, stepCount: 9 })).tier).toBe("large");
  });

  it("keeps a verbose inherited plan on the capable tier", () => {
    expect(tierForTask(shape({ inherited: true, instructionChars: 8000 })).tier).toBe("large");
  });

  it("allows a short inherited plan through", () => {
    expect(tierForTask(shape({ inherited: true, stepCount: 4, instructionChars: 3999 })).tier).toBe("small");
  });
});

describe("every decision explains itself", () => {
  it.each([
    shape({ inherited: true }),
    shape({ groundingSnippets: 3 }),
    shape({ stepCount: 12 }),
    shape(),
  ])("gives a reason an operator can read", (s) => {
    // So someone reading the cost page can tell a deliberate downgrade from a
    // bug, without opening the code.
    const d = tierForTask(s);
    expect(d.reason.length).toBeGreaterThan(20);
    expect(d.reason).not.toMatch(/tier|small|large/i);
  });
});

describe("token estimates make a decision costable", () => {
  it("produces an estimate at all, which is the point", () => {
    // Production showed "$0.00, 4 without an estimate" because none were
    // passed. Zero reads as free rather than as unmeasured.
    const e = estimateTokens({ goalChars: 400, instructionChars: 800, groundingChars: 1200 });
    expect(e.estInputTokens).toBeGreaterThan(0);
    expect(e.estOutputTokens).toBeGreaterThan(0);
  });

  it("scales with the work", () => {
    const small = estimateTokens({ goalChars: 100, instructionChars: 100, groundingChars: 0 });
    const large = estimateTokens({ goalChars: 5000, instructionChars: 5000, groundingChars: 5000 });
    expect(large.estInputTokens).toBeGreaterThan(small.estInputTokens);
  });

  it("never returns zero, even for an empty task", () => {
    // A zero estimate would put us back where we started: a cost of $0.00 that
    // looks like free.
    const e = estimateTokens({ goalChars: 0, instructionChars: 0, groundingChars: 0 });
    expect(e.estInputTokens).toBeGreaterThanOrEqual(200);
    expect(e.estOutputTokens).toBeGreaterThanOrEqual(150);
  });

  it("expects far less output than input, which is what agent steps do", () => {
    const e = estimateTokens({ goalChars: 4000, instructionChars: 4000, groundingChars: 0 });
    expect(e.estOutputTokens).toBeLessThan(e.estInputTokens);
  });
});
