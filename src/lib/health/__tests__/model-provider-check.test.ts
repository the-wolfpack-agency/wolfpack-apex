/**
 * A model the registry advertises but cannot reach is a claim, not a capability.
 *
 * MEASURED 2026-08-29, every model call in the product's life:
 *
 *   1,039  azure-openai  gpt-4o-mini       Apr 28 -> Aug 29
 *      30  azure-openai  gpt-4o            Aug 26 -> Aug 29
 *       1  kimi          moonshot-v1-8k    Aug 26 only
 *       1  deepseek      deepseek-chat     Aug 26 only
 *
 * 99.8 per cent to one vendor, with the two alternatives serving one call each
 * on one day. The product is sold on routing to the cheapest capable model.
 *
 * The reason was mundane and invisible: production carries ANTHROPIC_MODEL and
 * no ANTHROPIC_API_KEY, so the three Claude models in the registry could never
 * run. The router fell through to the provider that had credentials, which is
 * correct behaviour and indistinguishable from a product that only supports
 * one vendor.
 */
import { readProviderReadiness } from "@/lib/health/model-provider-check";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("which providers we can actually reach", () => {
  it("reports a provider with all its credentials as reachable", () => {
    process.env.AZURE_OPENAI_API_KEY = "k";
    process.env.AZURE_OPENAI_ENDPOINT = "https://example";

    const azure = readProviderReadiness().find((p) => p.provider === "azure-openai")!;
    expect(azure.configured).toBe(true);
    expect(azure.missing).toEqual([]);
  });

  /* NAMES WHAT IS MISSING. "Anthropic unavailable" sends somebody
     investigating; "ANTHROPIC_API_KEY not set" is one line of work. */
  it("names the exact credential a provider is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;

    const anthropic = readProviderReadiness().find((p) => p.provider === "anthropic")!;
    expect(anthropic.configured).toBe(false);
    expect(anthropic.missing).toEqual(["ANTHROPIC_API_KEY"]);
  });

  /* A provider needing two credentials is unreachable on either. Reporting it
     as ready because one is present would be worse than not checking. */
  it("is unreachable when any one credential is absent", () => {
    process.env.AZURE_OPENAI_API_KEY = "k";
    delete process.env.AZURE_OPENAI_ENDPOINT;

    const azure = readProviderReadiness().find((p) => p.provider === "azure-openai")!;
    expect(azure.configured).toBe(false);
    expect(azure.missing).toEqual(["AZURE_OPENAI_ENDPOINT"]);
  });

  /* It must cover the models the registry advertises. A provider added to the
     registry and not here would go unchecked, which is the gap this exists
     for. */
  it("covers the providers the registry offers", () => {
    const names = readProviderReadiness().map((p) => p.provider);
    expect(names).toEqual(expect.arrayContaining(["azure-openai", "azure-foundry", "anthropic"]));
  });

  /* NEVER READS A VALUE. A health check that logs a key is a worse problem
     than the one it reports. */
  it("reports presence without carrying the credential", () => {
    process.env.ANTHROPIC_API_KEY = "sk-super-secret-value";

    const serialised = JSON.stringify(readProviderReadiness());
    expect(serialised).not.toContain("sk-super-secret-value");
  });
});
