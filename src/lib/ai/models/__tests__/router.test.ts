/**
 * Router tests - pure, deterministic selection. No network; env is injected.
 * trackEvent is mocked so logModelSelection's analytics shape is asserted
 * without touching the DB.
 */

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import { trackEvent } from "@/lib/analytics";
import {
  estimateCostUsd,
  logModelSelection,
  selectModel,
} from "../router";
import { getModel } from "../registry";
import type { ModelSelection } from "../types";

const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

/** Build a hermetic env object typed as ProcessEnv for injection. */
function env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

/** Env with both OpenAI + all Azure deployments available. */
const FULL_ENV = env({
  OPENAI_API_KEY: "sk-x",
  AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_DEPLOYMENT_CHEAP: "mini",
  AZURE_OPENAI_DEPLOYMENT_STANDARD: "std",
});

/** Only OpenAI configured. */
const OPENAI_ONLY = env({ OPENAI_API_KEY: "sk-x" });

beforeEach(() => {
  mockedTrackEvent.mockClear();
});

describe("estimateCostUsd", () => {
  it("computes input/output cost per 1k tokens", () => {
    const m = getModel("gpt-4o")!; // 0.0025 in, 0.01 out per 1k
    // 2000 in + 1000 out → 2*0.0025 + 1*0.01 = 0.005 + 0.01 = 0.015
    expect(estimateCostUsd(m, 2000, 1000)).toBeCloseTo(0.015, 9);
  });

  it("treats negative token counts as zero", () => {
    const m = getModel("gpt-4o")!;
    expect(estimateCostUsd(m, -100, -50)).toBe(0);
  });
});

describe("cost-based selection", () => {
  it("picks the cheapest capable model at the default (small) tier", () => {
    const sel = selectModel({}, OPENAI_ONLY);
    // gpt-4o-mini is the cheapest small model; gpt-4o/o4-mini are pricier.
    expect(sel.model.id).toBe("gpt-4o-mini");
    expect(sel.reason).toBe("cheapest_at_tier");
  });

  it("requiredTier filters out cheaper-but-too-weak models", () => {
    const sel = selectModel({ requiredTier: "large" }, OPENAI_ONLY);
    // mini (small, cheapest overall) is excluded by the floor. The chosen
    // model must satisfy >= large. o4-mini (reasoning) is both >= large AND
    // cheaper than gpt-4o by the blend, so the cost-aware router prefers it.
    expect(sel.model.id).not.toBe("gpt-4o-mini");
    expect(sel.model.capabilityTier).not.toBe("small");
    expect(sel.model.id).toBe("o4-mini");
  });

  it("reasoning tier selects an o-series model", () => {
    const sel = selectModel({ requiredTier: "reasoning" }, OPENAI_ONLY);
    expect(sel.model.id).toBe("o4-mini");
    expect(sel.model.capabilityTier).toBe("reasoning");
  });

  it("minContextTokens filters models with too-small windows", () => {
    // 128k models excluded; only the 200k o4-mini fits.
    const sel = selectModel({ minContextTokens: 150_000 }, OPENAI_ONLY);
    expect(sel.model.id).toBe("o4-mini");
  });

  it("weights the blend by token estimates and attaches the estimated cost", () => {
    // Output-heavy call at the large floor. o4-mini is cheapest >= large by
    // the estimate-weighted blend, so it wins and the estimate is attached.
    const sel = selectModel(
      { requiredTier: "large", estInputTokens: 100, estOutputTokens: 10_000 },
      OPENAI_ONLY,
    );
    expect(sel.model.id).toBe("o4-mini");
    expect(sel.estimatedCostUsd).toBeCloseTo(
      estimateCostUsd(getModel("o4-mini")!, 100, 10_000),
      9,
    );
  });
});

describe("pin precedence", () => {
  it("agentPin beats clientPin beats workspacePin", () => {
    const sel = selectModel(
      {
        agentPin: "o4-mini",
        clientPin: "gpt-4o",
        workspacePin: "gpt-4o-mini",
      },
      FULL_ENV,
    );
    expect(sel.model.id).toBe("o4-mini");
    expect(sel.reason).toBe("agent_pin");
  });

  it("falls to clientPin when no agentPin", () => {
    const sel = selectModel(
      { clientPin: "gpt-4o", workspacePin: "gpt-4o-mini" },
      FULL_ENV,
    );
    expect(sel.model.id).toBe("gpt-4o");
    expect(sel.reason).toBe("client_pin");
  });

  it("falls to workspacePin when no agent/client pin", () => {
    const sel = selectModel({ workspacePin: "gpt-4o" }, FULL_ENV);
    expect(sel.model.id).toBe("gpt-4o");
    expect(sel.reason).toBe("workspace_pin");
  });
});

