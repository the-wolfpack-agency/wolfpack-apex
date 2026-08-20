/**
 * Sensitivity-driven routing.
 *
 * OpenRouter's equivalent is an account-wide preference: an admin ticks
 * "zero data retention" once and it applies to every request, from "what is
 * the weather" to a patient record pasted into a chat box. Right idea, wrong
 * place: the control belongs to the DATA, not to the account.
 *
 * A request already declares its sensitivity. That declaration now decides who
 * may answer it, and when nobody may, the request is refused. This is the one
 * gate in the router that fails CLOSED, and these tests exist mostly to keep it
 * that way, because "send it anyway" is the tempting fix every time somebody
 * hits it in staging.
 */
import { mayServe, requiresZeroRetention, zeroRetentionProviders } from "@/lib/ai/retention";

const trusted = (...names: string[]) => new Set(names);

describe("which requests are restricted", () => {
  test.each(["pii", "phi"] as const)("%s requires a zero-retention provider", (s) => {
    expect(requiresZeroRetention(s)).toBe(true);
  });

  test("an ordinary request is not restricted and goes anywhere", () => {
    expect(requiresZeroRetention(undefined)).toBe(false);
    expect(mayServe({ sensitivity: undefined, provider: "anything", trusted: trusted() })).toEqual({
      allowed: true,
      reason: "not_restricted",
    });
  });
});

describe("it fails CLOSED", () => {
  test("nothing configured means nobody is trusted, so a PHI request is refused", () => {
    /* The alternative is sending a medical record to a provider that keeps
       prompts, on the assumption somebody will finish the configuration
       later. Deliberately inconvenient in the right direction. */
    expect(mayServe({ sensitivity: "phi", provider: "azure-openai", trusted: trusted() })).toEqual({
      allowed: false,
      reason: "none_configured",
    });
  });

  test("a provider outside the agreement is refused even when others are trusted", () => {
    expect(
      mayServe({ sensitivity: "pii", provider: "anthropic", trusted: trusted("azure-openai") }),
    ).toMatchObject({ allowed: false, reason: "provider_not_trusted" });
  });

  test("an unknown provider is refused, because the answer is unknown and not yes", () => {
    expect(
      mayServe({ sensitivity: "phi", provider: "unknown", trusted: trusted("azure-openai") }).allowed,
    ).toBe(false);
  });

  test("a trusted provider serves it", () => {
    expect(
      mayServe({ sensitivity: "phi", provider: "azure-openai", trusted: trusted("azure-openai") }),
    ).toMatchObject({ allowed: true, reason: "provider_trusted" });
  });

  test("matching ignores case, because configuration is typed by a person", () => {
    expect(
      mayServe({ sensitivity: "pii", provider: "Azure-OpenAI", trusted: trusted("azure-openai") }).allowed,
    ).toBe(true);
  });
});

describe("the trusted list is configuration, not a constant", () => {
  test("it defaults to empty: retention is OUR CONTRACT with a vendor, not a property of a model", () => {
    /* The same model on the same provider retains prompts for thirty days on
       one agreement and zero on another. Hard-coding "azure is zero retention"
       asserts somebody else's commercial terms in source, and is wrong the day
       a contract changes with nothing to catch it. */
    expect(zeroRetentionProviders({ NODE_ENV: "test" } as NodeJS.ProcessEnv).size).toBe(0);
  });

  test("it is read from the environment, trimmed and lowercased", () => {
    const set = zeroRetentionProviders({
      NODE_ENV: "test",
      AI_ZERO_RETENTION_PROVIDERS: " Azure-OpenAI , anthropic ,, ",
    } as NodeJS.ProcessEnv);
    expect([...set].sort()).toEqual(["anthropic", "azure-openai"]);
  });
});
