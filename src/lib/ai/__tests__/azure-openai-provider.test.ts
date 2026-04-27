/**
 * azure-openai-provider — unit tests.
 *
 * Covers:
 *   - supportsTier reflects env-var presence
 *   - URL construction: deployment + api-version
 *   - api-key header sent
 *   - System message prepended; user/assistant roles preserved
 *   - Token counts pulled from response.usage
 *   - Cost calculation per tier (cheap, standard, premium)
 *   - Latency captured around fetch
 *   - 4xx -> error with status; 5xx -> error with status; network throw
 *     -> AzureProviderError(503)
 */

import {
  AzureOpenAIProvider,
  AzureProviderError,
  AZURE_TIER_PRICING,
  AZURE_TIER_TO_DEPLOYMENT,
  isAzureConfigured,
} from "@/lib/ai/azure-openai-provider";
import type { AICompleteRequest } from "@/lib/ai/types";

const mockFetch = jest.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_CHEAP;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_PREMIUM;
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

function okResponse(content = "hi", usage = { prompt_tokens: 10, completion_tokens: 4 }) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      id: "chatcmpl-x",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage,
      model: "gpt-4o",
    }),
    text: async () => "",
  };
}

function failResponse(status: number, message = "boom") {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({ error: { message } }),
    text: async () => JSON.stringify({ error: { message } }),
  };
}

function baseReq(): AICompleteRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 64,
    model_tier: "standard",
    metadata: { feature: "test.azure" },
  };
}

describe("isAzureConfigured + supportsTier", () => {
  it("returns false when env vars unset", () => {
    expect(isAzureConfigured()).toBe(false);
    const p = new AzureOpenAIProvider();
    expect(p.supportsTier("standard")).toBe(false);
  });

  it("returns true when both env vars set", () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "abc";
    expect(isAzureConfigured()).toBe(true);
    const p = new AzureOpenAIProvider();
    expect(p.supportsTier("cheap")).toBe(true);
    expect(p.supportsTier("standard")).toBe(true);
    expect(p.supportsTier("premium")).toBe(true);
  });
});

describe("complete — request construction", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "secret-key";
  });

  it("builds URL with deployment and api-version, strips trailing slashes", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com//";
    mockFetch.mockResolvedValueOnce(okResponse());
    const p = new AzureOpenAIProvider();
    await p.complete(baseReq());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `https://r.openai.azure.com/openai/deployments/${AZURE_TIER_TO_DEPLOYMENT.standard}/chat/completions?api-version=2024-08-01-preview`,
    );
  });

  it("sends api-key header and JSON content-type", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const p = new AzureOpenAIProvider();
    await p.complete(baseReq());
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["api-key"]).toBe("secret-key");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("prepends system message and preserves user + assistant roles", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const p = new AzureOpenAIProvider();
    await p.complete({
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
      system: "you are helpful",
      max_tokens: 50,
      temperature: 0.2,
      model_tier: "standard",
      metadata: { feature: "test.shape" },
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
    expect(body.max_tokens).toBe(50);
    expect(body.temperature).toBe(0.2);
  });

  it("defaults temperature to 0.7 when not provided", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const p = new AzureOpenAIProvider();
    await p.complete(baseReq());
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.temperature).toBe(0.7);
  });

  it("uses env override deployment names when set", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD = "my-prod-gpt4o";
    mockFetch.mockResolvedValueOnce(okResponse());
    const p = new AzureOpenAIProvider();
    await p.complete(baseReq());
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/openai/deployments/my-prod-gpt4o/chat/completions");
  });
});

describe("complete — response parsing", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "k";
  });

  it("extracts content from choices[0].message.content", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("the answer"));
    const p = new AzureOpenAIProvider();
    const out = await p.complete(baseReq());
    expect(out.content).toBe("the answer");
    expect(out.provider_used).toBe("azure-openai");
    expect(out.model_used).toBe(AZURE_TIER_TO_DEPLOYMENT.standard);
  });

  it("captures token counts from usage block", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse("ok", { prompt_tokens: 321, completion_tokens: 17 }),
    );
    const p = new AzureOpenAIProvider();
    const out = await p.complete(baseReq());
    expect(out.input_tokens).toBe(321);
    expect(out.output_tokens).toBe(17);
  });

  it("cost: cheap tier 1M in + 1M out = $0.15 + $0.60 = $0.75", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse("ok", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
    );
    const p = new AzureOpenAIProvider();
    const out = await p.complete({
      ...baseReq(),
      model_tier: "cheap",
    });
    expect(out.cost_usd).toBeCloseTo(0.75, 6);
    expect(AZURE_TIER_PRICING.cheap.input_per_mtok).toBe(0.15);
  });

  it("cost: standard tier 100k in + 50k out = $0.25 + $0.50 = $0.75", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse("ok", { prompt_tokens: 100_000, completion_tokens: 50_000 }),
    );
    const p = new AzureOpenAIProvider();
    const out = await p.complete(baseReq());
    expect(out.cost_usd).toBeCloseTo(0.75, 6);
  });

  it("cost: premium tier 100k in + 100k out = $1.00 + $3.00 = $4.00", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse("ok", { prompt_tokens: 100_000, completion_tokens: 100_000 }),
    );
    const p = new AzureOpenAIProvider();
    const out = await p.complete({
      ...baseReq(),
      model_tier: "premium",
    });
    expect(out.cost_usd).toBeCloseTo(4, 6);
  });

  it("captures latency_ms across the fetch", async () => {
    mockFetch.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return okResponse();
    });
    const p = new AzureOpenAIProvider();
    const out = await p.complete(baseReq());
    expect(out.latency_ms).toBeGreaterThanOrEqual(20);
  });
});

describe("complete — error handling", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "k";
  });

  it("4xx auth error throws with status set so router does NOT retry", async () => {
    mockFetch.mockResolvedValueOnce(failResponse(401, "invalid api-key"));
    const p = new AzureOpenAIProvider();
    await expect(p.complete(baseReq())).rejects.toMatchObject({
      status: 401,
      name: "AzureProviderError",
    });
  });

  it("404 deployment not found throws with status 404", async () => {
    mockFetch.mockResolvedValueOnce(
      failResponse(404, "DeploymentNotFound: gpt-4o"),
    );
    const p = new AzureOpenAIProvider();
    await expect(p.complete(baseReq())).rejects.toMatchObject({
      status: 404,
    });
  });

  it("5xx throws with retryable status so router falls back", async () => {
    mockFetch.mockResolvedValueOnce(failResponse(503, "service unavailable"));
    const p = new AzureOpenAIProvider();
    let caught: AzureProviderError | null = null;
    try {
      await p.complete(baseReq());
    } catch (err) {
      caught = err as AzureProviderError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(503);
    expect(caught?.message).toContain("503");
  });

  it("network throw is surfaced as AzureProviderError(503)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const p = new AzureOpenAIProvider();
    await expect(p.complete(baseReq())).rejects.toMatchObject({
      status: 503,
      name: "AzureProviderError",
    });
  });

  it("missing env vars throws clearly when complete() is called", async () => {
    delete process.env.AZURE_OPENAI_ENDPOINT;
    const p = new AzureOpenAIProvider();
    await expect(p.complete(baseReq())).rejects.toMatchObject({
      name: "AzureProviderError",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
