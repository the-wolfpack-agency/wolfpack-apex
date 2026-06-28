/**
 * THE CONSENT-TO-TEST BENCHMARK CORPUS.
 *
 * This is the curated, EXPLICITLY-authorized set of targets the scanner may run
 * against for active learning. It is the labeled dataset that drives detector
 * improvement: each entry can carry ground-truth findings (known planted vulns or
 * known-good baselines) so the scorer can measure precision/recall against a
 * trusted answer key.
 *
 * THE WHOLE POINT IS SAFETY. The open internet is NEVER a benchmark target. The
 * corpus is an ALLOWLIST: nothing outside it is benchmarkable, full stop. We only
 * include targets we are authorized to test, by one of three provenances:
 *
 *   - "own"                  systems WE operate (wolfpack-instinct, ogiam.com,
 *                            beyond, wolfpack-auto). We own them; read-only
 *                            benchmarking is always fine. Active probing is still
 *                            gated behind an explicit per-entry activeAllowed flag
 *                            (defaults to read-only for production systems).
 *   - "self-hosted-benchmark" intentionally-vulnerable apps WE run on OUR infra
 *                            (e.g. a self-hosted OWASP Juice Shop instance). We
 *                            both OWN them AND know the planted vulns, so they are
 *                            the ideal recall fixtures and the ONLY place active
 *                            probing is encouraged.
 *   - "opt-in"               a partner who signed an authorization agreement.
 *                            Read-only is allowed once they are in the corpus, but
 *                            ACTIVE probing of an opt-in target is NEVER automatic:
 *                            it requires a separate signed-authorization gate
 *                            (a scope token issued through the pentest scope flow),
 *                            and assertBenchmarkConsent refuses active mode for any
 *                            opt-in entry by design.
 *
 * Mirrors the existing scan-authorization model: curated targets (isCuratedTarget)
 * and ownership-verified targets (isTargetVerified) are the parallel gates for the
 * live scan path. This corpus is the consent-curated parallel for the LEARNING
 * path. NEVER hardcode an active benchmark of a third-party production domain here.
 */

/**
 * One labeled fact about a benchmark target: a vulnerability we KNOW is present
 * (a planted Juice Shop flaw, a deliberately-misconfigured header) or a known
 * baseline. The scorer matches detector output against these to compute
 * precision/recall.
 *
 *  - findingClass     a stable key identifying the issue class. Use the scanner's
 *                     own finding identity where possible, e.g.
 *                     "security:CORS wildcard with credentials", or a known-vuln
 *                     id for a benchmark app (e.g. "juice-shop:DOM XSS").
 *  - expectedSeverity the severity a correct detector should assign (optional;
 *                     omit when only presence, not severity, is being scored).
 *  - note             free-text context for the operator / scorer (where the vuln
 *                     lives, how it was planted).
 */
export interface GroundTruthItem {
  findingClass: string;
  expectedSeverity?: "critical" | "high" | "medium" | "low";
  note?: string;
}

/** Provenance is the consent basis. It is the field the guardrail keys on. */
export type BenchmarkProvenance = "own" | "self-hosted-benchmark" | "opt-in";

/**
 * One authorized benchmark target.
 *
 *  - name           stable key (matches a scan platform name where one exists).
 *  - baseUrl        the target origin. For self-hosted benchmarks this should be
 *                   an env-driven URL pointing at OUR infra, never a remote
 *                   third-party demo instance.
 *  - provenance     the consent basis (see BenchmarkProvenance).
 *  - activeAllowed  whether MUTATING / pentest probing is permitted. Only ever
 *                   true for own / self-hosted-benchmark entries we control.
 *                   Production own systems default to false (read-only).
 *  - modality       which scan modalities are valid for this target.
 *  - groundTruth    the labeled answer key (optional; present for fixtures whose
 *                   vulns/baselines we know).
 *  - consentNote    WHO/WHAT authorizes this target. Required on every entry: it
 *                   is the human-auditable record of why this target is allowed.
 */
export interface BenchmarkTarget {
  name: string;
  baseUrl: string;
  provenance: BenchmarkProvenance;
  activeAllowed: boolean;
  modality: ("http" | "static" | "browser")[];
  groundTruth?: GroundTruthItem[];
  consentNote: string;
}

/** Thrown by assertBenchmarkConsent when a benchmark would violate the consent
 *  contract. Carries a coarse reason for audit, never any secret. */
export class BenchmarkConsentError extends Error {
  reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "BenchmarkConsentError";
    this.reason = reason;
  }
}

