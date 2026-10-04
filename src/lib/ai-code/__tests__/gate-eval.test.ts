/**
 * Gate regression eval: the live detectors MUST still flag every class in the
 * synthetic corpus. A refactor that weakens a detector fails here - that's the
 * point (a confirmed catch becomes a permanent guarantee). Plus a completeness
 * assertion so a new detector class without an eval example can't slip in.
 */
import { reviewDiff } from "@/lib/ai-code/detect";
import { GATE_EVAL_CASES, GATE_DETECTOR_CLASSES, evalCoverageGaps, diffAdding } from "@/lib/ai-code/gate-eval-corpus";

describe("gate regression eval (detectors keep catching what they caught before)", () => {
  it.each(GATE_EVAL_CASES.map((c) => [c.klass, c] as const))(
    "still flags %s",
    (klass, c) => {
      const classes = reviewDiff(diffAdding(c.code)).map((f) => f.klass);
      // If this fails, the detector for `klass` stopped flagging `c.code`.
      expect(classes).toContain(klass);
    },
  );

  it("has an eval example for every required detector class (coverage can only grow)", () => {
    expect(evalCoverageGaps(GATE_DETECTOR_CLASSES, GATE_EVAL_CASES)).toEqual([]);
  });

  it("evalCoverageGaps reports a missing class (the auto-growing guardrail works)", () => {
    expect(evalCoverageGaps(["secret", "brand_new_class"], GATE_EVAL_CASES)).toEqual(["brand_new_class"]);
  });
});
