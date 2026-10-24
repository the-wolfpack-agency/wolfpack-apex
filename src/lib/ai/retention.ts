/**
 * Which providers may see sensitive data, and why that is a contract and not
 * a model property.
 *
 * WHAT THE COMPETITION DOES
 *
 * OpenRouter lets an admin set an account-wide preference: disallow providers
 * that train on prompts, prefer zero-retention endpoints, restrict to an
 * allowlist. It is a real feature and it is the right idea in the wrong place.
 * A setting chosen once, by one person, in an admin screen, applies equally to
 * "what is the weather" and to a patient record pasted into a chat box.
 *
 * WHAT WE DO INSTEAD
 *
 * The control follows the DATA, not the account. A request already declares
 * its sensitivity (AICompleteRequest.sensitivity, used today to decide how
 * hard to redact). That same declaration now decides which providers are
 * eligible to answer it. An ordinary question can go to the cheapest model
 * anywhere; a request carrying personal or health data may only be served by a
 * provider we have a zero-retention agreement with.
 *
 * THE RULE FAILS CLOSED; WHETHER THE ROUTER OBEYS IT IS A NAMED MODE. mayServe
 * below refuses a restricted request when no qualifying provider is available.
 * The router acts on that verdict according to AI_RETENTION_MODE:
 *
 *   enforce  the request is re-routed to a qualifying provider, or refused.
 *   observe  the request is sent anyway and ai.retention_unenforced records
 *            the feature, provider and reason, once per call.
 *
 * The default is observe, and that is a measured decision, not a preference.
 * On 2026-10-24 none of the providers this deployment calls met its vendor's
 * zero-retention condition (see PROVIDER_RETENTION_TERMS), so enforcing would
 * have refused every restricted call: 10,034 of them in the 30 days to
 * 2026-10-24, 100% of restricted traffic, all on azure-openai or foundry,
 * across live features (ai-code-ci-fix 7,354, ai-code-pipeline-author* 1,673,
 * brain.query_expansion 976, insights.meeting_prep 31) and, once tagged, the
 * assistant itself (assistant_chat 691 and its review 631 in the same window).
 * Flipping the default is the operator's decision once a provider qualifies,
 * and the events say exactly which features would be affected.
 *
 * Before 2026-10-24 this header said the gate failed closed while the router
 * sent every restricted call anyway. A claim the code does not keep is worse
 * than no claim, so the mode is now explicit and recorded on every event.
 *
 * WHY THIS IS CONFIGURATION AND NOT A CONSTANT
 *
 * Retention is a fact about OUR AGREEMENT with a vendor, not about a model.
 * The same model, on the same provider, retains prompts for thirty days on one
 * contract and zero days on another. Hard-coding "azure is zero retention"
 * would be asserting somebody else's commercial terms in source code, and it
 * would be wrong the day a contract changes with nothing to catch it.
 *
 * So qualification is a documented CONDITION per provider (below, with the
 * vendor's own pages cited) plus environment configuration saying whether the
 * condition is met on this deployment. No provider we call qualifies by
 * default, so the list starts EMPTY, and an empty list means no provider is
 * trusted with sensitive data until somebody attests which one is.
 */
import type { AISensitivity } from "./types";

/**
 * What each vendor's OWN documentation says about retention of API prompts and
 * completions, and the condition under which it is zero.
 *
 * Verified 2026-10-24 against the pages cited. A provider qualifies here only
 * when its documentation says prompts and completions are not stored at rest
 * WITHOUT a further approval or agreement. None of ours does, so
 * qualifiesByDefault is false for every entry and the condition names what an
 * operator must obtain (and then attest via AI_ZERO_RETENTION_PROVIDERS).
 */
export interface ProviderRetentionTerms {
  /** Router provider name (AIProvider.name). */
  provider: string;
  /** True only when the vendor documents zero retention with no approval needed. */
  qualifiesByDefault: boolean;
  /** What must be true for this provider to qualify. */
  condition: string;
  /** How to check the condition on a live deployment, when the vendor documents one. */
  verify?: string;
  /** The vendor pages this entry is read from. */
  sources: readonly string[];
}

const AZURE_DATA_PRIVACY =
  "https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy";
const AZURE_ABUSE_MONITORING =
  "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/abuse-monitoring";
const AZURE_LIMITED_ACCESS =
  "https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/limited-access";