/**
 * Where a self-hosted intentionally-vulnerable benchmark app is reachable on OUR
 * infra. Env-driven so the URL is configured per-environment (and absent in CI),
 * NEVER a hardcoded remote demo. Falls back to a localhost placeholder that
 * documents the shape; the SSRF guard on the live scan path refuses loopback, so
 * the placeholder cannot be probed by accident.
 */
const SELF_HOSTED_JUICE_SHOP_URL =
  process.env.BENCHMARK_JUICE_SHOP_URL ?? "http://localhost:3000";

/**
 * OWASP Benchmark (github.com/OWASP-Benchmark/BenchmarkJava): a large
 * industry-standard set of labeled true/false-positive test cases for measuring
 * static-analysis-style precision/recall across injection + crypto classes.
 * Same env-driven pattern: configured per-environment, absent in CI. The unset
 * localhost placeholder is inert (the SSRF floor on the live scan path refuses
 * loopback), so it can never be probed by accident.
 */
const SELF_HOSTED_OWASP_BENCHMARK_URL =
  process.env.BENCHMARK_OWASP_URL ?? "http://localhost:8443";

/**
 * VAmPI (github.com/erev0s/VAmPI): a deliberately-vulnerable REST API used as
 * the API-modality recall fixture (BOLA/IDOR, mass assignment, broken auth,
 * excessive data exposure, SQLi). Env-driven; unset falls back to an inert
 * localhost placeholder the SSRF floor refuses.
 */
const SELF_HOSTED_VAMPI_URL =
  process.env.BENCHMARK_VAMPI_URL ?? "http://localhost:5000";

/**
 * OWASP NodeGoat (github.com/OWASP/NodeGoat): an intentionally-vulnerable
 * Node/Express app demonstrating the OWASP Top 10. Chosen because it matches our
 * OWN stack (Node/Express server surface), making its recall signal the closest
 * proxy for our codebase. Env-driven; unset falls back to an inert localhost
 * placeholder the SSRF floor refuses.
 */
const SELF_HOSTED_NODEGOAT_URL =
  process.env.BENCHMARK_NODEGOAT_URL ?? "http://localhost:4000";

/**
 * THE ALLOWLIST. Every entry is authorized; nothing outside this array is
 * benchmarkable. Our OWN apps are read-only by default; the one
 * self-hosted-benchmark entry demonstrates the activeAllowed + groundTruth recall
 * path. No third-party production domain appears here.
 */
