/** composeRefinePrompt: pass-through without a prior change; a complete-revision
 *  instruction with one; capped so a huge prior never bloats the prompt. */
import { composeRefinePrompt } from "../refine";

describe("composeRefinePrompt", () => {
  it("passes the instruction through unchanged when there is no prior change (ordinary run)", () => {
    expect(composeRefinePrompt("add a clamp()")).toBe("add a clamp()");
    expect(composeRefinePrompt("add a clamp()", "   ")).toBe("add a clamp()");
  });
  it("composes a complete-revision prompt carrying the prior change + instruction", () => {
    const out = composeRefinePrompt("make it handle negatives", "export const clamp = ...");
    expect(out).toContain("EXISTING CHANGE:");
    expect(out).toContain("export const clamp = ...");
    expect(out).toContain("INSTRUCTION:");
    expect(out).toContain("make it handle negatives");
    expect(out).toMatch(/COMPLETE revised change/i);
  });
  it("caps a huge prior change so the prompt never bloats", () => {
    const huge = "x".repeat(50000);
    const out = composeRefinePrompt("tweak", huge, 100);
    expect(out).toContain("… (truncated)");
    expect(out.length).toBeLessThan(500);
  });
});
