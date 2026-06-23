/**
 * src/lib/ai/__tests__/workspace-policy.test.ts
 *
 * Covers:
 *   resolvePolicy
 *     1. clamp-down: premium request + standard cap -> standard, capped=true
 *     2. clamp-down: premium request + cheap cap -> cheap, capped=true
 *     3. no-escalate: cheap request + premium cap -> cheap, capped=false
 *     4. exact-match: standard request + standard cap -> standard, capped=false
 *     5. null policy passthrough (no restriction)
 *     6. policy with null max_tier passthrough
 *     7. provider_override is forwarded on capped result
 *     8. provider_override is forwarded on uncapped result
 *     9. provider_override undefined when policy is null
 *
 *   loadWorkspacePolicy
 *     10. returns row from queryFn
 *     11. empty workspaceId -> null, queryFn never called
 *     12. whitespace-only workspaceId -> null, queryFn never called
 *     13. queryFn returns empty rows -> null
 *     14. queryFn throws -> null (never re-throws)
 *     15. queryFn rejects with non-Error value -> null
 *
 *   isOverBudget
 *     16. null policy -> false
 *     17. policy with null budget -> false
 *     18. spend below budget -> false
 *     19. spend exactly at budget -> false (not strictly over)
 *     20. spend over budget -> true
 *
 *   buildPolicyEventMetadata
 *     21. shape: provider_override present
 *     22. shape: provider_override undefined -> null in output
 *     23. capped=true reflected
 */

