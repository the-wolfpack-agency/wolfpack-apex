/**
 * Pure value tests for the demo seed. We do NOT exercise the DB here; instead we
 * prove the seed's INPUTS will actually produce a compelling, honest demo when
 * run through the real (pure) gate + detector path:
 *
 *  - the sample source corpus surfaces multiple AI providers AND a leaked key,
 *    so the Discover beat shows an ungoverned gap.
 *  - the demo actions, run through the real buildAction + decide, cover the full
 *    outcome spread (allow / transform / escalate / deny) and produce at least
 *    one would-block under enforce, so the Govern beat is not all-green theatre.
 *
 * This is the guard that the demo can never silently degrade into a flat,
 * unconvincing state.
 */

import { demoActions, demoSourceFiles } from "../demo-seed";
import { detectAiSurfaces } from "@/lib/ai-surface/detect";
import { buildAction } from "../action";
import { decide } from "../policy";

test("the sample corpus surfaces multiple providers incl. a leaked key (an ungoverned gap to show)", () => {
  const surfaces = demoSourceFiles().flatMap((f) => detectAiSurfaces(f));
  expect(surfaces.length).toBeGreaterThan(2);
  const providers = new Set(surfaces.map((s) => s.provider));
  // More than one provider so the inventory looks real, not a single line.
  expect(providers.size).toBeGreaterThan(1);
  // A leaked key surface is the sellable "ungoverned AI" signal.
  expect(surfaces.some((s) => s.kind === "api_key")).toBe(true);
});

test("the demo actions cover the full outcome spread and force at least one block", () => {
  const outcomes = new Set<string>();
  let wouldBlock = 0;
  for (const { input, mode } of demoActions()) {
    const { action } = buildAction(input);
    const decision = decide(action, { mode });
    outcomes.add(decision.intendedOutcome);
    if (decision.wouldBlock) wouldBlock += 1;
  }
  // allow (read), transform (PII outbound), escalate (high-risk mutation),
  // deny (secret in params) - the spread that makes the gate demo land.
  expect(outcomes).toEqual(new Set(["allow", "transform", "escalate", "deny"]));
  // The secret-bearing export under enforce must be a would-block.
  expect(wouldBlock).toBeGreaterThanOrEqual(1);
});