export const BENCHMARK_CORPUS: BenchmarkTarget[] = [
  {
    name: "wolfpack-instinct",
    baseUrl: "https://wolfpack-instinct.vercel.app",
    provenance: "own",
    activeAllowed: false,
    modality: ["http", "browser"],
    consentNote:
      "Wolfpack Agency operates this system (this very product). Read-only benchmarking only; production data present, so active probing is disabled.",
  },
  {
    name: "ogiam",
    baseUrl: "https://ogiam.com",
    provenance: "own",
    activeAllowed: false,
    modality: ["http", "browser"],
    consentNote:
      "Wolfpack Agency operates ogiam.com. Read-only benchmarking only; public marketing + product surface, no active probing of production.",
  },
  {
    name: "wolfpack-beyond",
    baseUrl: "https://beyond-sku.vercel.app",
    provenance: "own",
    activeAllowed: false,
    modality: ["http", "static", "browser"],
    consentNote:
      "Wolfpack Agency operates wolfpack-beyond (Beyond OS). Read-only benchmarking only; production tenant data present.",
  },
  {
    name: "wolfpack-auto",
    baseUrl: "https://wolfpack-auto.vercel.app",
    provenance: "own",
    activeAllowed: false,
    modality: ["http", "static", "browser"],
    consentNote:
      "Wolfpack Agency operates wolfpack-auto (dealer platform). Read-only benchmarking only; production dealer/customer data present.",
  },
  {
    // EXAMPLE self-hosted-benchmark entry. We run OWASP Juice Shop on OUR infra
    // (see docs/benchmark-corpus.md), so we both OWN it and know its planted
    // vulns. This is the recall fixture: activeAllowed is true and groundTruth
    // gives the scorer an answer key. The URL is env-driven (our infra), never a
    // remote demo instance.
    name: "self-hosted-juice-shop",
    baseUrl: SELF_HOSTED_JUICE_SHOP_URL,
    provenance: "self-hosted-benchmark",
    activeAllowed: true,
    modality: ["http", "browser"],
    consentNote:
      "Intentionally-vulnerable OWASP Juice Shop deployed on Wolfpack-owned infra (set BENCHMARK_JUICE_SHOP_URL). We own the deployment AND know the planted vulns; active probing authorized.",
    groundTruth: [
      {
        findingClass: "juice-shop:SQL injection (login bypass)",
        expectedSeverity: "critical",
        note: "Email field on POST /rest/user/login is injectable; ' OR 1=1-- bypasses auth.",
      },
      {
        findingClass: "juice-shop:DOM XSS (search)",
        expectedSeverity: "high",
        note: "The product search reflects the q param into the DOM unescaped.",
      },
      {
        findingClass: "security:CORS wildcard with credentials",
        expectedSeverity: "medium",
        note: "Access-Control-Allow-Origin: * with credentials on the REST API.",
      },
    ],
  },
  {
    // OWASP Benchmark (BenchmarkJava): an industry-standard, fully-scored corpus
    // of labeled vulnerable + benign test cases. We self-host it on our infra
    // (set BENCHMARK_OWASP_URL); it is the precision/recall reference for the
    // injection + crypto detector classes. Ground truth lists a modest set of
    // the well-documented categories it plants, not every one of its thousands
    // of cases - the scorer measures recall over labeled items only.
    name: "owasp-benchmark",
    baseUrl: SELF_HOSTED_OWASP_BENCHMARK_URL,
    provenance: "self-hosted-benchmark",
    activeAllowed: true,
    modality: ["http", "browser"],
    consentNote:
      "Industry-standard scored OWASP Benchmark deployed on Wolfpack-owned infra (set BENCHMARK_OWASP_URL). We own the deployment AND the labeled answer key; active probing authorized.",
    groundTruth: [
      {
        findingClass: "security:SQL injection",
        expectedSeverity: "high",
        note: "OWASP Benchmark sqli test cases reflect tainted input into SQL.",
      },
      {
        findingClass: "security:Command injection",
        expectedSeverity: "critical",
        note: "cmdi test cases pass tainted input to a shell/exec.",
      },
      {
        findingClass: "security:XPath injection",
        expectedSeverity: "high",
        note: "xpathi test cases build XPath queries from tainted input.",
      },
      {
        findingClass: "security:LDAP injection",
        expectedSeverity: "high",
        note: "ldapi test cases concatenate tainted input into an LDAP filter.",
      },
      {
        findingClass: "security:Weak cryptography",
        expectedSeverity: "medium",
        note: "crypto/hash test cases use broken algorithms (DES, MD5, etc.).",
      },
      {
        findingClass: "security:Trust boundary violation",
        expectedSeverity: "medium",
        note: "trustbound test cases store tainted data across a trust boundary (e.g. session).",
      },
      {
        findingClass: "security:Reflected XSS",
        expectedSeverity: "high",
        note: "xss test cases reflect tainted input into the HTTP response unescaped.",
      },
    ],
  },
  {
    // VAmPI (Vulnerable API): a deliberately-vulnerable REST API. The api-modality
    // recall fixture - the classes here are API-specific (OWASP API Top 10) rather
    // than browser/DOM. Self-hosted on our infra (set BENCHMARK_VAMPI_URL).
    name: "vampi",
    baseUrl: SELF_HOSTED_VAMPI_URL,
    provenance: "self-hosted-benchmark",
    activeAllowed: true,
    modality: ["http"],
    consentNote:
      "Self-hosted vulnerable REST API (VAmPI) on Wolfpack-owned infra for the api modality (set BENCHMARK_VAMPI_URL). We own the deployment AND know the planted flaws; active probing authorized.",
    groundTruth: [
      {
        findingClass: "security:Broken object level authorization (IDOR)",
        expectedSeverity: "high",
        note: "GET /users/v1/{username} and book endpoints leak other users' objects (BOLA/IDOR).",
      },
      {
        findingClass: "security:Mass assignment",
        expectedSeverity: "high",
        note: "User registration accepts an admin flag in the body (mass assignment to privileged field).",
      },
      {
        findingClass: "security:Broken authentication",
        expectedSeverity: "high",
        note: "Weak/forgeable JWT handling and unauthenticated sensitive routes.",
      },
      {
        findingClass: "security:Excessive data exposure",
        expectedSeverity: "medium",
        note: "User listing endpoint returns password fields and other sensitive attributes.",
      },
      {
        findingClass: "security:SQL injection",
        expectedSeverity: "high",
        note: "Debug/user lookup endpoints concatenate input into SQL.",
      },
    ],
  },
  {
    // OWASP NodeGoat: an intentionally-vulnerable Node/Express OWASP Top 10
    // teaching app. Chosen because it matches OUR stack (Node/Express), so its
    // recall signal is the closest proxy for our own codebase. Self-hosted on our
    // infra (set BENCHMARK_NODEGOAT_URL).
    name: "nodegoat",
    baseUrl: SELF_HOSTED_NODEGOAT_URL,
    provenance: "self-hosted-benchmark",
    activeAllowed: true,
    modality: ["http", "browser"],
    consentNote:
      "OWASP NodeGoat (Node/Express OWASP Top 10 target) on Wolfpack-owned infra (set BENCHMARK_NODEGOAT_URL); matches our own stack. We own the deployment AND know the planted vulns; active probing authorized.",
    groundTruth: [
      {
        findingClass: "security:Injection",
        expectedSeverity: "high",
        note: "Allocations/contributions pages evaluate tainted input (NoSQL / server-side code injection).",
      },
      {
        findingClass: "security:Broken access control",
        expectedSeverity: "high",
        note: "Missing authorization checks allow horizontal/vertical privilege escalation between users.",
      },
      {
        findingClass: "security:Sensitive data exposure",
        expectedSeverity: "medium",
        note: "Profile/SSN fields stored and returned without adequate protection.",
      },
      {
        findingClass: "security:Security misconfiguration",
        expectedSeverity: "medium",
        note: "Missing security headers / unsafe Express configuration.",
      },
      {
        findingClass: "security:Weak cryptography",
        expectedSeverity: "medium",
        note: "Passwords hashed with a weak/unsalted scheme.",
      },
      {
        findingClass: "security:SSRF",
        expectedSeverity: "high",
        note: "Profile page fetches a user-supplied URL server-side (server-side request forgery).",
      },
    ],
  },
];

