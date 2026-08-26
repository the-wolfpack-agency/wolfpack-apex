/**
 * A configured provider is still an outbound call.
 *
 * TWO THINGS WERE WRONG, and they cancelled each other into silence.
 *
 * The model-api allowlist names four vendor hosts. A compatible provider is
 * added by configuration - a base URL, a key, a model name - so its host is
 * never one of them, and every configured provider was refused. The feature
 * was unusable as shipped, and the probe reporting "not answering" was telling
 * the truth about a door we had bolted ourselves.
 *
 * And the provider never asked the guard at all, which is the wrong way round:
 * it is the ONE provider whose destination comes from an environment variable
 * rather than from code, so it is the one where an arbitrary host is actually
 * possible. Every other model call was checked; the configurable one was not.
 *
 * Fixed together, because fixing only the first would have made an unguarded
 * path usable, and fixing only the second would have made a guarded path
 * refuse everything.
 */
import { decideEgress } from "@/lib/containment/allowlist";
import { configuredModelHosts } from "@/lib/ai/openai-compatible-provider";

const CONFIGURED = {
  AI_COMPAT_PROVIDERS: "deepseek,kimi",
  AI_COMPAT_DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
  AI_COMPAT_DEEPSEEK_API_KEY: "k",
  AI_COMPAT_DEEPSEEK_MODEL_CHEAP: "deepseek-chat",
  AI_COMPAT_KIMI_BASE_URL: "https://api.moonshot.cn/v1",
  AI_COMPAT_KIMI_API_KEY: "k",
  AI_COMPAT_KIMI_MODEL_CHEAP: "moonshot-v1-8k",
} as Record<string, string>;

describe("hosts an operator deliberately configured", () => {
  it("names every configured provider's host", () => {
    expect(configuredModelHosts(CONFIGURED).sort()).toEqual([
      "api.deepseek.com",
      "api.moonshot.cn",
    ]);
  });

  it("names none when nothing is configured", () => {
    expect(configuredModelHosts({})).toEqual([]);
  });

  it("skips a base URL that will not parse rather than throwing", () => {
    expect(
      configuredModelHosts({
        AI_COMPAT_PROVIDERS: "broken",
        AI_COMPAT_BROKEN_BASE_URL: "not a url",
        AI_COMPAT_BROKEN_API_KEY: "k",
        AI_COMPAT_BROKEN_MODEL_CHEAP: "m",
      }),
    ).toEqual([]);
  });
});

describe("the guard, with configured hosts passed in", () => {
  const extra = configuredModelHosts(CONFIGURED);

  it("permits a provider somebody configured", () => {
    expect(
      decideEgress("https://api.deepseek.com/v1/chat/completions", "model-api", extra).allowed,
    ).toBe(true);
    expect(
      decideEgress("https://api.moonshot.cn/v1/chat/completions", "model-api", extra).allowed,
    ).toBe(true);
  });

  /* OPT-IN, NOT A WILDCARD. The permission is exactly "somebody put this in an
     environment variable", which is the same act as adding it to the list. */
  it("still refuses a host nobody configured", () => {
    const v = decideEgress("https://evil.example.com/v1/chat/completions", "model-api", extra);
    expect(v.allowed).toBe(false);
  });

  /* THE PART THE PROVIDER'S OWN CHECK ACTUALLY ENFORCES. Its host comes from
     its configuration, so permitting that host is not the guard vetting the
     destination. What it does enforce is https, which is what matters when the
     request carries prompts and an API key. */
  it("still refuses http, even for a configured host", () => {
    const v = decideEgress("http://api.deepseek.com/v1/chat/completions", "model-api", extra);
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error("unreachable");
    expect(v.refusedBecause).toBe("scheme");
  });

  /* The built-in vendors keep working with no configuration at all. */
  it("still permits the vendors that ship with the product", () => {
    expect(decideEgress("https://api.anthropic.com/v1/messages", "model-api").allowed).toBe(true);
  });
});
