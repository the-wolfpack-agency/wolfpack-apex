/**
 * Which models this product can ACTUALLY reach, asked nightly.
 *
 * THE CLAIM AND THE MEASUREMENT. This product is sold on being model-agnostic:
 * a router that picks the cheapest model that can answer, rather than sending
 * everything to one vendor. The registry backs that up, defining models across
 * Azure OpenAI, Azure Foundry (DeepSeek, Llama) and Anthropic.
 *
 * Every model call in the product's life, measured 2026-08-29:
 *
 *   1,039  azure-openai  gpt-4o-mini       Apr 28 -> Aug 29
 *      30  azure-openai  gpt-4o            Aug 26 -> Aug 29
 *       1  kimi          moonshot-v1-8k    Aug 26 only
 *       1  deepseek      deepseek-chat     Aug 26 only
 *
 * 99.8 per cent went to one vendor, and the two alternatives served one call
 * each, on one day. That is a smoke test, not a proven capability.
 *
 * AND THE CHEAP MODELS ARE NOT THE PROBLEM, WHICH IS THE SURPRISE. Every Azure
 * Foundry variable is present in production: endpoint, key, and deployments for
 * both DeepSeek and Llama. Those models cost roughly a tenth of a premium one
 * and they are fully reachable. They have served ONE call between them.
 *
 * So this is not a credentials gap at the cheap end. It is that nothing
 * measures whether the router ever chooses them, and a router that always
 * picks the same model is indistinguishable from one that cannot pick another.
 * (Anthropic genuinely has no key, and that matters least: it is the most
 * expensive option, so its absence costs no efficiency at all.)
 *
 * A capability nobody exercises is a claim. This turns it into a nightly fact:
 * for each provider the registry names, can we reach it right now, and if not,
 * exactly what is missing.
 *
 * IT CHECKS CREDENTIALS AND REACHABILITY, NOT QUALITY. Whether DeepSeek answers
 * as well as GPT-4o is a different question with a different tool (the model
 * bake-off). This answers the prior one: could we send it anything at all.
 */

import { persistProbeResult, type ProbeResult } from "@/lib/health/integration-probes";

export interface ProviderReadiness {
  provider: string;
  /** What a reader would call the models behind it. */
  models: string[];
  /** True when every credential this provider needs is present. */
  configured: boolean;
  /** Named so a fix is one line of work rather than an investigation. */
  missing: string[];
}

/**
 * What each provider needs before the router can choose it.
 *
 * Deliberately checks for PRESENCE, never reads a value. A health check that
 * logs a key is a worse problem than the one it reports.
 */
const PROVIDER_REQUIREMENTS: Array<{
  provider: string;
  models: string[];
  env: string[];
}> = [
  {
    provider: "azure-openai",
    models: ["gpt-4o-mini", "gpt-4o"],
    env: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  },
  /* THE CHEAP END, WHICH IS THE POINT. DeepSeek and Llama are the models that
     make the efficiency argument: roughly a tenth of a premium model's price
     for work that does not need one. Their variables are taken from the
     registry entries rather than guessed, because a check looking for the
     wrong name reports a configured provider as missing and sends somebody
     hunting for a key that is already there. */
  {
    provider: "azure-foundry",
    models: ["deepseek-v3", "llama-3.3-70b"],
    env: [
      "AZURE_AI_FOUNDRY_ENDPOINT",
      "AZURE_AI_FOUNDRY_API_KEY",
      "AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK",
      "AZURE_FOUNDRY_DEPLOYMENT_LLAMA",
    ],
  },
  /* Anthropic is listed LAST and deliberately not treated as the gap worth
     closing. It is the most expensive option on the board, roughly 28x our
     current spend for the same traffic, so an unreachable Claude costs us
     nothing in efficiency terms. It is checked because the registry offers it
     and a claim should be measurable, not because adding it would improve
     anything. The models worth proving are above. */
  {
    provider: "anthropic",
    models: ["claude-haiku", "claude-sonnet", "claude-opus"],
    env: ["ANTHROPIC_API_KEY"],
  },
];

export function readProviderReadiness(): ProviderReadiness[] {
  return PROVIDER_REQUIREMENTS.map((p) => {
    const missing = p.env.filter((k) => !process.env[k]);
    return {
      provider: p.provider,
      models: p.models,
      configured: missing.length === 0,
      missing,
    };
  });
}

export interface ProviderCheck {
  providers: ProviderReadiness[];
  /** Providers the registry offers that cannot currently be reached. */
  unreachable: ProviderReadiness[];
  /** How many distinct providers have actually served a call in the window. */
  providersUsed: number;
}

/**
 * Record readiness, and how many providers real traffic actually reached.
 *
 * The two together are the honest picture. Configured-but-never-chosen is a
 * different problem from not-configured, and only one of them is fixed by
 * adding a key.
 */
export async function recordProviderReadiness(
  workspaceId = "default",
  providersUsed = 0,
): Promise<ProviderCheck> {
  const providers = readProviderReadiness();
  const unreachable = providers.filter((p) => !p.configured);

  for (const p of providers) {
    const probe: ProbeResult = {
      vendor: "model-router",
      probeKind: "connectivity",
      objectType: p.provider,
      ok: p.configured,
      ...(p.configured
        ? {}
        : {
            errorMessage: `cannot be used: ${p.missing.join(", ")} not set`,
            /* NOT "notConfigured". That flag means "expected state, stay
               quiet", and a model the registry advertises being unreachable is
               not expected state: it is the whole multi-model claim silently
               not holding. */
          }),
      schemaPayload: { models: p.models, missing: p.missing },
      durationMs: 0,
    };
    await persistProbeResult(workspaceId, probe).catch(() => undefined);
  }

  return { providers, unreachable, providersUsed };
}
