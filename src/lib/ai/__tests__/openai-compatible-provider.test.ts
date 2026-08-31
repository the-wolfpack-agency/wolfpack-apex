/**
 * The compatible-provider adapter.
 *
 * The failures worth guarding are the quiet ones. A half-configured provider
 * that registers and then fails at call time moves the error from whoever was
 * setting it up onto a user. An empty answer returned as success hands somebody
 * a blank box and calls it an answer. A missing price silently reported as
 * cost is a number that will be believed.
 */
import {
  configuredCompatibleProviders,
  chatCompletionsUrl,
  parseCompletion,
  buildCompatibleProviders,
  OpenAICompatibleProvider,
  CompatibleProviderError,
} from "../openai-compatible-provider";

const FULL: Record<string, string> = {
  AI_COMPAT_PROVIDERS: "groq",
  AI_COMPAT_GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  AI_COMPAT_GROQ_API_KEY: "k",
  AI_COMPAT_GROQ_MODEL_CHEAP: "llama-3.1-8b-instant",
  AI_COMPAT_GROQ_INPUT_PER_1K_CHEAP: "0.00005",
  AI_COMPAT_GROQ_OUTPUT_PER_1K_CHEAP: "0.00008",
};

describe("configuredCompatibleProviders", () => {
  it("is empty until somebody configures one", () => {
    expect(configuredCompatibleProviders({})).toEqual([]);
  });

  it("reads a fully configured provider", () => {
    const [p] = configuredCompatibleProviders(FULL);
    expect(p.id).toBe("groq");
    expect(p.models.cheap).toBe("llama-3.1-8b-instant");
    expect(p.pricing.cheap).toEqual({ inputPer1k: 0.00005, outputPer1k: 0.00008 });
  });

  it("SKIPS a provider with no key, rather than half-registering it", () => {
    /* A provider that appears in the list and then fails at call time is worse
       than one that never appeared: the failure lands on a user instead of on
       whoever was setting it up. */
    const { AI_COMPAT_GROQ_API_KEY: _drop, ...noKey } = FULL;
    expect(configuredCompatibleProviders(noKey)).toEqual([]);
  });

  it("skips a provider with no URL", () => {
    const { AI_COMPAT_GROQ_BASE_URL: _drop, ...noUrl } = FULL;
    expect(configuredCompatibleProviders(noUrl)).toEqual([]);
  });

  it("skips a provider with no model mapped to any tier", () => {
    const { AI_COMPAT_GROQ_MODEL_CHEAP: _drop, ...noModel } = FULL;
    expect(configuredCompatibleProviders(noModel)).toEqual([]);
  });

  it("keeps a provider whose price is missing, because a price is not a blocker", () => {
    /* A missing figure must not silence a working model. Cost reports as 0,
       which is visible, rather than as a guess, which is not. */
    const { AI_COMPAT_GROQ_INPUT_PER_1K_CHEAP: _a, AI_COMPAT_GROQ_OUTPUT_PER_1K_CHEAP: _b, ...noPrice } = FULL;
    const [p] = configuredCompatibleProviders(noPrice);
    expect(p.models.cheap).toBe("llama-3.1-8b-instant");
    expect(p.pricing.cheap).toBeUndefined();
  });

  it("ignores a nonsense price rather than believing it", () => {
    const [p] = configuredCompatibleProviders({ ...FULL, AI_COMPAT_GROQ_INPUT_PER_1K_CHEAP: "cheap!" });
    expect(p.pricing.cheap).toBeUndefined();
  });

  it("deduplicates repeated ids", () => {
    expect(configuredCompatibleProviders({ ...FULL, AI_COMPAT_PROVIDERS: "groq,groq" })).toHaveLength(1);
  });

  it("is read at call time, so a new provider needs no release", () => {
    const env = { ...FULL };
    expect(configuredCompatibleProviders(env)).toHaveLength(1);
    env.AI_COMPAT_PROVIDERS = "";
    expect(configuredCompatibleProviders(env)).toHaveLength(0);
  });
});

describe("chatCompletionsUrl", () => {
  it("appends the path when the base has none", () => {
    expect(chatCompletionsUrl("https://x.dev")).toBe("https://x.dev/v1/chat/completions");
  });

  it("does not double a /v1 the operator already typed", () => {
    expect(chatCompletionsUrl("https://x.dev/v1")).toBe("https://x.dev/v1/chat/completions");
  });

  it("accepts a full path unchanged", () => {
    const full = "https://x.dev/v1/chat/completions";
    expect(chatCompletionsUrl(full)).toBe(full);
  });

  it("tolerates trailing slashes", () => {
    expect(chatCompletionsUrl("https://x.dev/v1/")).toBe("https://x.dev/v1/chat/completions");
  });
});

