/**
 * The producer for the dependency invariant: measure net runtime-dependency
 * change from a diff, and confirm it drives the OGIAM registry to escalate.
 * Decidable and pure - the rule lives in the registry, this only measures.
 */
import { dependencyFactsFromDiff, evaluateChangeInvariants } from "../change-facts";

const ADD_RUNTIME_DEP = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -5,6 +5,7 @@
   "dependencies": {
     "next": "16.0.0",
+    "left-pad": "^1.3.0",
     "react": "19.0.0"
   },`;

const ADD_DEV_DEP_ONLY = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,6 +20,7 @@
   "devDependencies": {
     "jest": "30.0.0",
+    "eslint": "9.0.0",
     "typescript": "5.6.0"
   },`;

const REMOVE_RUNTIME_DEP = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -5,7 +5,6 @@
   "dependencies": {
     "next": "16.0.0",
-    "left-pad": "^1.3.0",
     "react": "19.0.0"
   },`;

const NON_PACKAGE_DIFF = `diff --git a/src/x.ts b/src/x.ts
--- /dev/null
+++ b/src/x.ts
@@ -0,0 +1 @@
+export const add = (a, b) => a + b;`;

describe("dependencyFactsFromDiff", () => {
  it("counts an added runtime dependency", () => {
    const f = dependencyFactsFromDiff(ADD_RUNTIME_DEP);
    expect(f.dependencyDelta).toBe(1);
    expect(f.addedDependencies).toEqual(["left-pad"]);
  });
  it("does NOT count a devDependency (it does not ship)", () => {
    const f = dependencyFactsFromDiff(ADD_DEV_DEP_ONLY);
    expect(f.dependencyDelta).toBe(0);
    expect(f.addedDependencies).toEqual([]);
  });
  it("treats a removed runtime dependency as a negative delta", () => {
    const f = dependencyFactsFromDiff(REMOVE_RUNTIME_DEP);
    expect(f.dependencyDelta).toBe(-1);
    expect(f.removedDependencies).toEqual(["left-pad"]);
  });
  it("is zero for a change that does not touch package.json", () => {
    expect(dependencyFactsFromDiff(NON_PACKAGE_DIFF).dependencyDelta).toBe(0);
  });
});

describe("evaluateChangeInvariants (drives the OGIAM registry)", () => {
  it("ESCALATES a change that adds a runtime dependency", () => {
    const { decision, facts } = evaluateChangeInvariants(ADD_RUNTIME_DEP);
    expect(facts.dependencyDelta).toBe(1);
    expect(decision.ruleId).toBe("R-DEPENDENCY-ADDED-ESCALATE");
    expect(decision.wouldBlock).toBe(true);
  });
  it("does NOT block a change that adds only a devDependency", () => {
    const { decision } = evaluateChangeInvariants(ADD_DEV_DEP_ONLY);
    expect(decision.wouldBlock).toBe(false);
  });
  it("DENIES when CI has not fully passed", () => {
    const { decision } = evaluateChangeInvariants(NON_PACKAGE_DIFF, { ciComplete: false });
    expect(decision.ruleId).toBe("R-CI-INCOMPLETE-DENY");
    expect(decision.wouldBlock).toBe(true);
  });
  it("DENIES a plan that would deploy more than once", () => {
    const { decision } = evaluateChangeInvariants(NON_PACKAGE_DIFF, { deploymentCount: 2 });
    expect(decision.ruleId).toBe("R-DEPLOY-ONCE-DENY");
    expect(decision.wouldBlock).toBe(true);
  });
  it("allows a clean change with no added deps, green CI, single deploy", () => {
    const { decision } = evaluateChangeInvariants(NON_PACKAGE_DIFF, { ciComplete: true, deploymentCount: 1 });
    expect(decision.wouldBlock).toBe(false);
  });
});
