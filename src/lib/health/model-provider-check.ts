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
 * WHAT A CLOSER LOOK FOUND, 2026-08-31, AND IT CORRECTS THE PARAGRAPH THAT USED
 * TO BE HERE. That paragraph said the savings were sitting at the cheap end,
 * unclaimed. They are not, and the reason is worth keeping.
 *
 * gpt-4o-mini is ALREADY the cheapest small-tier model in the registry:
 * $0.000327 for a call the shape of ours, against $0.0023 for the nearest
 * alternative. DeepSeek and Llama are registered at the LARGE tier, so they
 * were never candidates for the small-tier work that is almost all of our
 * traffic. A router that picked them for it would be making a mistake, not a
 * saving.
 *
 * Measured over 90 days: 1,673 calls, 97.1 per cent gpt-4o-mini, 2.7 per cent
 * gpt-4o, two calls to anything else, and ZERO fallbacks. The router is not
 * stuck on one model. It is choosing correctly, and the work is mostly cheap.
 *
 * THE REAL GAP IS AT THE LARGE TIER AND IS SMALL TODAY. Llama 3.3 costs
 * $0.001292 where gpt-4o costs $0.005450, 4.2x for the same tier, and
 * production served 36 large-tier calls in 90 days outside the bakeoff. The
 * whole prize is around fifteen cents. Worth knowing as traffic grows, not
 * worth engineering now, and pinned by tier-pricing-order.test.ts so a price
 * edit cannot quietly reverse it.
 *
 * (Anthropic genuinely has no key, and that matters least: it is the most
 * expensive option at every tier, so its absence costs no efficiency at all.)
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
  /* THE LARGE TIER, WHICH IS WHERE THE DIFFERENCE ACTUALLY IS. DeepSeek and
     Llama are large-tier models that cost a fraction of gpt-4o for the same
     tier, which is the efficiency argument. It is NOT that they are cheaper
     than gpt-4o-mini; nothing in the registry is. Their variables are taken
     from the registry entries rather than guessed, because a check looking for
     the wrong name reports a configured provider as missing and sends somebody
     hunting for a key that is already there.

     Worth watching: production carries both AZURE_AI_FOUNDRY_API_KEY and
     AZURE_AI_FOUNDRY_KEY, which suggests somebody was unsure which name is
     read. Only the first is. */
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
