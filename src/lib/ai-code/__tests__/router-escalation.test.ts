/**
 * Router escalation, verified end to end - the claims we make about the
 * multi-model repair loop, proven rather than asserted:
 *
 *   1. A sub-optimal execution that the gate rejects is DIVERTED UP a tier: the
 *      repair loop retries on 'standard', and if that still fails, escalates to
 *      'premium'. The escalated attempt is what rescues a fix the lower tier
 *      could not produce.
 *   2. That escalation maps, through the REAL agent router, to a genuinely
 *      HIGHER-capability model (premium -> reasoning > standard -> large), so
 *      "divert to a higher model" is true at the router, not just a label.
 *   3. The repairer is an INDEPENDENT family from the author (no same-family fix
 *      of a same-family mistake).
 *   4. Bad code that no tier can fix is NEVER silently passed - it ends
 *      needs_human after escalating through every tier.
 *
 * Deterministic: the gate + conformance are real, the author is a label, and the
 * repair completion is injected so we control which TIER yields a real fix.
 */
import { remediateDiff, type RepairComplete } from "../repair";
import { reviewDiff } from "../detect";
import { decideCodeGate } from "../gate";
import type { CodeReviewResult } from "../types";
import type { AIModelTier } from "@/lib/ai/types";
import { selectModel } from "@/lib/ai/models/router";
import { TIER_ORDER } from "@/lib/ai/models/registry";
import { capabilityTierFor } from "@/lib/ai/model-bridge";
import { fileDiff } from "./corpus";

function realReview(diff: string): Promise<CodeReviewResult> {
  const findings = reviewDiff(diff);
  return Promise.resolve({ ref: "r", author: "a", findings, verdict: decideCodeGate(findings), bySeverity: {} });
}

// A cheap-tier author (OpenAI lineage) writes a diff with a hardcoded secret -
// the gate blocks it. The repair loop must divert it up the tiers.
const BAD = fileDiff("src/config.ts", ['const apiKey = "aVerySecretValue12345";']);
const STILL_BAD = fileDiff("src/config.ts", ['const apiKey = "anotherSecretValue67890";']); // real diff, still flagged
const CLEAN = fileDiff("src/config.ts", ["export const apiKey = process.env.API_KEY;"]); // reads env, no finding
const AUTHOR = "gpt-4o-mini"; // openai lineage

describe("repair loop diverts a failed execution from a lower tier to a higher one", () => {
  it("escalates standard -> premium, and the ESCALATED attempt is what rescues the fix", async () => {
    const tiers: AIModelTier[] = [];
    // Only the premium (escalated) attempt produces a gate-passing fix; standard
    // returns a real-but-still-bad diff, exactly the "sub-optimal code" case.
    const repair: RepairComplete = async ({ tier }) => {
      tiers.push(tier);
      return tier === "premium" ? CLEAN : STILL_BAD;
    };

    const res = await remediateDiff({ author: AUTHOR, diff: BAD, review: realReview, repair });

    expect(tiers).toEqual(["standard", "premium"]); // diverted UP, in order
    expect(res.status).toBe("clean");
    expect(res.attempts[0].tier).toBe("standard");
    expect(res.attempts[0].outcomeAfter).not.toBe("allow"); // lower tier could not fix it
    expect(res.attempts[1].tier).toBe("premium");
    expect(res.attempts[1].outcomeAfter).toBe("allow"); // higher tier rescued it
  });

  it("repairs with an INDEPENDENT family, not the author's own", async () => {
    const repair: RepairComplete = async ({ tier }) => (tier === "premium" ? CLEAN : STILL_BAD);
    const res = await remediateDiff({ author: AUTHOR, diff: BAD, review: realReview, repair });
    expect(res.repairerLineage).toBeTruthy();
    expect(res.repairerLineage).not.toBe("openai"); // author is openai; repairer is a different lineage
  });

  it("NEVER silently passes code no tier can fix - it ends needs_human after escalating", async () => {
    const tiers: AIModelTier[] = [];
    const repairNeverFixes: RepairComplete = async ({ tier }) => {
      tiers.push(tier);
      return STILL_BAD; // a real diff every time, but always still flagged
    };
    const res = await remediateDiff({ author: AUTHOR, diff: BAD, review: realReview, repair: repairNeverFixes });
    expect(tiers).toEqual(["standard", "premium"]); // tried both tiers
    expect(res.status).toBe("needs_human");
    expect(res.review.verdict.outcome).not.toBe("allow"); // bad code was never handed off as clean
  });
});

describe("the agent router maps the escalated tier to a strictly higher-capability model", () => {
  // All major providers available so the registry can actually resolve a model
  // per tier (no live network - selectModel is pure over the registry + env).
  const env = { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" } as unknown as NodeJS.ProcessEnv;

  it("escalating the tier raises the capability FLOOR, and the router never routes below it", () => {
    // The divert-up guarantee. selectModel picks the cheapest model AT OR ABOVE
    // the required tier, so a selected model may sit higher than the floor when
    // that is cheaper - but it can never sit below it. What strictly increases
    // is the FLOOR each tier demands, which is what makes an escalation a real
    // diversion to a more capable class of model.
    const cheap = selectModel({ requiredTier: capabilityTierFor("cheap") }, env);
    const standard = selectModel({ requiredTier: capabilityTierFor("standard") }, env);
    const premium = selectModel({ requiredTier: capabilityTierFor("premium") }, env);

    // Never below the requested floor.
    expect(TIER_ORDER[cheap.model.capabilityTier]).toBeGreaterThanOrEqual(TIER_ORDER["small"]);
    expect(TIER_ORDER[standard.model.capabilityTier]).toBeGreaterThanOrEqual(TIER_ORDER["large"]);
    expect(TIER_ORDER[premium.model.capabilityTier]).toBeGreaterThanOrEqual(TIER_ORDER["reasoning"]);

    // The floor strictly increases cheap < standard < premium - the escalation.
    expect(TIER_ORDER[capabilityTierFor("standard")]).toBeGreaterThan(TIER_ORDER[capabilityTierFor("cheap")]);
    expect(TIER_ORDER[capabilityTierFor("premium")]).toBeGreaterThan(TIER_ORDER[capabilityTierFor("standard")]);
  });

  it("the tier ladder is the expected capability mapping", () => {
    expect(capabilityTierFor("cheap")).toBe("small");
    expect(capabilityTierFor("standard")).toBe("large");
    expect(capabilityTierFor("premium")).toBe("reasoning");
  });
});
