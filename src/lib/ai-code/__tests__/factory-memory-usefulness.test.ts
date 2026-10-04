/**
 * #7 memory usefulness: referencesPath detects that an authored diff actually USED
 * a suggested reuse path (edited the file, named it, or imported the module);
 * markReuseUsage sets `used` on reuse entries only. Pure, deterministic.
 */
import { referencesPath, markReuseUsage } from "@/lib/ai-code/factory-memory-usefulness";

const diffAdding = (lines: string[]) =>
  `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n${lines.map((l) => "+" + l).join("\n")}`;

describe("referencesPath", () => {
  it("matches the @/ alias import of the suggested module", () => {
    const diff = diffAdding([`import { costSummary } from "@/lib/ai-code/cost-summary";`]);
    expect(referencesPath(diff, "src/lib/ai-code/cost-summary.ts")).toBe(true);
  });
  it("matches a relative import ending in the module tail", () => {
    const diff = diffAdding([`import { foo } from "../ai-code/cost-summary";`]);
    expect(referencesPath(diff, "src/lib/ai-code/cost-summary.ts")).toBe(true);
  });
  it("matches when the author edits the very file (path in a diff header)", () => {
    const diff = `diff --git a/src/lib/ai-code/cost-summary.ts b/src/lib/ai-code/cost-summary.ts\n--- a/src/lib/ai-code/cost-summary.ts\n+++ b/src/lib/ai-code/cost-summary.ts\n@@ -1 +1 @@\n+export const x = 1;`;
    expect(referencesPath(diff, "src/lib/ai-code/cost-summary.ts")).toBe(true);
  });
  it("does NOT match when the module is never referenced", () => {
    const diff = diffAdding([`import { other } from "@/lib/ai-code/unrelated";`, `const y = 2;`]);
    expect(referencesPath(diff, "src/lib/ai-code/cost-summary.ts")).toBe(false);
  });
  it("is false on empty inputs", () => {
    expect(referencesPath("", "src/a.ts")).toBe(false);
    expect(referencesPath(diffAdding(["x"]), "")).toBe(false);
  });
});

describe("markReuseUsage", () => {
  it("sets used per reuse entry from the diff; leaves failure entries alone", () => {
    const diff = diffAdding([`import { a } from "@/lib/ai-code/used-mod";`]);
    const out = markReuseUsage(
      [
        { kind: "reuse", key: "src/lib/ai-code/used-mod.ts" },
        { kind: "reuse", key: "src/lib/ai-code/ignored-mod.ts" },
        { kind: "failure", key: "sig:logged_secret" },
      ],
      diff,
    );
    expect(out[0]).toEqual({ kind: "reuse", key: "src/lib/ai-code/used-mod.ts", used: true });
    expect(out[1]).toEqual({ kind: "reuse", key: "src/lib/ai-code/ignored-mod.ts", used: false });
    expect(out[2]).toEqual({ kind: "failure", key: "sig:logged_secret" });
  });
});
