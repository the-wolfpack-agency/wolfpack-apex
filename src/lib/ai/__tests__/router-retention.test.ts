/**
 * The retention gate AT THE CHOKEPOINT, in both modes, on the primary and on
 * failover.
 *
 * retention.test.ts proves the rule. This proves the router acts on it: in
 * enforce mode a restricted request never reaches a provider that does not
 * qualify as zero-retention, not as the first choice and not as a fallback
 * after an outage; in observe mode it is sent and the gap is recorded on every
 * call, so "we do not enforce this yet" is a number rather than a sentence.
 *
 * The assertion that matters in every enforce test is on the provider mocks:
 * NOTHING WAS SENT to the provider that does not qualify.
 */
const mockMessagesCreate = jest.fn();
const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  class FakeInternalServerError extends Error {
    status = 500;
    name = "InternalServerError";
  }
  class FakeAPIError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  }
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })) as unknown as {
    new (...args: unknown[]): unknown;
    InternalServerError: typeof FakeInternalServerError;
    APIError: typeof FakeAPIError;
  };
  Anthropic.InternalServerError = FakeInternalServerError;
  Anthropic.APIError = FakeAPIError;
  return { __esModule: true, default: Anthropic };
});

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { getAIClient, _resetAIClientForTests, fallbackVerdict } from "@/lib/ai/router";
import { RetentionPolicyError } from "@/lib/ai/retention";

const originalFetch = global.fetch;
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT_CHEAP",
  "AZURE_OPENAI_DEPLOYMENT_STANDARD",
  "AI_PROVIDER_PRIMARY",
  "AI_RETENTION_MODE",
  "AI_ZERO_RETENTION_PROVIDERS",
];

function azureOk(content = "ok-azure") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: "gpt-4o",
    }),
    text: async () => "",
  };
}

function azureFail(status: number) {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({ error: { message: "azure down" } }),
    text: async () => JSON.stringify({ error: { message: "azure down" } }),
  };
}

function anthropicOk(text = "from-anthropic") {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-sonnet-4-6" };
}

/** Both providers configured, Azure first: the production shape. */
function bothProviders() {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "akey";
  process.env.AZURE_OPENAI_DEPLOYMENT_CHEAP = "gpt-4o-mini-dep";
  process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD = "gpt-4o-dep";
  _resetAIClientForTests(null);
}

function request(sensitivity?: "pii" | "phi" | "confidential") {
  return {
    messages: [{ role: "user" as const, content: "a client's record" }],
    max_tokens: 10,
    model_tier: "standard" as const,
    ...(sensitivity ? { sensitivity } : {}),
    metadata: { feature: "test.retention", workspace_id: "ws1" },
  };
}

const events = (name: string) => mockTrackEvent.mock.calls.filter((c) => c[0] === name).map((c) => c[3] as Record<string, unknown>);

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  global.fetch = mockFetch as unknown as typeof fetch;
  bothProviders();
});

afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  global.fetch = originalFetch;
  _resetAIClientForTests(null);
});

describe("observe mode (the measured default)", () => {
  it("sends a restricted call and records that enforce would have blocked it", async () => {
    mockFetch.mockResolvedValueOnce(azureOk());
    const out = await getAIClient().complete(request("pii"));
    expect(out.provider_used).toBe("azure-openai");
    const [ev] = events("ai.retention_unenforced");
    expect(ev).toMatchObject({ feature: "test.retention", workspace_id: "ws1", provider: "azure-openai", mode: "observe", stage: "primary", would_block: true });
  });

  it("an unrestricted call records nothing", async () => {
    mockFetch.mockResolvedValueOnce(azureOk());
    await getAIClient().complete(request());
    expect(events("ai.retention_unenforced")).toHaveLength(0);
  });

  it("failover to a non-qualifying provider is allowed and recorded at the fallback stage", async () => {
    mockFetch.mockResolvedValueOnce(azureFail(503));
    mockMessagesCreate.mockResolvedValueOnce(anthropicOk());
    const out = await getAIClient().complete(request("phi"));
    expect(out.provider_used).toBe("anthropic");
    expect(events("ai.retention_unenforced").map((e) => e.stage)).toEqual(["primary", "fallback"]);
  });
});