import {
  resolvePolicy,
  loadWorkspacePolicy,
  isOverBudget,
  buildPolicyEventMetadata,
} from "../workspace-policy";
import type { WorkspaceAIPolicy, ModelTier } from "../workspace-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(
  overrides: Partial<WorkspaceAIPolicy> = {},
): WorkspaceAIPolicy {
  return {
    workspace_id: "ws_test",
    max_tier: null,
    provider_override: undefined,
    monthly_budget_usd: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolvePolicy
// ---------------------------------------------------------------------------

describe("resolvePolicy", () => {
  test("1. clamp-down: premium request + standard cap -> standard, capped=true", () => {
    const policy = makePolicy({ max_tier: "standard" });
    const result = resolvePolicy("premium", policy);
    expect(result.tier).toBe("standard");
    expect(result.capped).toBe(true);
  });

  test("2. clamp-down: premium request + cheap cap -> cheap, capped=true", () => {
    const policy = makePolicy({ max_tier: "cheap" });
    const result = resolvePolicy("premium", policy);
    expect(result.tier).toBe("cheap");
    expect(result.capped).toBe(true);
  });

  test("3. no-escalate: cheap request + premium cap -> cheap, capped=false", () => {
    const policy = makePolicy({ max_tier: "premium" });
    const result = resolvePolicy("cheap", policy);
    expect(result.tier).toBe("cheap");
    expect(result.capped).toBe(false);
  });

  test("4. exact-match: standard request + standard cap -> standard, capped=false", () => {
    const policy = makePolicy({ max_tier: "standard" });
    const result = resolvePolicy("standard", policy);
    expect(result.tier).toBe("standard");
    expect(result.capped).toBe(false);
  });

  test("5. null policy passthrough", () => {
    const result = resolvePolicy("premium", null);
    expect(result.tier).toBe("premium");
    expect(result.capped).toBe(false);
    expect(result.provider_override).toBeUndefined();
  });

  test("6. policy with null max_tier passthrough", () => {
    const policy = makePolicy({ max_tier: null });
    const result = resolvePolicy("premium", policy);
    expect(result.tier).toBe("premium");
    expect(result.capped).toBe(false);
  });

  test("7. provider_override forwarded on clamped result", () => {
    const policy = makePolicy({ max_tier: "cheap", provider_override: "anthropic" });
    const result = resolvePolicy("premium", policy);
    expect(result.provider_override).toBe("anthropic");
  });

  test("8. provider_override forwarded on uncapped result", () => {
    const policy = makePolicy({ max_tier: "premium", provider_override: "azure-openai" });
    const result = resolvePolicy("cheap", policy);
    expect(result.provider_override).toBe("azure-openai");
  });

  test("9. provider_override undefined when policy is null", () => {
    const result = resolvePolicy("standard", null);
    expect(result.provider_override).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadWorkspacePolicy
// ---------------------------------------------------------------------------

describe("loadWorkspacePolicy", () => {
  const fakeRow: WorkspaceAIPolicy = {
    workspace_id: "ws_finance",
    max_tier: "premium",
    provider_override: "anthropic",
    monthly_budget_usd: 500,
  };

  test("10. returns the row from queryFn", async () => {
    const queryFn = jest.fn().mockResolvedValue({ rows: [fakeRow] });
    const result = await loadWorkspacePolicy("ws_finance", queryFn);
    expect(result).toEqual(fakeRow);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledWith(
      expect.stringContaining("workspace_ai_policy"),
      ["ws_finance"],
    );
  });

  test("11. empty workspaceId -> null, queryFn never called", async () => {
    const queryFn = jest.fn();
    const result = await loadWorkspacePolicy("", queryFn);
    expect(result).toBeNull();
    expect(queryFn).not.toHaveBeenCalled();
  });

  test("12. whitespace-only workspaceId -> null, queryFn never called", async () => {
    const queryFn = jest.fn();
    const result = await loadWorkspacePolicy("   ", queryFn);
    expect(result).toBeNull();
    expect(queryFn).not.toHaveBeenCalled();
  });

  test("13. queryFn returns empty rows -> null", async () => {
    const queryFn = jest.fn().mockResolvedValue({ rows: [] });
    const result = await loadWorkspacePolicy("ws_unknown", queryFn);
    expect(result).toBeNull();
  });

  test("14. queryFn throws Error -> null, never re-throws", async () => {
    const queryFn = jest.fn().mockRejectedValue(new Error("DB connection refused"));
    await expect(loadWorkspacePolicy("ws_x", queryFn)).resolves.toBeNull();
  });

  test("15. queryFn rejects with non-Error value -> null", async () => {
    const queryFn = jest.fn().mockRejectedValue("some string error");
    await expect(loadWorkspacePolicy("ws_x", queryFn)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isOverBudget
// ---------------------------------------------------------------------------

describe("isOverBudget", () => {
  test("16. null policy -> false", () => {
    expect(isOverBudget(null, 1000)).toBe(false);
  });

  test("17. policy with null monthly_budget_usd -> false", () => {
    expect(isOverBudget(makePolicy({ monthly_budget_usd: null }), 9999)).toBe(false);
  });

  test("18. spend below budget -> false", () => {
    expect(isOverBudget(makePolicy({ monthly_budget_usd: 100 }), 50)).toBe(false);
  });

  test("19. spend exactly at budget -> false (not strictly over)", () => {
    expect(isOverBudget(makePolicy({ monthly_budget_usd: 100 }), 100)).toBe(false);
  });

  test("20. spend over budget -> true", () => {
    expect(isOverBudget(makePolicy({ monthly_budget_usd: 100 }), 100.01)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPolicyEventMetadata
// ---------------------------------------------------------------------------

describe("buildPolicyEventMetadata", () => {
  test("21. shape: provider_override present", () => {
    const resolved = { tier: "premium" as ModelTier, provider_override: "anthropic" as const, capped: false };
    const meta = buildPolicyEventMetadata(resolved, "ws_finance");
    expect(meta).toEqual({
      workspace_id: "ws_finance",
      tier: "premium",
      capped: false,
      provider_override: "anthropic",
    });
  });

  test("22. shape: provider_override undefined -> null in output", () => {
    const resolved = { tier: "cheap" as ModelTier, provider_override: undefined, capped: false };
    const meta = buildPolicyEventMetadata(resolved, "ws_support");
    expect(meta.provider_override).toBeNull();
    expect(meta.workspace_id).toBe("ws_support");
  });

  test("23. capped=true is reflected in metadata", () => {
    const resolved = { tier: "standard" as ModelTier, provider_override: undefined, capped: true };
    const meta = buildPolicyEventMetadata(resolved, "ws_ops");
    expect(meta.capped).toBe(true);
    expect(meta.tier).toBe("standard");
  });
});
