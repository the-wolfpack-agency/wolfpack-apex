/**
 * src/lib/ai/models/types - shapes for the cost-aware model registry + router.
 *
 * This is the substrate the agent runtime calls ONLY when it must spend
 * tokens: given a required capability + context budget (and any pins), pick
 * the cheapest capable model that is actually available in this environment.
 *
 * Mirrors the crypto algorithm-registry pattern (src/lib/crypto/algorithms.ts):
 * a frozen, named registry keyed by id, with pure resolvers and agility (swap
 * a model by editing data, not call sites). No network lives in this module -
 * selection is a pure function of the registry + inputs + env.
 *
 * In-house only: no third-party gateway, no new runtime dependency, no prompt
 * egress. Providers at launch: OpenAI direct and Azure OpenAI.
 */

/** Where a model is served from. Mirrors the two launch providers. */
/**
 * Who serves a model.
 *
 * "anthropic" was missing while anthropic-provider.ts served traffic through
 * it, so the selection registry could not describe the models the gateway was
 * actually calling. Adding it is what lets `cheapest at tier` compare Claude
 * against the rest instead of ignoring a whole provider.
 */
export type ModelProvider = "openai" | "azure" | "anthropic";

/**
 * Capability tier, ordered small < large < reasoning.
 *   small     - cheap/fast, e.g. gpt-4o-mini class.
 *   large     - gpt-4o class general models.
 *   reasoning - o-series class deliberate-reasoning models.
 *
 * The router treats this as a floor: a request for "large" may be served by a
 * "reasoning" model (it is at least as capable) but never by a "small" one.
 */
export type CapabilityTier = "small" | "large" | "reasoning";

/**
 * One registered model. Data only - no behavior. Prices are per 1k tokens in
 * USD so the router can blend input/output cost without unit juggling.
 */
export interface ModelSpec {
  /** Registry key. Stable, lowercase, vendor-recognizable id. */
  id: string;
  /** Serving provider. Drives which env vars gate availability. */
  provider: ModelProvider;
  /**
   * For Azure models: the env var that holds the deployment name for this
   * model. Azure addresses models by per-resource deployment name, not by the
   * canonical model id, so availability additionally requires this var to be
   * set. OpenAI models leave this undefined.
   */
  deploymentEnvVar?: string;
  /**
   * For a model served from a DIFFERENT Azure endpoint than the classic OpenAI
   * resource — an AI Foundry serverless deployment such as DeepSeek, Llama or
   * Mistral. Those live on *.services.ai.azure.com and carry their own key, so
   * a single shared AZURE_OPENAI_ENDPOINT cannot address them.
   *
   * Left undefined for classic Azure OpenAI models, which share the resource
   * endpoint. The provider already speaks both URL shapes and detects which
   * from the hostname, so this is the only thing that was missing.
   */
  endpointEnvVar?: string;
  /** Key for that endpoint, when it differs from AZURE_OPENAI_API_KEY. */
  apiKeyEnvVar?: string;
  /** Capability floor this model satisfies. */
  capabilityTier: CapabilityTier;
  /** Max context window in tokens. Used to filter on minContextTokens. */
  contextWindow: number;
  /** List price per 1k INPUT tokens, USD. */
  inputPricePer1kUsd: number;
  /** List price per 1k OUTPUT tokens, USD. */
  outputPricePer1kUsd: number;
}

/** The router's decision. Always returned - the router never throws. */
export interface ModelSelection {
  /** The chosen model spec. */
  model: ModelSpec;
  /**
   * Machine-readable reason code for why this model was chosen, e.g.
   * "agent_pin" | "cheapest_at_tier" | "downgraded_no_tier_available"
   * | "no_model_available_using_default". Stable enough to dashboard on.
   */
  reason: string;
  /**
   * Blended estimated cost in USD for this call, when token estimates were
   * supplied via SelectOptions. Omitted when no estimate could be formed.
   */
  estimatedCostUsd?: number;
  /**
   * When a pin (agent/client/workspace) was set but unknown or unavailable,
   * this carries the pinned id we degraded away from, so the decision is
   * auditable and never silently dropped.
   */
  fallbackFrom?: string;
}

/** Inputs to selectModel(). All optional - sensible defaults applied. */
export interface SelectOptions {
  /** Minimum capability floor. Defaults to "small". */
  requiredTier?: CapabilityTier;
  /** Minimum context window in tokens. Defaults to 0. */
  minContextTokens?: number;
  /** Highest-precedence pin: a specific agent insists on a model id. */
  agentPin?: string;
  /** Next pin: a specific client insists on a model id. */
  clientPin?: string;
  /** Lowest pin: a workspace default model id. */
  workspacePin?: string;
  /** Estimated input tokens, used to weight the cost blend + estimate cost. */
  estInputTokens?: number;
  /** Estimated output tokens, used to weight the cost blend + estimate cost. */
  estOutputTokens?: number;
}

/**
 * Context passed alongside a ModelSelection to logModelSelection() so the
 * decision is attributed to a user/role in analytics. Mirrors trackEvent's
 * (event, userId, userRole, metadata) shape without leaking it to the router.
 */
export interface ModelSelectionLogContext {
  userId: string;
  userRole: string;
  /** Optional extra metadata merged into the analytics payload. */
  extra?: Record<string, string | number | boolean>;
}
