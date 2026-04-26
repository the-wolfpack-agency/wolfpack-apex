/** @jest-environment jsdom */
/**
 * Unit tests for buildOnboardingSteps() — the helper that drives the
 * first-run onboarding checklist on the dashboard home page.
 *
 * The helper is a pure function so we don't have to render the page
 * (which has 7+ side-effecting useEffects). We just feed it the
 * /api/workspace/status payload and assert the right step shape.
 */

import { buildOnboardingSteps } from "@/app/(dashboard)/page";

describe("buildOnboardingSteps", () => {
  test("returns 3 steps in the documented order", () => {
    const steps = buildOnboardingSteps(null);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.key)).toEqual(["profile", "integrations", "team"]);
  });

  test("all steps default to undone when status is null", () => {
    const steps = buildOnboardingSteps(null);
    expect(steps.every((s) => s.done === false)).toBe(true);
  });

  test("each step exposes a CTA href + label", () => {
    const steps = buildOnboardingSteps(null);
    for (const s of steps) {
      expect(s.ctaHref).toBeTruthy();
      expect(s.ctaLabel).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.description).toBeTruthy();
    }
  });

  test("flips done flag when /api/workspace/status reports the step complete", () => {
    const steps = buildOnboardingSteps({
      complete: false,
      steps: { profile: true, team: false, integrations: false },
      nextStep: "integrations",
    });
    const profile = steps.find((s) => s.key === "profile")!;
    const team = steps.find((s) => s.key === "team")!;
    const integrations = steps.find((s) => s.key === "integrations")!;
    expect(profile.done).toBe(true);
    expect(team.done).toBe(false);
    expect(integrations.done).toBe(false);
  });

  test("CTA label changes from 'Set up …' to 'Edit …' when step is done", () => {
    const undone = buildOnboardingSteps({
      complete: false,
      steps: { profile: false, team: false, integrations: false },
      nextStep: "profile",
    }).find((s) => s.key === "profile")!;
    const done = buildOnboardingSteps({
      complete: true,
      steps: { profile: true, team: true, integrations: true },
      nextStep: "complete",
    }).find((s) => s.key === "profile")!;
    expect(undone.ctaLabel).toMatch(/set up/i);
    expect(done.ctaLabel).toMatch(/edit/i);
  });

  test("CTA hrefs route to the right page per step", () => {
    const steps = buildOnboardingSteps(null);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.ctaHref]));
    expect(byKey.profile).toBe("/setup");
    expect(byKey.integrations).toBe("/settings");
    expect(byKey.team).toBe("/hr");
  });

  test("all done → every step.done is true (caller can suppress whole banner)", () => {
    const steps = buildOnboardingSteps({
      complete: true,
      steps: { profile: true, team: true, integrations: true },
      nextStep: "complete",
    });
    expect(steps.every((s) => s.done)).toBe(true);
  });
});