/** Lower-case + strip a trailing slash so name/URL lookups are stable. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Resolve a corpus entry by its name OR its baseUrl. Returns null when the
 * identifier is not in the allowlist. This is the single lookup the guardrail and
 * the scorer share, so "in the corpus" has exactly one meaning.
 */
export function getBenchmarkTarget(nameOrUrl: string): BenchmarkTarget | null {
  if (!nameOrUrl) return null;
  const needle = normalize(nameOrUrl);
  for (const target of BENCHMARK_CORPUS) {
    if (normalize(target.name) === needle) return target;
    if (normalize(target.baseUrl) === needle) return target;
  }
  return null;
}

/** True iff the identifier (name or baseUrl) is in the consent corpus. */
export function isBenchmarkTarget(nameOrUrl: string): boolean {
  return getBenchmarkTarget(nameOrUrl) !== null;
}

/**
 * THE CONSENT GUARDRAIL. Throws BenchmarkConsentError unless the target is in the
 * corpus AND the requested mode is permitted:
 *
 *   - read-only  allowed for ANY corpus target (own / self-hosted / opt-in).
 *   - active     allowed ONLY when target.activeAllowed is true AND provenance is
 *                "own" or "self-hosted-benchmark". Active probing of an "opt-in"
 *                target is REFUSED here by design: an opt-in partner authorizing
 *                inclusion does NOT authorize mutation. Active testing of an
 *                opt-in target needs a separate signed-authorization gate (a
 *                pentest scope token issued through the scope flow) and is never
 *                granted automatically by this corpus.
 *
 * Anything not in the corpus throws for BOTH modes: the open internet is never
 * benchmarkable.
 */
export function assertBenchmarkConsent(
  target: BenchmarkTarget | string,
  mode: "read-only" | "active",
): void {
  const resolved =
    typeof target === "string"
      ? getBenchmarkTarget(target)
      : getBenchmarkTarget(target.name) ?? getBenchmarkTarget(target.baseUrl);

  if (!resolved) {
    throw new BenchmarkConsentError(
      "not_in_corpus",
      "target is not in the consent benchmark corpus; benchmarking is refused (the open internet is never a target)",
    );
  }

  if (mode === "read-only") return;

  // mode === "active"
  if (!resolved.activeAllowed) {
    throw new BenchmarkConsentError(
      "active_not_allowed",
      `active benchmarking is not enabled for ${resolved.name} (activeAllowed is false)`,
    );
  }
  if (resolved.provenance === "opt-in") {
    throw new BenchmarkConsentError(
      "opt_in_active_requires_signed_authorization",
      `active benchmarking of opt-in target ${resolved.name} requires a separate signed-authorization gate (a pentest scope token); it is never granted automatically by the corpus`,
    );
  }
}
