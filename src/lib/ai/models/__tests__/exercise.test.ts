/**
 * Proving the harness before trusting what it says about a deployment.
 *
 * The test that matters is the one asserting a single-model environment reports
 * switching as NOT proven. Every scenario passes in that environment — because
 * there is one model and it is always the answer — and reading that as "the
 * router works" is exactly the false confidence this exists to prevent.
 */
import { missingConfigForSwitching, runExercise, SCENARIOS } from "../exercise";

const env = (over: Record<string, string> = {}) => over as unknown as NodeJS.ProcessEnv;

const AZURE_BASE = {
  AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
  AZURE_OPENAI_API_KEY: "k",
};

describe("one model is not a switching proof", () => {
  it("reports switching as NOT proven when only one model is configured", () => {
    // The whole point. Ten green ticks from an environment with one model says
    // the router had no choice, not that it chooses well.
    const report = runExercise(env({ ...AZURE_BASE, AZURE_OPENAI_DEPLOYMENT_CHEAP: "cheap" }));
    expect(report.availableModels).toHaveLength(1);
    expect(report.switchingProven).toBe(false);
    expect(report.problems).toEqual([]);
    expect(report.headline).toMatch(/proved the router had no choice/);
  });

  it("tells you exactly what to add", () => {
    const steps = missingConfigForSwitching(env({ ...AZURE_BASE, AZURE_OPENAI_DEPLOYMENT_CHEAP: "cheap" }));
    expect(steps.join(" ")).toMatch(/AZURE_OPENAI_DEPLOYMENT_STANDARD/);
    expect(steps.join(" ")).toMatch(/large-tier option to switch UP to/);
  });

  it("says plainly when nothing is configured at all", () => {
    const report = runExercise(env());
    expect(report.availableModels).toEqual([]);
    expect(report.switchingProven).toBe(false);
    expect(report.headline).toMatch(/proves nothing about switching/);
  });

  it("names both providers as options when neither is set", () => {
    expect(missingConfigForSwitching(env()).join(" ")).toMatch(/no provider is configured at all/);
  });
});

describe("with two tiers configured, it proves real switching", () => {
  const twoTier = env({ ...AZURE_BASE, AZURE_OPENAI_DEPLOYMENT_CHEAP: "cheap", AZURE_OPENAI_DEPLOYMENT_STANDARD: "std" });

  it("observes the router selecting more than one model", () => {
    const report = runExercise(twoTier);
    expect(report.switchingProven).toBe(true);
    expect(report.modelsUsed.length).toBeGreaterThan(1);
  });

  it("sends cheap work to the small tier and capable work to the large one", () => {
    // The efficiency claim, checked rather than assumed.
    const report = runExercise(twoTier);
    const cheap = report.results.find((r) => r.scenario === "cheap work")!;
    const capable = report.results.find((r) => r.scenario === "capable work")!;
    expect(cheap.tier).toBe("small");
    expect(capable.tier).toBe("large");
    expect(cheap.modelId).not.toBe(capable.modelId);
  });

  it("honours a pin over cost", () => {
    const report = runExercise(twoTier);
    const pinned = report.results.find((r) => r.scenario === "agent pin honoured")!;
    expect(pinned.modelId).toBe("azure-gpt-4o");
    expect(pinned.reason).toBe("agent_pin");
  });

  it("records what an unusable pin degraded from", () => {
    // A pin that silently vanished would hide a misconfiguration.
    const report = runExercise(twoTier);
    const degraded = report.results.find((r) => r.scenario === "pin that does not exist")!;
    expect(degraded.fallbackFrom).toBe("not-a-real-model");
  });

  it("reports no problems when the router behaves", () => {
    const report = runExercise(twoTier);
    expect(report.problems).toEqual([]);
    expect(report.headline).toMatch(/every one behaved correctly/);
  });

  it("attaches a cost estimate wherever tokens were estimated", () => {
    const report = runExercise(twoTier);
    const withTokens = report.results.filter((r) =>
      SCENARIOS.find((s) => s.name === r.scenario)?.opts.estInputTokens,
    );
    for (const r of withTokens) expect(typeof r.estimatedCostUsd).toBe("number");
  });
});

describe("it does not cry wolf on an unconfigured environment", () => {
  it("treats 'no model available' as an honest answer, not a problem", () => {
    // Every developer machine is in this state. A harness that reports FAIL
    // lines here would be ignored by its second run, and then it would be
    // ignored on the run that mattered.
    const report = runExercise(env());
    expect(report.problems).toEqual([]);
    for (const r of report.results) expect(r.problem).toBeNull();
  });
});

describe("it catches the router misbehaving", () => {
  it("flags a tier downgrade that was not reported as one", () => {
    // Constructed by asking for a tier nothing satisfies. The router must
    // either meet it or say downgraded_no_tier_available — silently returning
    // something weaker is the failure.
    const report = runExercise(env({ ...AZURE_BASE, AZURE_OPENAI_DEPLOYMENT_CHEAP: "cheap" }));
    const reasoning = report.results.find((r) => r.scenario === "reasoning work")!;
    // Only the cheap small model exists, so this MUST be an honest downgrade.
    expect(reasoning.reason).toBe("downgraded_no_tier_available");
    expect(reasoning.problem).toBeNull();
  });

  it("exercises every decision the router can make", () => {
    // A harness that only tests the happy path proves the happy path.
    const reasons = new Set(runExercise(env({ ...AZURE_BASE, AZURE_OPENAI_DEPLOYMENT_CHEAP: "cheap", AZURE_OPENAI_DEPLOYMENT_STANDARD: "std" })).results.map((r) => r.reason));
    expect(reasons.has("cheapest_at_tier")).toBe(true);
    expect(reasons.has("agent_pin")).toBe(true);
  });
});
