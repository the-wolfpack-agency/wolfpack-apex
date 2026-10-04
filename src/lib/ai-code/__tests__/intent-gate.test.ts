/**
 * Intent gate: a non-request (greeting / too short / no actionable signal) is
 * rejected BEFORE authoring; a genuine change request always passes.
 * Found by dogfooding: "hello" authored a change and cleared every gate.
 */
import { looksLikeChangeRequest, NOT_A_REQUEST_MESSAGE } from "@/lib/ai-code/intent-gate";

describe("looksLikeChangeRequest - rejects non-requests", () => {
  it.each(["hello", "hi", "hey there", "thanks!", "ok", "test", "gm", "how are you?", "", "   ", "cool nice", "stuff"])(
    "rejects %p",
    (p) => {
      const v = looksLikeChangeRequest(p);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe(NOT_A_REQUEST_MESSAGE);
    },
  );
  it("rejects real prose that names no action and no file", () => {
    expect(looksLikeChangeRequest("the weather is really nice today").ok).toBe(false);
  });
  it("rejects a no-signal two-word fragment", () => {
    expect(looksLikeChangeRequest("the thing").ok).toBe(false);
  });
});

describe("looksLikeChangeRequest - passes genuine requests", () => {
  it.each([
    "add a rate limit to the login route",
    "Fix the failing CI check on the migrations job",
    "refactor the cost helpers to remove duplication",
    "update src/components/ai-code/factory-chat/neon.ts accent color",
    "create a new API route for health checks",
    "write tests for the intent gate",
    "optimize the reuse scout query",
    "add k",
    "edit src/x.ts",
    "tweak policy",
    "add route",
    "add a test",
    "change x to 2",
    "fix it",
  ])("passes %p", (p) => {
    expect(looksLikeChangeRequest(p).ok).toBe(true);
  });
  it("passes when a file is named even without a classic verb", () => {
    expect(looksLikeChangeRequest("src/lib/ai-code/intent-gate.ts needs the greeting list expanded").ok).toBe(true);
  });
  it("passes a bug report (problem signal, no action verb)", () => {
    expect(looksLikeChangeRequest("the login page crashes on submit").ok).toBe(true);
    expect(looksLikeChangeRequest("the dashboard is slow and flaky").ok).toBe(true);
  });
});
