/**
 * Campaign red-team regression: every hostile campaign in the committed corpus is
 * still detected, every benign session is still clear, and the gap is scored with
 * the SAME scorer the single-request red-team uses. If a future change to the
 * detector stops catching a known campaign shape, or starts flagging a real user's
 * session, this fails.
 */
import { AI_REDTEAM_CAMPAIGNS, runCampaignCases, scoreCampaignGap } from "../campaign-redteam";

const score = scoreCampaignGap(AI_REDTEAM_CAMPAIGNS);

it("every hostile campaign is detected (100%, zero slips)", () => {
  expect(score.hostile).toBeGreaterThanOrEqual(4);
  expect(score.slips).toEqual([]);
  expect(score.preventedPct).toBe(100);
});

it("every benign multi-page session is clear (zero false campaign flags)", () => {
  expect(AI_REDTEAM_CAMPAIGNS.filter((c) => !c.intendedHostile).length).toBeGreaterThanOrEqual(3);
  expect(score.falsePositiveCases).toEqual([]);
});

it("reuses the gap scorer: outcomes map one campaign -> one decided outcome", () => {
  const outcomes = runCampaignCases(AI_REDTEAM_CAMPAIGNS);
  expect(outcomes).toHaveLength(AI_REDTEAM_CAMPAIGNS.length);
  // a hostile campaign resolves to blocked=true, a benign one to blocked=false
  expect(outcomes.find((o) => o.name === "recon then exfiltration")?.blocked).toBe(true);
  expect(outcomes.find((o) => o.name === "a real login flow")?.blocked).toBe(false);
});
