/** @jest-environment node */
/**
 * Grading whether an answer addresses the question.
 *
 * The prompt and the parser are the two pieces worth pinning: a rubric that
 * grades the wrong thing, and a parser that crashes or silently passes on a
 * reply it cannot read. The completion itself is one model call the harness
 * owns.
 */

import { buildGradePrompt, parseGrade } from "../answer-grade";

describe("the grading prompt", () => {
  it("carries both texts and the three-point rubric", () => {
    const p = buildGradePrompt("what are my tasks?", "You have three tasks due today.");
    expect(p).toContain("what are my tasks?");
    expect(p).toContain("You have three tasks due today.");
    expect(p).toMatch(/2 -.*directly/);
    expect(p).toMatch(/0 -.*off-topic/);
  });

  /* Responsiveness, not correctness: the harness has no ground truth for an
     arbitrary prompt, so a rubric that graded correctness would invent one. */
  it("asks about addressing the question, not being correct", () => {
    const p = buildGradePrompt("q", "a").toLowerCase();
    expect(p).toContain("addresses");
    expect(p).toMatch(/not about whether it is[\s\S]*correct/);
  });
});

describe("reading the grade back", () => {
  it("parses clean JSON", () => {
    expect(parseGrade('{"score": 2, "reason": "answers directly"}')).toEqual({
      score: 2,
      reason: "answers directly",
    });
  });

  it("tolerates prose around the JSON", () => {
    const g = parseGrade('Here is my grade: {"score": 1, "reason": "partial"} hope that helps');
    expect(g.score).toBe(1);
  });

  it("recovers a bare score when the model ignores the format", () => {
    expect(parseGrade("score: 0 because it refused").score).toBe(0);
    expect(parseGrade("2").score).toBe(2);
  });

  /* A grade nobody can parse is not a passing grade. Returning 2 on unreadable
     output would let a broken grader wave everything through. */
  it("returns 0 for an unreadable grade, not a pass", () => {
    const g = parseGrade("the answer was fine I think");
    expect(g.score).toBe(0);
    expect(g.reason).toMatch(/could not be read/);
  });

  it("does not accept an out-of-range score", () => {
    expect(parseGrade('{"score": 5, "reason": "x"}').score).toBe(0);
  });
});
