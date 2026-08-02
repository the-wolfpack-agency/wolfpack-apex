/**
 * A client's own models, governed exactly like ours.
 *
 * THE PRODUCT IDEA, AND WHY IT IS ALSO A SAFETY IDEA
 *
 * A client can plug in their own LLM instead of using ours. That is worth
 * having on its own — procurement, data residency, an existing vendor contract
 * — but the more interesting half is what it does to our own agents.
 *
 * If a client-supplied model runs under the same gate, the same containment
 * budget, the same behaviour eval and the same audit trail as a Wolfpack model,
 * then none of those controls can quietly be "the thing that makes OUR models
 * safe". They have to be model-agnostic to work at all. That is the OGIAM
 * claim, and letting a stranger's model through the same pipe is the strongest
 * way to keep it honest.
 *
 * A CLIENT MODEL IS UNTRUSTED CONFIGURATION
 *
 * The endpoint is a URL somebody typed. Treating it as trusted would let a
 * client — or anyone who can edit their config — point our server at internal
 * infrastructure and have us fetch it with our credentials attached. So it goes
 * through the same SSRF guard as every other outbound target, and the host must
 * additionally sit on the egress allowlist for the ai_inference capability.
 *
 * PRICE IS DECLARED, NOT VERIFIED
 *
 * We publish our own models' prices from vendor price lists. A client's numbers
 * are whatever they typed. The router still needs them to choose between
 * models, but every figure derived from them has to be labelled, or the cost
 * page quietly mixes a measured number with an asserted one and reports the
 * total as if we stood behind all of it.
 *
 * Pure. Validation only; no network, no database.
 */
import type { CapabilityTier, ModelSpec } from "./types";

/** Who supplied a model. Never inferred, never defaulted — it decides how much
 *  of what follows we are willing to claim. */
export type ModelOrigin = "wolfpack" | "client";

export interface ClientModelInput {
  id: string;
  label?: string;
  /** OpenAI-compatible completions endpoint. */
  endpoint: string;
  capabilityTier: CapabilityTier;
  contextWindow: number;
  /** Client-declared. Never presented as verified. */
  inputPricePer1kUsd: number;
  outputPricePer1kUsd: number;
}

export interface ClientModelSpec extends ModelSpec {
  origin: "client";
  endpoint: string;
  label: string;
  /** Always true for a client model. Read by the cost surface so a declared
   *  figure is never totalled as if we had verified it. */
  priceDeclaredByClient: true;
}

export type ModelRejection = { field: string; reason: string };
export type ClientModelResult =
  | { ok: true; spec: ClientModelSpec }
  | { ok: false; rejections: ModelRejection[] };

/** Namespaced so a client cannot shadow a Wolfpack model id and have their
 *  endpoint selected wherever ours was pinned. */
export const CLIENT_MODEL_PREFIX = "client:";

const ID = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/i;
const TIERS: readonly CapabilityTier[] = ["small", "large", "reasoning"];

/**
 * Validate one client-supplied model.
 *
 * Collects every problem rather than failing on the first. Someone pasting a
 * config wants to know about all three mistakes at once, not to discover them
 * across three round trips.
 *
 * `assertScannable` is injected: the real SSRF guard resolves DNS, and the
 * caller decides whether that is appropriate where it runs. It is REQUIRED, not
 * optional — an omitted guard would validate an unchecked endpoint, and the
 * signature is the place to make that impossible to forget.
 */
export function validateClientModel(
  input: ClientModelInput,
  deps: { hostAllowed: (host: string) => boolean },
): ClientModelResult {
  const rejections: ModelRejection[] = [];

  if (!ID.test(input.id ?? "")) {
    rejections.push({ field: "id", reason: "must be 3-64 characters of letters, digits, dot, dash or underscore" });
  }
  if (input.id?.startsWith(CLIENT_MODEL_PREFIX)) {
    // The prefix is ours to add. Accepting it pre-applied would let a client
    // craft "client:client:x" or otherwise reason about the namespace.
    rejections.push({ field: "id", reason: `must not already start with '${CLIENT_MODEL_PREFIX}'` });
  }
  if (!TIERS.includes(input.capabilityTier)) {
    rejections.push({ field: "capabilityTier", reason: `must be one of ${TIERS.join(", ")}` });
  }
  if (!Number.isFinite(input.contextWindow) || input.contextWindow < 1000) {
    rejections.push({ field: "contextWindow", reason: "must be a number of at least 1000 tokens" });
  }
  for (const field of ["inputPricePer1kUsd", "outputPricePer1kUsd"] as const) {
    const value = input[field];
    if (!Number.isFinite(value) || value < 0) {
      rejections.push({ field, reason: "must be a non-negative number" });
    }
  }

  const endpoint = validateEndpoint(input.endpoint, deps.hostAllowed);
  if (endpoint.problem) rejections.push({ field: "endpoint", reason: endpoint.problem });

  if (rejections.length > 0) return { ok: false, rejections };

  return {
    ok: true,
    spec: {
      id: `${CLIENT_MODEL_PREFIX}${input.id}`,
      provider: "openai", // OpenAI-compatible wire format; not OpenAI the vendor.
      origin: "client",
      label: input.label?.slice(0, 80) || input.id,
      endpoint: endpoint.normalized as string,
      capabilityTier: input.capabilityTier,
      contextWindow: Math.floor(input.contextWindow),
      inputPricePer1kUsd: input.inputPricePer1kUsd,
      outputPricePer1kUsd: input.outputPricePer1kUsd,
      priceDeclaredByClient: true,
    },
  };
}

/**
 * An endpoint we are willing to send a client's prompt to.
 *
 * HTTPS only: a plaintext endpoint would put the prompt, and whatever it
 * contains, on the wire. Loopback and private ranges are refused here rather
 * than left to the SSRF guard alone, because this value is stored and reused
 * and the clearest place to say no is when it is first offered.
 */
export function validateEndpoint(
  raw: string,
  hostAllowed: (host: string) => boolean,
): { normalized?: string; problem?: string } {
  const value = String(raw ?? "").trim();
  if (!value) return { problem: "is required" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "must be a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { problem: "must use https, so the prompt is not sent in plaintext" };
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs, error messages and analytics.
    return { problem: "must not embed credentials in the URL" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { problem: "must not point at an internal or loopback address" };
  }
  if (!hostAllowed(host)) {
    return { problem: `host '${host}' is not on the outbound allowlist for AI inference` };
  }
  return { normalized: url.toString() };
}

/**
 * Merge client models into the catalogue the router chooses from.
 *
 * Wolfpack models come FIRST and a duplicate id keeps the Wolfpack entry. Ids
 * are already namespaced so a collision should be impossible; this makes the
 * outcome defined anyway, because "impossible" and "unchecked" is how a
 * shadowing bug survives.
 */
export function buildCatalogue(
  wolfpackModels: readonly ModelSpec[],
  clientModels: readonly ClientModelSpec[],
): ModelSpec[] {
  const byId = new Map<string, ModelSpec>();
  for (const m of wolfpackModels) byId.set(m.id, m);
  for (const m of clientModels) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}

/** True when this spec came from a client. Used wherever a claim about price or
 *  behaviour needs qualifying. */
export function isClientModel(spec: ModelSpec): spec is ClientModelSpec {
  return (spec as ClientModelSpec).origin === "client";
}
