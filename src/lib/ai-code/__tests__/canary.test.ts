/**
 * decideCanaryAction: the deterministic canary decision behind auto-revert.
 * A failed deploy reverts to the last-good version; a pass promotes; anything
 * unfinished holds. Never a no-op reset, and never a revert with no safe target.
 */
import { decideCanaryAction } from "@/lib/ai-code/canary";

test("deploy FAILED with a differing last-good -> revert to last-good", () => {
  const d = decideCanaryAction({ deploy: "fail", currentSha: "bbb", lastGoodSha: "aaa" });
  expect(d.action).toBe("revert");
  expect(d.toSha).toBe("aaa");
  expect(d.reason).toMatch(/failed/i);
});

test("deploy FAILED but last-good == current -> HOLD (never a no-op reset)", () => {
  const d = decideCanaryAction({ deploy: "fail", currentSha: "aaa", lastGoodSha: "aaa" });
  expect(d.action).toBe("hold");
  expect(d.toSha).toBeNull();
});

test("deploy FAILED with no last-good -> HOLD for a human (nothing safe to revert to)", () => {
  const d = decideCanaryAction({ deploy: "fail", currentSha: "bbb", lastGoodSha: null });
  expect(d.action).toBe("hold");
  expect(d.toSha).toBeNull();
  expect(d.reason).toMatch(/human/i);
});

test("deploy PASSED -> promote; current becomes the new last-good", () => {
  const d = decideCanaryAction({ deploy: "pass", currentSha: "ccc", lastGoodSha: "aaa" });
  expect(d.action).toBe("promote");
  expect(d.toSha).toBe("ccc");
});

test("deploy PENDING -> hold", () => {
  expect(decideCanaryAction({ deploy: "pending", currentSha: "x", lastGoodSha: "y" }).action).toBe("hold");
});

test("deploy ABSENT (nothing verified) -> hold, not promote", () => {
  expect(decideCanaryAction({ deploy: "absent", currentSha: "x", lastGoodSha: null }).action).toBe("hold");
});
