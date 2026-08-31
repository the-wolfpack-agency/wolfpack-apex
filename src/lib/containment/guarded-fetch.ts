/**
 * The allowlist, actually enforcing.
 *
 * allowlist.ts could DECIDE whether a host was permitted. Nothing asked it. A
 * control with no caller is a library, and describing it as a control is the
 * same category of claim this codebase keeps refusing to make elsewhere — so
 * this is the wiring that makes it true.
 *
 * Shaped as a fetch so it can go in at both call sites without either provider
 * changing how it talks to its API: the Azure provider calls fetch directly,
 * and the Anthropic SDK takes a `fetch` option. One implementation, two seams,
 * no second copy of the rule.
 *
 * A refused request THROWS rather than returning a failed Response. A provider
 * that receives a 4xx retries or degrades; a provider that receives a thrown
 * EgressBlockedError stops. Refusing to reach an unexpected host and then
 * retrying it three times is not a boundary.
 *
 * Every refusal is recorded, so blocked egress becomes data the learning loop
 * can see rather than a line in a log nobody reads. The two 2026 incidents were
 * both cases where an agent reached somewhere unexpected and nobody noticed at
 * the time.
 */
import { trackEvent } from "@/lib/analytics";
import { decideEgress, type EgressCapability } from "./allowlist";

export class EgressBlockedError extends Error {
  constructor(
    message: string,
    public readonly host: string,
    public readonly capability: EgressCapability,
  ) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

export interface GuardedFetchOptions {
  /** Hosts authorized for this run only (e.g. a scan target cleared by the
   *  ownership gate). Never widens the list for anyone else. */
  extraHosts?: readonly string[];
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to trackEvent. */
  record?: (host: string, capability: EgressCapability, reason: string) => void;
}

/** Resolve whatever fetch was handed a URL, a Request or a URL object. */
export function urlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  // A Request. Reading .url avoids consuming the body.
  return (input as Request).url ?? "";
}

/**
 * A fetch that refuses anything outside the capability's allowlist.
 *
 * Returns a function with fetch's own signature, so a caller substitutes it
 * without knowing the guard exists.
 */
export function guardedFetch(capability: EgressCapability, opts: GuardedFetchOptions = {}): typeof fetch {
  const impl = opts.fetchImpl ?? fetch;
  const record =
    opts.record ??
    ((host: string, cap: EgressCapability, reason: string) => {
      trackEvent("containment.egress_blocked", "system", "system", { host, capability: cap, reason: reason.slice(0, 200) });
    });

  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlFromFetchInput(input);
    const verdict = decideEgress(url, capability, opts.extraHosts ?? []);
    if (!verdict.allowed) {
      // Record BEFORE throwing: a refusal nobody can see later is the state
      // both 2026 incidents were in while they were happening.
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return url.slice(0, 80);
        }
      })();
      record(host, capability, verdict.reason);
      throw new EgressBlockedError(`egress refused: ${verdict.reason}`, host, capability);
    }
    return impl(input, init);
  };

  return guarded as typeof fetch;
}
