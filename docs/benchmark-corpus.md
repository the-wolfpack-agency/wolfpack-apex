# Consent-to-Test Benchmark Corpus

The benchmark corpus is the curated, explicitly-authorized set of targets the
platform scanner may run against for active learning. It is the labeled dataset
that drives detector improvement: the scorer measures detector precision and
recall against the ground truth attached to each entry.

Source of truth: `src/lib/platform-scan/benchmark/corpus.ts`. Guardrail tests:
`src/lib/platform-scan/benchmark/__tests__/corpus.test.ts`.

## The consent model (this is the whole point)

The corpus is an ALLOWLIST. Nothing outside it is benchmarkable, full stop. Every
entry is authorized by exactly one of three provenances:

| Provenance | What it is | Read-only benchmarking | Active (mutating/pentest) benchmarking |
|---|---|---|---|
| `own` | Systems WE operate (wolfpack-instinct, ogiam.com, beyond, wolfpack-auto). | Always allowed. | Only if the entry sets `activeAllowed: true`. Production own systems default to `false`. |
| `self-hosted-benchmark` | Intentionally-vulnerable apps WE run on OUR infra (e.g. a self-hosted OWASP Juice Shop). We own them AND know the planted vulns. | Always allowed. | Allowed when `activeAllowed: true`. This is the place active probing is encouraged. |
| `opt-in` | A partner who signed an authorization agreement. | Allowed once in the corpus. | NEVER automatic. Requires a separate signed-authorization gate (a pentest scope token). `assertBenchmarkConsent` refuses active mode for opt-in by design. |

## The open internet is NEVER scanned, and why

We do not, and will not, point the scanner at arbitrary internet targets, even
read-only, even "just to learn." Reasons:

- **Legal.** Unauthorized scanning of a third party is CFAA / Computer Misuse Act
  exposure. Active (mutating) probing of a system we do not own or have written
  authorization for is a crime in most jurisdictions.
- **Terms of service.** Public demo and SaaS targets forbid automated scanning in
  their ToS. "It was educational" is not a defense.
- **Ownership gate.** The live scan path already enforces ownership verification
  (`isTargetVerified` via well-known token / DNS TXT) and curated-target status
  (`isCuratedTarget`). The benchmark corpus is the learning-path parallel: it only
  contains targets we own, host ourselves, or have a signed opt-in for.

The guardrail makes this structural, not a matter of discipline: `BENCHMARK_CORPUS`
is the only set of benchmarkable targets, and `assertBenchmarkConsent` throws a
`BenchmarkConsentError` for anything not in it.

## The guardrail

```ts
import {
  isBenchmarkTarget,
  getBenchmarkTarget,
  assertBenchmarkConsent,
} from "@/lib/platform-scan/benchmark/corpus";

// Before any benchmark run, gate by mode. Throws BenchmarkConsentError unless
// allowed. Call this at the entry point of the learning/benchmark runner.
assertBenchmarkConsent(target, "read-only"); // any corpus target
assertBenchmarkConsent(target, "active");    // only activeAllowed own/self-hosted
```

Rules enforced by `assertBenchmarkConsent`:

- `read-only` is allowed for ANY corpus target (own / self-hosted / opt-in).
- `active` is allowed ONLY when `activeAllowed === true` AND provenance is `own`
  or `self-hosted-benchmark`.
- Active on an `opt-in` target is refused with reason
  `opt_in_active_requires_signed_authorization`.
- Anything not in the corpus throws `not_in_corpus` for BOTH modes.

## Recommended self-hostable benchmarks (RUN ON OUR INFRA, never scan remotely)

Stand these up on Wolfpack-owned infrastructure so we both own the deployment and
know the planted vulnerabilities. Never scan the public demo instances of these
projects; that is a third-party system and is off-limits.

- **OWASP Juice Shop** - modern JS app with a broad, well-documented set of
  planted vulns (SQLi, XSS, broken auth, IDOR). The seed entry
  `self-hosted-juice-shop` is configured for this. Run via Docker:
  `docker run -d -p 3000:3000 bkimminich/juice-shop`, then set
  `BENCHMARK_JUICE_SHOP_URL` to its URL on our infra.
- **OWASP Benchmark** - a large set of labeled true/false positive test cases,
  ideal for measuring static-analysis precision/recall.
- **Google Gruyere** - small intentionally-vulnerable app good for a focused XSS /
  injection regression fixture.

## How to add a self-hosted target with labeled ground truth

1. Deploy the vulnerable app on our infra (Docker on a Wolfpack-owned host, or a
   private Vercel/Fly deployment). Do NOT expose it publicly without auth.
2. Add an entry to `BENCHMARK_CORPUS` with:
   - `provenance: "self-hosted-benchmark"`,
   - `activeAllowed: true` (we own it and know the vulns),
   - `baseUrl` read from an env var (like `BENCHMARK_JUICE_SHOP_URL`), never a
     hardcoded remote demo,
   - a `consentNote` stating we own the deployment, and
   - `groundTruth` items for each planted vuln (and known-good baselines), using a
     stable `findingClass` key and the `expectedSeverity` a correct detector should
     assign.
3. The scorer reads `groundTruth` to compute recall (planted vulns found) and
   precision (findings that match a labeled item vs. false positives).

## How an operator adds an opt-in partner

1. Obtain a SIGNED authorization agreement from the partner naming the target
   host(s) and the allowed scope of testing. File it with legal.
2. Add a `provenance: "opt-in"` entry with `activeAllowed: false` and a
   `consentNote` referencing the signed agreement (who/when).
3. Read-only benchmarking is now allowed for that target.
4. ACTIVE testing of an opt-in target is never granted by the corpus. It requires
   a separate signed-authorization gate: issue a pentest scope token through the
   existing scope flow (`src/lib/platform-scan/pentest/scope.ts` + the
   `assertPentestAuthorized` guard), which checks the active/unexpired/in-scope
   token, the SSRF floor, and the OGIAM enforce-mode gate. The benchmark corpus
   does not, and must not, auto-promote an opt-in target to active.
