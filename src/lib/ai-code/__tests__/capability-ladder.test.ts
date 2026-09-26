/**
 * The ladder must: start cheap and escalate only on failure; STOP at the first
 * tier that meets the standard (never pay for a higher tier once cleared);
 * record which tier cleared it; reject a gamed diff as a non-pass and escalate;
 * and never throw on an unavailable tier.
 */
import { runCapabilityLadder, type AuthorAtTier, type RunOracle } from "../capability-ladder";
import type { AuthorResult } from "../author";
import type { AIModelTier } from "@/lib/ai/types";

const DIFF = "diff --git a/src/add.ts b/src/add.ts\n--- /dev/null\n+++ b/src/add.ts\n@@ -0,0 +1 @@\n+export const add = (a,b) => a+b;";
const GAMING_DIFF = "diff --git a/src/add.test.ts b/src/add.test.ts\n--- a/src/add.test.ts\n+++ b/src/add.test.ts\n@@ -1 +1 @@\n-expect(add(1,2)).toBe(3)\n+expect(true).toBe(true)";

function authored(tier: AIModelTier, over: Partial<AuthorResult> = {}): AuthorResult {
  const providerByTier: Record<AIModelTier, string> = { cheap: "azure-openai", standard: "azure-openai", premium: "anthropic" };
  return { diff: DIFF, author: `model-${tier}`, provider: providerByTier[tier], costUsd: tier === "premium" ? 0.02 : 0.0003, latencyMs: 500, error: null, ...over };
}

const TASK = { id: "add", prompt: "write add()", gradedBy: ["src/add.test.ts"] };

describe("runCapabilityLadder", () => {
  it("cheap passes -> stops immediately, premium never attempted", async () => {
    const seen: AIModelTier[] = [];
    const author: AuthorAtTier = async (t) => { seen.push(t); return authored(t); };
    const runOracle: RunOracle = async () => ({ passed: true, detail: "3 tests passed" });
    const res = await runCapabilityLadder({ task: TASK, author, runOracle });
    expect(res.clearedBy).toBe("cheap");
    expect(res.attempts).toHaveLength(1);
    expect(seen).toEqual(["cheap"]); // did NOT escalate
  });

  it("cheap fails the oracle -> escalates to standard, which passes", async () => {
    const author: AuthorAtTier = async (t) => authored(t);
    // cheap fails, standard passes
    const oracleByTier: Record<string, boolean> = { "model-cheap": false, "model-standard": true };
    const runOracle: RunOracle = async (_d) => ({ passed: false, detail: "1 test failed" });
    // drive pass/fail off the authoring model via a stateful stub
    let call = 0;
    const staged: RunOracle = async () => { call++; return { passed: call >= 2, detail: call >= 2 ? "passed" : "failed" }; };
    void oracleByTier; void runOracle;
    const res = await runCapabilityLadder({ task: TASK, author, runOracle: staged });
    expect(res.attempts.map((a) => a.tier)).toEqual(["cheap", "standard"]);
    expect(res.attempts[0].oraclePassed).toBe(false);
    expect(res.clearedBy).toBe("standard");
    expect(res.totalCostUsd).toBeGreaterThan(0);
  });

  it("no tier meets the standard -> clearedBy null, all tiers attempted", async () => {
    const author: AuthorAtTier = async (t) => authored(t);
    const runOracle: RunOracle = async () => ({ passed: false, detail: "failed" });
    const res = await runCapabilityLadder({ task: TASK, author, runOracle });
    expect(res.clearedBy).toBeNull();
    expect(res.attempts.map((a) => a.tier)).toEqual(["cheap", "standard", "premium"]);
    expect(res.summary).toMatch(/no tier met the standard/);
  });

  it("a gamed diff (edits the graded test) is rejected and does NOT count as a pass", async () => {
    // cheap games the oracle; standard writes an honest diff that passes.
    const author: AuthorAtTier = async (t) => (t === "cheap" ? authored(t, { diff: GAMING_DIFF }) : authored(t));
    const runOracle: RunOracle = async () => ({ passed: true, detail: "passed" });
    const res = await runCapabilityLadder({ task: TASK, author, runOracle });
    expect(res.attempts[0].gamed).toBe(true);
    expect(res.attempts[0].gamingReasons).toContain("edited_graded_test");
    expect(res.attempts[0].oraclePassed).toBe(false);
    expect(res.clearedBy).toBe("standard"); // escalated past the cheat
  });

  it("an unavailable tier is recorded and escalated past, never thrown", async () => {
    const author: AuthorAtTier = async (t) =>
      t === "cheap" ? authored(t, { diff: "", error: "NoProviderAvailableError" }) : authored(t);
    const runOracle: RunOracle = async () => ({ passed: true, detail: "passed" });
    const res = await runCapabilityLadder({ task: TASK, author, runOracle });
    expect(res.attempts[0].diffPresent).toBe(false);
    expect(res.attempts[0].error).toMatch(/NoProvider/);
    expect(res.clearedBy).toBe("standard");
  });
});