describe("graceful degradation (pins never hard-fail)", () => {
  it("unknown pin id degrades to cost-based with fallbackFrom set", () => {
    const sel = selectModel({ agentPin: "ghost-model" }, OPENAI_ONLY);
    expect(sel.reason).toBe("cheapest_at_tier");
    expect(sel.fallbackFrom).toBe("ghost-model");
    expect(sel.model.id).toBe("gpt-4o-mini");
  });

  it("unavailable pin (azure with no azure env) degrades, records fallbackFrom", () => {
    const sel = selectModel({ clientPin: "azure-gpt-4o" }, OPENAI_ONLY);
    expect(sel.fallbackFrom).toBe("azure-gpt-4o");
    expect(sel.model.provider).toBe("openai");
    expect(sel.reason).toBe("cheapest_at_tier");
  });

  it("records the highest-precedence unusable pin when several are bad", () => {
    const sel = selectModel(
      { agentPin: "ghost-1", clientPin: "ghost-2" },
      OPENAI_ONLY,
    );
    expect(sel.fallbackFrom).toBe("ghost-1");
  });

  it("never throws when everything is unknown/unavailable", () => {
    expect(() =>
      selectModel({ agentPin: "ghost" }, env()),
    ).not.toThrow();
  });
});

describe("downgrade + last-resort", () => {
  it("downgrades when no model at the required tier is available", () => {
    // Only OpenAI configured; ask for reasoning but pretend it's missing by
    // using an env where only azure mini is up (small tier only).
    const azureSmallOnly = env({
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_DEPLOYMENT_CHEAP: "mini",
    });
    const sel = selectModel({ requiredTier: "reasoning" }, azureSmallOnly);
    expect(sel.reason).toBe("downgraded_no_tier_available");
    expect(sel.model.id).toBe("azure-gpt-4o-mini");
  });

  it("returns cheapest registry model when nothing is available at all", () => {
    const sel = selectModel({ requiredTier: "reasoning" }, env());
    expect(sel.reason).toBe("no_model_available_using_default");
    // Cheapest by default blend is one of the mini models.
    expect(sel.model.capabilityTier).toBe("small");
  });
});

describe("determinism", () => {
  it("returns identical decisions for identical inputs", () => {
    const a = selectModel({ requiredTier: "large" }, FULL_ENV);
    const b = selectModel({ requiredTier: "large" }, FULL_ENV);
    expect(a).toEqual(b);
  });

  it("tie-breaks by id when prices and tiers are equal", () => {
    // The two mini models share identical small-tier prices and are the
    // cheapest overall; with both available the id sort puts
    // 'azure-gpt-4o-mini' before 'gpt-4o-mini' deterministically.
    const sel = selectModel({}, FULL_ENV);
    expect(sel.model.capabilityTier).toBe("small");
    expect(sel.model.id).toBe("azure-gpt-4o-mini");
  });
});

describe("logModelSelection analytics shape", () => {
  function selectionFixture(): ModelSelection {
    return {
      model: getModel("gpt-4o")!,
      reason: "cheapest_at_tier",
      estimatedCostUsd: 0.0123,
    };
  }

  it("emits ai.model_selected with the documented payload", () => {
    logModelSelection(selectionFixture(), {
      userId: "u1",
      userRole: "admin",
    });
    expect(mockedTrackEvent).toHaveBeenCalledWith(
      "ai.model_selected",
      "u1",
      "admin",
      expect.objectContaining({
        model_id: "gpt-4o",
        provider: "openai",
        tier: "large",
        reason: "cheapest_at_tier",
        estimated_cost_usd: 0.0123,
      }),
    );
  });

  it("does NOT emit ai.model_fallback when no fallback occurred", () => {
    logModelSelection(selectionFixture(), { userId: "u1", userRole: "admin" });
    const types = mockedTrackEvent.mock.calls.map((c) => c[0]);
    expect(types).toContain("ai.model_selected");
    expect(types).not.toContain("ai.model_fallback");
  });

  it("also emits ai.model_fallback with fallback_from when a pin degraded", () => {
    const sel: ModelSelection = {
      model: getModel("gpt-4o-mini")!,
      reason: "cheapest_at_tier",
      fallbackFrom: "azure-gpt-4o",
    };
    logModelSelection(sel, { userId: "u2", userRole: "member" });
    const types = mockedTrackEvent.mock.calls.map((c) => c[0]);
    expect(types).toContain("ai.model_selected");
    expect(types).toContain("ai.model_fallback");
    expect(mockedTrackEvent).toHaveBeenCalledWith(
      "ai.model_fallback",
      "u2",
      "member",
      expect.objectContaining({ fallback_from: "azure-gpt-4o" }),
    );
  });

  it("merges caller-supplied extra metadata", () => {
    logModelSelection(selectionFixture(), {
      userId: "u1",
      userRole: "admin",
      extra: { feature: "meeting_prep", workflow_id: "wf-9" },
    });
    expect(mockedTrackEvent).toHaveBeenCalledWith(
      "ai.model_selected",
      "u1",
      "admin",
      expect.objectContaining({ feature: "meeting_prep", workflow_id: "wf-9" }),
    );
  });
});