describe("parseCompletion", () => {
  it("reads content and usage", () => {
    const r = parseCompletion({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
      model: "llama",
    });
    expect(r).toEqual({ content: "hello", inputTokens: 10, outputTokens: 4, model: "llama" });
  });

  it("THROWS on empty content instead of returning a blank answer", () => {
    /* Returning "" as success hands somebody a blank box and calls it an
       answer, and the failover path never gets a chance to run. */
    expect(() => parseCompletion({ choices: [{ message: { content: "" } }] })).toThrow(
      CompatibleProviderError,
    );
    expect(() => parseCompletion({})).toThrow(CompatibleProviderError);
  });

  it("tolerates missing usage, because self-hosted servers often omit it", () => {
    const r = parseCompletion({ choices: [{ message: { content: "hi" } }] });
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
  });
});

describe("OpenAICompatibleProvider", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stub(body: unknown, ok = true, status = 200) {
    const f = jest.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    global.fetch = f as unknown as typeof fetch;
    return f;
  }

  const provider = () => buildCompatibleProviders(FULL)[0];

  const req = {
    messages: [{ role: "user" as const, content: "hi" }],
    max_tokens: 10,
    model_tier: "cheap" as const,
  };

  it("only supports the tiers it has a model for", () => {
    const p = provider();
    expect(p.supportsTier("cheap")).toBe(true);
    expect(p.supportsTier("premium")).toBe(false);
  });

  it("sends the configured model and prices the answer from the configured rates", async () => {
    stub({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      model: "llama-3.1-8b-instant",
    });
    const res = await provider().complete(req);
    expect(res.content).toBe("hello");
    expect(res.provider_used).toBe("groq");
    // 1k in at 0.00005 plus 1k out at 0.00008.
    expect(res.cost_usd).toBeCloseTo(0.00013);
  });

  it("reports zero cost, not a guess, when no price was given", async () => {
    const { AI_COMPAT_GROQ_INPUT_PER_1K_CHEAP: _a, AI_COMPAT_GROQ_OUTPUT_PER_1K_CHEAP: _b, ...noPrice } = FULL;
    stub({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 9, completion_tokens: 9 } });
    const res = await buildCompatibleProviders(noPrice)[0].complete(req);
    expect(res.cost_usd).toBe(0);
  });

  it("puts the system prompt first, as the format requires", async () => {
    const f = stub({ choices: [{ message: { content: "x" } }] });
    await provider().complete({ ...req, system: "be brief" });
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.messages[0]).toEqual({ role: "system", content: "be brief" });
  });

  it("does not echo the provider's error body, which can contain the prompt", async () => {
    /* This string gets logged. An error body that quotes the request back
       would put the prompt in the logs by a side door. */
    stub({ error: { message: "bad request: my-secret-prompt" } }, false, 400);
    await expect(provider().complete(req)).rejects.toThrow(/HTTP 400/);
    await expect(provider().complete(req)).rejects.not.toThrow(/my-secret-prompt/);
  });

  it("refuses a tier it has no model for rather than guessing one", async () => {
    await expect(provider().complete({ ...req, model_tier: "premium" })).rejects.toThrow(
      /no model configured/i,
    );
  });

  it("falls back to the configured name when the provider does not echo one", async () => {
    stub({ choices: [{ message: { content: "x" } }] });
    const res = await provider().complete(req);
    expect(res.model_used).toBe("llama-3.1-8b-instant");
  });
});

/**
 * Wiring into the router.
 *
 * The risk of adding providers by configuration is that one appears in
 * production without anybody deciding it should. So the assertions here are
 * mostly about what does NOT happen: an unconfigured deployment behaves exactly
 * as it did, and a configured provider still serves nothing until it is pinned
 * by name.
 */
import { getAIClient, _resetAIClientForTests } from "@/lib/ai/router";

describe("router wiring", () => {
  const originalFetch = global.fetch;
  const VARS = Object.keys(FULL);

  beforeEach(() => {
    _resetAIClientForTests(null);
    for (const v of VARS) delete process.env[v];
    delete process.env.AI_PROVIDER_PRIMARY;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const v of VARS) delete process.env[v];
    delete process.env.AI_PROVIDER_PRIMARY;
  });

  it("changes nothing when no compatible provider is configured", () => {
    // Every existing deployment must be untouched by this feature existing.
    expect(buildCompatibleProviders(process.env)).toEqual([]);
  });

  it("does not serve traffic merely by being configured", async () => {
    /* Configuration alone must not move production onto a model nobody
       reviewed. It has to be pinned. */
    for (const [k, v] of Object.entries(FULL)) process.env[k] = v;
    /* Asserted on the URL rather than on "was fetch called": the Anthropic SDK
       uses global fetch too, so a bare call count proves nothing about which
       provider ran. */
    const urls: string[] = [];
    global.fetch = jest.fn(async (input: unknown) => {
      urls.push(String(input));
      return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
    }) as unknown as typeof fetch;
    _resetAIClientForTests(null);
    await getAIClient()
      .complete({
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        model_tier: "cheap",
        metadata: { feature: "test.compat" },
      })
      .catch(() => undefined);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes("api.groq.com"))).toBe(false);
  });

  it("an unrecognized pin falls back to normal behavior, not to an outage", () => {
    process.env.AI_PROVIDER_PRIMARY = "a-typo";
    expect(() => buildCompatibleProviders(process.env)).not.toThrow();
    expect(buildCompatibleProviders(process.env)).toEqual([]);
  });
});
