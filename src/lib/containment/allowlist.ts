/**
 * Egress allowlist: what each capability is permitted to reach.
 *
 * WHY THIS SHAPE, AND NOT A PROXY
 *
 * Three ways to control outbound traffic were on the table:
 *
 *   1. A global undici dispatcher (setGlobalDispatcher + ProxyAgent). Catches
 *      every fetch including ones inside dependencies, which is its real
 *      appeal. Rejected for now: on Vercel's runtime the global dispatcher is
 *      not reliably ours to set, and a control that silently fails to install
 *      is worse than none — it reads as protection while providing nothing.
 *   2. A network-level egress proxy with no default route. The strongest
 *      option, enforced by the kernel rather than by our code, and the right
 *      answer once agents run on our own infrastructure. It is a quarter of
 *      work and a hosting decision, so it is not this.
 *   3. An explicit wrapper every outbound call uses, plus a guardrail test that
 *      fails the build when a module bypasses it. Enforcement in-process, so a
 *      determined exploit of the runtime is out of scope — but it stops the
 *      failure that actually happened twice in 2026, which was an agent
 *      reaching somewhere nobody intended, not an attacker escaping a VM.
 *
 * This is (3), chosen because it is enforceable TODAY and because the repo
 * already proves the pattern works: no-raw-api-fetch.test.ts has kept every
 * authenticated client fetch on the refresh wrapper since April.
 *
 * The private-network check is NOT reimplemented here. It lives in
 * platform-scan/ssrf-guard.ts and is already used by the scanner and by site
 * acceptance; a second copy would be a second thing to get wrong.
 *
 * Pure: the decision takes a URL and a capability and returns a verdict. The
 * caller does the DNS work, so this is testable without a network.
 */

/** Named reasons a capability needs to reach the internet at all. */
export type EgressCapability =
  | "model-api"
  | "source-control"
  | "deploy"
  | "target-scan"
  | "template-sync";

/**
 * Hosts each capability may reach. Deliberately narrow and deliberately
 * enumerated: "whatever the task needs" is the scope statement that let a model
 * treat live infrastructure as in-bounds.
 *
 * `target-scan` is empty on purpose. Scan targets are supplied per run and
 * verified by the ownership gate, so they cannot be listed here — the runner
 * passes them as `extraHosts` and the ownership check is what authorizes them.
 */
export const EGRESS_ALLOWLIST: Readonly<Record<EgressCapability, readonly string[]>> = {
  // Azure exposes model endpoints under three different hostnames depending on
  // how the resource was created: the classic OpenAI resource, Cognitive
  // Services, and AI Foundry. All three are in use. The Foundry one was missing
  // from the first version of this list and the provider's own tests caught it
  // the moment the guard was wired in — which is the failure mode a
  // refuse-everything guard has, and why the tests assert that real endpoints
  // are ALLOWED rather than only that bad ones are refused.
  "model-api": [
    "api.anthropic.com",
    "openai.azure.com",
    "cognitiveservices.azure.com",
    "services.ai.azure.com",
  ],
  "source-control": ["api.github.com", "github.com", "raw.githubusercontent.com"],
  deploy: ["api.vercel.com", "vercel.com"],
  "target-scan": [],
  "template-sync": ["raw.githubusercontent.com", "api.github.com"],
};

export type EgressVerdict =
  | { allowed: true; capability: EgressCapability; host: string }
  | { allowed: false; reason: string; refusedBecause: "bad-url" | "scheme" | "not-allowlisted" };

/** Normalize for comparison: lowercase, no leading www, no trailing dot. */
export function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * Suffix matching that is not string-suffix matching.
 *
 * `evil-github.com`.endsWith("github.com") is true, and treating that as a
 * subdomain is a classic allowlist bypass. Only a dot-separated boundary
 * counts.
 */
export function hostMatches(host: string, allowed: string): boolean {
  const h = normalizeHost(host);
  const a = normalizeHost(allowed);
  return h === a || h.endsWith(`.${a}`);
}

/**
 * May this capability reach this URL?
 *
 * `extraHosts` covers the per-run case (a scan target authorized by the
 * ownership gate). It is a parameter rather than a mutable module list so one
 * run cannot widen the allowlist for the next.
 */
export function decideEgress(rawUrl: string, capability: EgressCapability, extraHosts: readonly string[] = []): EgressVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `not a URL: ${rawUrl.slice(0, 80)}`, refusedBecause: "bad-url" };
  }
  if (url.protocol !== "https:") {
    // http is refused outright rather than allowlisted per host: an agent's
    // traffic carries credentials and prompts, and neither belongs in clear.
    return { allowed: false, reason: `${url.protocol} is not permitted; use https`, refusedBecause: "scheme" };
  }

  const host = normalizeHost(url.hostname);
  const permitted = [...EGRESS_ALLOWLIST[capability], ...extraHosts];
  if (permitted.some((a) => hostMatches(host, a))) {
    return { allowed: true, capability, host };
  }
  return {
    allowed: false,
    reason: `${host} is not on the ${capability} allowlist (${permitted.length === 0 ? "none configured" : permitted.join(", ")})`,
    refusedBecause: "not-allowlisted",
  };
}

/** Every host any capability may reach, for the admin surface and the docs. */
export function allAllowedHosts(): string[] {
  return [...new Set(Object.values(EGRESS_ALLOWLIST).flat())].sort();
}
