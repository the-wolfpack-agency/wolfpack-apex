/**
 * WHERE a request may be processed, and why that travels with the request
 * rather than with the account.
 *
 * WHAT THE COMPETITION DOES
 *
 * A gateway that offers data residency offers it as an account setting: pick a
 * region, or filter to providers in one, once, in an admin screen. That answers
 * "where does our traffic go" with a single global answer, which is the wrong
 * shape for the question people are actually asked in an audit. The question is
 * never "where does your traffic go", it is "where did THIS record go".
 *
 * WHAT WE DO INSTEAD
 *
 * The requirement is a property of the DATA, declared on the request, exactly
 * like sensitivity already is (see retention.ts, which this deliberately
 * mirrors). A public marketing question can be answered by the cheapest model
 * anywhere on earth. The same workspace's employee records can carry
 * `residency: ["eu"]` and become unanswerable by a model in Virginia, in the
 * same deployment, in the same minute, with no setting changed by anybody.
 *
 * AND IT FAILS CLOSED, INCLUDING ON IGNORANCE. A model whose region nobody has
 * declared is refused for a request that requires one. That is the case worth
 * being strict about: "we did not know where it ran" is the answer that ends
 * badly, and it is the answer a system defaulting to "probably fine" produces.
 *
 * WHY REGIONS ARE CONFIGURATION AND NOT CONSTANTS
 *
 * Where a model runs is a fact about OUR deployment of it, not about the model.
 * The same model id is served from Sweden on one Azure resource and from Iowa
 * on another; a provider opens a region and the truth changes with no code
 * change anywhere. Writing "azure is US" into source would be asserting our own
 * infrastructure from memory, and it would be wrong the first time somebody
 * provisions a second resource.
 *
 * So regions are read from the environment, they default to UNKNOWN, and
 * unknown is refused rather than assumed. Declaring them is a deployment task
 * with a name, which is the honest cost of being able to prove the answer.
 */

/**
 * A processing region, lowercase. Deliberately a free string rather than a
 * union: a cloud opening a region must not require a code change here, and the
 * only thing this module does with the value is compare it. Callers that want a
 * display name own that mapping.
 */
export type Region = string;

/** Not declared. Distinct from "declared and wrong", which is a different fix. */
export const REGION_UNKNOWN = "unknown";

/** Env-var name carrying the region for one specific model id. */
export function modelRegionEnvVar(modelId: string): string {
  return `AI_MODEL_REGION_${modelId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

/** Env-var name carrying the default region for a whole provider. */
export function providerRegionEnvVar(provider: string): string {
  return `AI_PROVIDER_REGION_${provider.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * Where a model runs, most specific declaration first.
 *
 * Per-model beats per-provider because the mixed estate is the normal one: an
 * Azure resource in Sweden serving one deployment and one in Iowa serving
 * another is a Tuesday, and a provider-wide answer would be a confident lie
 * about half of it.
 *
 * Read at call time, never cached at import: a region declared during an
 * incident should take effect on the next request, not the next deploy.
 */
export function regionOfModel(
  input: { modelId: string; provider: string },
  /* A plain record rather than NodeJS.ProcessEnv: this repo's ProcessEnv
     declares required keys, so a test could not pass a two-line environment
     without inventing values it is not testing. process.env satisfies it. */
  env: Record<string, string | undefined> = process.env,
): Region {
  const specific = env[modelRegionEnvVar(input.modelId)]?.trim().toLowerCase();
  if (specific) return specific;
  const byProvider = env[providerRegionEnvVar(input.provider)]?.trim().toLowerCase();
  if (byProvider) return byProvider;
  return REGION_UNKNOWN;
}

/** Regions this request's data may be processed in, normalized. */
export function normalizeRequirement(required: readonly string[] | undefined): string[] {
  if (!required) return [];
  return [...new Set(required.map((r) => r.trim().toLowerCase()).filter(Boolean))];
}

export interface ResidencyVerdict {
  allowed: boolean;
  /** Why, for the analytics row and for the refusal message. */
  reason: "no_requirement" | "region_allowed" | "region_not_allowed" | "region_undeclared";
  /** Where the candidate model runs, as far as we can tell. */
  servedIn: Region;
  /** What the request asked for, normalized. Empty when it asked for nothing. */
  required: string[];
}

/**
 * May this model, in the region we believe it runs in, serve this request?
 *
 * Pure, so the rule can be read and tested without an environment.
 */
export function mayProcessHere(input: {
  required: readonly string[] | undefined;
  servedIn: Region;
}): ResidencyVerdict {
  const required = normalizeRequirement(input.required);
  const servedIn = (input.servedIn || REGION_UNKNOWN).toLowerCase();

  if (required.length === 0) {
    return { allowed: true, reason: "no_requirement", servedIn, required };
  }
  if (servedIn === REGION_UNKNOWN) {
    /* THE CASE THIS MODULE EXISTS FOR. A request that says "this may only be
       processed in the EU" cannot be satisfied by a model whose location is
       undeclared, and answering it anyway would produce exactly the sentence
       nobody can defend afterwards: we believed it was probably fine. */
    return { allowed: false, reason: "region_undeclared", servedIn, required };
  }
  return required.includes(servedIn)
    ? { allowed: true, reason: "region_allowed", servedIn, required }
    : { allowed: false, reason: "region_not_allowed", servedIn, required };
}

/**
 * Thrown when a request's data may not be processed anywhere we can reach.
 * Typed, and 422 rather than 5xx: nothing failed, the request was refused, and
 * the caller needs to say something different to the user than "try again".
 */
export class ResidencyPolicyError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly details: { required: string[]; servedIn: string; provider: string; reason: string },
  ) {
    super(message);
    this.name = "ResidencyPolicyError";
  }
}
