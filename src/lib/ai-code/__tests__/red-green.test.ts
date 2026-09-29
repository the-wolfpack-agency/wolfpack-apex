/**
 * Red-before-green core: a fix is proven only when its reproducing test fails on
 * the unfixed base and passes on the fix. Covers all four outcome combinations,
 * including the self-consistency trap (a test that passes even without the fix).
 */
import { evaluateRedGreen, redGreenFeedback, selectReproducingTests } from "@/lib/ai-code/red-green";

describe("selectReproducingTests", () => {
  it("picks the test files out of a change (what must go red -> green)", () => {
    const changed = ["src/lib/x.ts", "src/lib/__tests__/x.test.ts", "src/lib/y.spec.tsx", "README.md"];
    expect(selectReproducingTests(changed)).toEqual(["src/lib/__tests__/x.test.ts", "src/lib/y.spec.tsx"]);
  });
  it("returns nothing when a change ships no test (a fix that cannot be proven)", () => {
    expect(selectReproducingTests(["src/lib/x.ts"])).toEqual([]);
  });
});

describe("evaluateRedGreen", () => {
  it("red -> green: fails on base, passes on head -> proven", () => {
    const v = evaluateRedGreen({ failedOnBase: true, passedOnHead: true });
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/red -> green|proven/i);
  });

  it("passes on base (does not reproduce the bug) -> rejected, even though it passes after", () => {
    const v = evaluateRedGreen({ failedOnBase: false, passedOnHead: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not reproduce the bug/i);
  });

  it("still fails after the fix -> not actually fixed", () => {
    const v = evaluateRedGreen({ failedOnBase: true, passedOnHead: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/still FAILS after the fix|not actually fixed/i);
  });

  it("fails before and after -> broken/unrelated, proves nothing", () => {
    const v = evaluateRedGreen({ failedOnBase: false, passedOnHead: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/both before and after|proves nothing/i);
  });
});

describe("redGreenFeedback", () => {
  it("tells the author to write a test that goes red then green", () => {
    const fb = redGreenFeedback(evaluateRedGreen({ failedOnBase: false, passedOnHead: true }));
    expect(fb).toMatch(/not proven/i);
    expect(fb).toMatch(/fails on the current code and passes only after/i);
  });
});