export const PROVIDER_RETENTION_TERMS: Readonly<Record<string, ProviderRetentionTerms>> = Object.freeze({
  /* Azure OpenAI ("Models sold by Azure"). The models are stateless, but
     abuse monitoring stores prompts and completions flagged for human review
     in the resource's geography unless the customer is approved for MODIFIED
     abuse monitoring (Limited Access). Stateful features (Responses API,
     Assistants threads, stored completions, batch, fine-tuning) store data
     regardless; the router calls none of them.
     On 2026-10-24 the production resource (homyk-mohqi52o-eastus2) did NOT
     carry ContentLogging=false, so it does not qualify today. */
  "azure-openai": {
    provider: "azure-openai",
    qualifiesByDefault: false,
    condition:
      "Approved for modified abuse monitoring (Limited Access), and only stateless chat completions are used.",
    verify:
      'az cognitiveservices account show -n <resource> -g <rg> --query "properties.capabilities[?name==\'ContentLogging\']" shows value "false".',
    sources: [AZURE_DATA_PRIVACY, AZURE_ABUSE_MONITORING, AZURE_LIMITED_ACCESS],
  },
  /* The OpenAI-compatible "foundry" provider on this deployment points at the
     same Azure AI Foundry resource and serves a Model sold by Azure, so the
     same abuse-monitoring terms and the same exemption apply. A compatible
     provider pointed elsewhere is a different vendor and needs its own entry. */
  foundry: {
    provider: "foundry",
    qualifiesByDefault: false,
    condition:
      "The Foundry resource is approved for modified abuse monitoring and the deployed model is a Model sold by Azure.",
    verify: "Same ContentLogging=false check as azure-openai, on the Foundry resource.",
    sources: [AZURE_DATA_PRIVACY, AZURE_ABUSE_MONITORING],
  },
  /* Anthropic API. Standard commercial retention applies unless the
     organization has a zero data retention (ZDR) arrangement, enabled per
     organization by Anthropic's account team. Some models are excluded from
     ZDR, and flagged content and legal holds are retained regardless. */
  anthropic: {
    provider: "anthropic",
    qualifiesByDefault: false,
    condition: "A ZDR arrangement is enabled for the API organization by Anthropic, for a ZDR-eligible model.",
    sources: [
      "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    ],
  },
});

/** Spellings a person types for a provider, mapped to the router's name. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  azure: "azure-openai",
  "azure_openai": "azure-openai",
  azureopenai: "azure-openai",
});

function canonicalProvider(name: string): string {
  const n = name.trim().toLowerCase();
  return PROVIDER_ALIASES[n] ?? n;
}

/** How the router acts on a retention verdict. See the header. */
export type RetentionMode = "enforce" | "observe";

/** Measured default; see the header for the numbers behind it. */
export const DEFAULT_RETENTION_MODE: RetentionMode = "observe";

/**
 * AI_RETENTION_MODE, read at call time.
 *
 * Unset means the measured default. A value that is set but not recognized
 * means ENFORCE: somebody asked for something, and a typo must never be read as
 * permission to send restricted data anywhere.
 */
export function retentionMode(env: Record<string, string | undefined> = process.env): RetentionMode {
  const raw = env.AI_RETENTION_MODE?.trim().toLowerCase();
  if (!raw) return DEFAULT_RETENTION_MODE;
  return raw === "observe" ? "observe" : "enforce";
}

/** Sensitivity levels that require a zero-retention provider. */
const RESTRICTED: ReadonlySet<string> = new Set(["confidential", "pii", "phi"]);

export function requiresZeroRetention(sensitivity: AISensitivity | undefined): boolean {
  return sensitivity !== undefined && RESTRICTED.has(sensitivity);
}

/**
 * Providers that qualify as zero-retention on this deployment.
 *
 * Starts from the providers whose vendor documents zero retention without any
 * approval (none today, see PROVIDER_RETENTION_TERMS), then applies
 * AI_ZERO_RETENTION_PROVIDERS, comma separated:
 *
 *   name or +name   extends: the operator attests the provider's condition is met
 *   -name           narrows: the provider is removed even if it qualifies by default
 *
 * "azure" is accepted for "azure-openai", because that is what people type.
 *
 * Read at call time rather than cached at import, so changing it takes effect
 * on the next request instead of the next deploy: a contract ending is not an
 * occasion to wait for a release.
 */
export function zeroRetentionProviders(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const set = new Set(
    Object.values(PROVIDER_RETENTION_TERMS)
      .filter((t) => t.qualifiesByDefault)
      .map((t) => t.provider),
  );
  const tokens = (env.AI_ZERO_RETENTION_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith("-")) {
      const name = canonicalProvider(token.slice(1));
      if (name) set.delete(name);
    } else {
      const name = canonicalProvider(token.startsWith("+") ? token.slice(1) : token);
      if (name) set.add(name);
    }
  }
  return set;
}

export interface RetentionVerdict {
  allowed: boolean;
  /** Why, for the analytics row and for the refusal message. */
  reason: "not_restricted" | "provider_trusted" | "provider_not_trusted" | "none_configured";
}

/**
 * May this provider serve this request?
 *
 * Pure, so the rule can be read and tested without an environment.
 */
export function mayServe(input: {
  sensitivity: AISensitivity | undefined;
  provider: string;
  trusted: ReadonlySet<string>;
}): RetentionVerdict {
  if (!requiresZeroRetention(input.sensitivity)) {
    return { allowed: true, reason: "not_restricted" };
  }
  if (input.trusted.size === 0) {
    /* Nobody has said which providers are under a zero-retention agreement, so
       nobody is. Refusing here is the whole point: the alternative is sending
       a medical record to a provider on the assumption somebody will fix the
       configuration later. */
    return { allowed: false, reason: "none_configured" };
  }
  return input.trusted.has(canonicalProvider(input.provider))
    ? { allowed: true, reason: "provider_trusted" }
    : { allowed: false, reason: "provider_not_trusted" };
}

/** Thrown when sensitive data has nowhere safe to go. Typed so a call site can
 *  tell it apart from a model being down, which needs a different message. */
export class RetentionPolicyError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly details: { sensitivity: string; provider: string; reason: string },
  ) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}
