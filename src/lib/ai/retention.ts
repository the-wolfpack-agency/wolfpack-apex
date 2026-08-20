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
 * AND IT FAILS CLOSED. If no eligible provider is configured, the request is
 * refused rather than quietly sent to one that keeps prompts. A control that
 * degrades to "send it anyway" is not a control, and this is the one place in
 * the router where degrading gracefully would be the wrong instinct: the
 * budget governor keeps somebody working, and this one protects somebody's
 * medical record.
 *
 * WHY THIS IS CONFIGURATION AND NOT A CONSTANT
 *
 * Retention is a fact about OUR AGREEMENT with a vendor, not about a model.
 * The same model, on the same provider, retains prompts for thirty days on one
 * contract and zero days on another. Hard-coding "azure is zero retention"
 * would be asserting somebody else's commercial terms in source code, and it
 * would be wrong the day a contract changes with nothing to catch it.
 *
 * So the list is environment configuration, it defaults to EMPTY, and an empty
 * list means no provider is trusted with sensitive data until somebody says
 * which one is. That is deliberately inconvenient in the right direction.
 */
import type { AISensitivity } from "./types";

/** Sensitivity levels that require a zero-retention provider. */
const RESTRICTED: ReadonlySet<string> = new Set(["pii", "phi"]);

export function requiresZeroRetention(sensitivity: AISensitivity | undefined): boolean {
  return sensitivity !== undefined && RESTRICTED.has(sensitivity);
}

/**
 * Providers under a zero-retention agreement, from AI_ZERO_RETENTION_PROVIDERS
 * (comma separated, e.g. "azure").
 *
 * Read at call time rather than cached at import, so changing it takes effect
 * on the next request instead of the next deploy: a contract ending is not an
 * occasion to wait for a release.
 */
export function zeroRetentionProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.AI_ZERO_RETENTION_PROVIDERS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
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
  return input.trusted.has(input.provider.toLowerCase())
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
