/**
 * The dependency-review gate: a new runtime dependency stops for a human; no
 * change to dependencies clears. Reuses the invariant detector, so it is
 * deterministic and needs no model.
 */
import { dependencyReviewGate } from "@/lib/gates/dependency-review-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };

const addDepDiff = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,4 +1,5 @@\n   "dependencies": {\n     "next": "16.0.0",\n+    "left-pad": "^1.3.0",\n     "react": "19.0.0"\n   }\n';
const codeOnlyDiff = "diff --git a/src/x.ts b/src/x.ts\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n";

it("require_human when a runtime dependency is added", async () => {
  const r = await runGate(dependencyReviewGate, { diff: addDepDiff }, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.output?.addedDependencies).toContain("left-pad");
  expect(r.reason).toMatch(/left-pad/);
  expect(r.transparency.modelInvoked).toBeNull();
});

it("allow when the change adds no dependency", async () => {
  const r = await runGate(dependencyReviewGate, { diff: codeOnlyDiff }, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.output?.addedDependencies).toEqual([]);
});