describe("enforce mode", () => {
  beforeEach(() => {
    process.env.AI_RETENTION_MODE = "enforce";
  });

  it("refuses a restricted call when no provider qualifies, and sends NOTHING", async () => {
    await expect(getAIClient().complete(request("pii"))).rejects.toThrow(RetentionPolicyError);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(events("ai.request_blocked_retention")[0]).toMatchObject({ provider: "azure-openai", mode: "enforce" });
  });

  it("still serves an unrestricted call", async () => {
    mockFetch.mockResolvedValueOnce(azureOk());
    await expect(getAIClient().complete(request())).resolves.toMatchObject({ provider_used: "azure-openai" });
  });

  it("re-routes to a qualifying provider before anything is sent", async () => {
    process.env.AI_ZERO_RETENTION_PROVIDERS = "anthropic";
    mockMessagesCreate.mockResolvedValueOnce(anthropicOk());
    const out = await getAIClient().complete(request("confidential"));
    expect(out.provider_used).toBe("anthropic");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(events("ai.retention_rerouted")[0]).toMatchObject({ from_provider: "azure-openai", to_provider: "anthropic" });
  });

  it("a qualifying primary serves the call directly", async () => {
    process.env.AI_ZERO_RETENTION_PROVIDERS = "azure";
    mockFetch.mockResolvedValueOnce(azureOk());
    await expect(getAIClient().complete(request("phi"))).resolves.toMatchObject({ provider_used: "azure-openai" });
    expect(events("ai.retention_rerouted")).toHaveLength(0);
  });

  it("FAILOVER never routes a restricted call to a non-qualifying provider", async () => {
    process.env.AI_ZERO_RETENTION_PROVIDERS = "azure-openai";
    mockFetch.mockResolvedValueOnce(azureFail(503)).mockResolvedValueOnce(azureOk("retried"));
    const out = await getAIClient().complete(request("pii"));
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(out.provider_used).toBe("azure-openai");
    expect(events("ai.failover_refused")[0]).toMatchObject({ primary: "azure-openai", fallback: "anthropic", gate: "retention", mode: "enforce" });
  });

  it("failover of an UNRESTRICTED call is unchanged", async () => {
    mockFetch.mockResolvedValueOnce(azureFail(503));
    mockMessagesCreate.mockResolvedValueOnce(anthropicOk());
    await expect(getAIClient().complete(request())).resolves.toMatchObject({ provider_used: "anthropic" });
    expect(events("ai.failover_refused")).toHaveLength(0);
  });

  it("a mistyped mode enforces rather than relaxing", async () => {
    process.env.AI_RETENTION_MODE = "enforec";
    await expect(getAIClient().complete(request("pii"))).rejects.toThrow(RetentionPolicyError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fallbackVerdict (residency follows the same rule)", () => {
  const trusted = new Set(["azure-openai"]);
  it("refuses a non-qualifying fallback under enforce", () => {
    expect(fallbackVerdict({ fallback: "anthropic", sensitivity: "pii", residency: undefined, trusted, mode: "enforce" })).toMatchObject({ allowed: false, gate: "retention" });
  });
  it("allows and flags it under observe", () => {
    expect(fallbackVerdict({ fallback: "anthropic", sensitivity: "pii", residency: undefined, trusted, mode: "observe" })).toEqual({ allowed: true, unenforced: true });
  });
  it("refuses a fallback whose region is undeclared when residency is required, in EITHER mode", () => {
    for (const mode of ["enforce", "observe"] as const) {
      expect(fallbackVerdict({ fallback: "anthropic", sensitivity: undefined, residency: ["eu"], trusted, mode, env: {} })).toMatchObject({ allowed: false, gate: "residency" });
    }
  });
  it("allows a fallback declared in the required region", () => {
    expect(
      fallbackVerdict({ fallback: "anthropic", sensitivity: undefined, residency: ["eu"], trusted, mode: "enforce", env: { AI_PROVIDER_REGION_ANTHROPIC: "eu" } }),
    ).toEqual({ allowed: true, unenforced: false });
  });
});
