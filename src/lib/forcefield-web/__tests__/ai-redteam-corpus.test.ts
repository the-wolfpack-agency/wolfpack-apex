/**
 * Regression gate for the AI red-team corpus: every novel attack the AI found and
 * we ruled must STAY blocked, and every benign lookalike must STAY allowed. A gap,
 * once closed, stays closed; and hardening against clever attacks must never start
 * turning real users away. Runs the committed corpus through the REAL engine via
 * the same gap scorer the offline red-team uses, so the CI number and the factory
 * number are computed identically.
 */
import { AI_REDTEAM_CORPUS } from "../ai-redteam-corpus";
import { scoreGapForCases } from "../gap-metric";

const score = scoreGapForCases(AI_REDTEAM_CORPUS);

it("every AI-discovered attack is still prevented (100%, zero slips)", () => {
  expect(score.hostile).toBeGreaterThanOrEqual(10);
  expect(score.slips).toEqual([]);
  expect(score.preventedPct).toBe(100);
});

it("every benign lookalike is still allowed (zero false positives)", () => {
  expect(AI_REDTEAM_CORPUS.filter((c) => !c.intendedHostile).length).toBeGreaterThanOrEqual(3);
  expect(score.falsePositiveCases).toEqual([]);
});
