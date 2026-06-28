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

## Running the continuous benchmark sweep

The continuous benchmark sweep is the always-on learning loop that replaces slow
manual testing. It is a scheduled GitHub Actions workflow,
`.github/workflows/benchmark-sweep.yml`, driving the thin orchestrator
`scripts/benchmark-sweep.mjs`. Each tick:

1. **Selects targets.** It walks `BENCHMARK_CORPUS` and keeps every entry that
   passes `assertBenchmarkConsent(target, "read-only")`
   (`src/lib/platform-scan/benchmark/sweep-targets.ts`, unit-tested in
   `__tests__/sweep-targets.test.ts`). Anything not in the corpus is refused and
   skipped; the open internet is never swept.
2. **Scans READ-ONLY.** For each selected target it spins up a real chromium browser
   and runs the SAME `runUxScan` core the live UX scan uses
   (`src/lib/platform-scan/browser/runner.ts`), which installs the read-only network
   floor on every page (only GET/HEAD ever leaves the browser) and isolates per-route
   failures. axe-core is injected per page for a11y observations.
3. **Ingests.** It POSTs the raw observations to
   `${BASE}/api/admin/platform-scans/ingest` as
   `{ platform: target.name, baseUrl: target.baseUrl, observations }`
   (Authorization: `Bearer CRON_SECRET`). Apex classifies them server-side via the
   same `classifyPage` and `recordScan`s them into the shared findings store.
4. **Triggers scoring.** After all targets are scanned and ingested, it POSTs
   `${BASE}/api/admin/platform-scans/benchmark` (`Bearer CRON_SECRET`) once to run
   server-side scoring, refreshing the recall / coverage / noise-candidate learning
   signals, and logs the returned counts.

Per-target isolation: one target failing (scan crash or a non-2xx ingest) is logged
and the sweep continues; the scoring trigger still fires for whatever ingested.

**This sweep is READ-ONLY, always.** Active recall - probing the planted vulns on a
self-hosted labeled target - is a SEPARATE, explicitly-authorized pentest run gated
by a pentest scope token (see the opt-in active-testing section above). The sweep
never mutates a target and never triggers active probing.

### Cadence

Weekly (Monday 06:00 UTC) plus `workflow_dispatch` for an on-demand run. The corpus
is small and stable, so a weekly pass keeps the signals fresh without redundant
daily runs. Adjust the `cron` in the workflow if the corpus grows.

### Secrets it needs

Set these as repository / environment secrets (same scheme as `ux-scan-sweep.yml`):

| Secret | Purpose |
|---|---|
| `TARGET_BASE_URL` | Apex base URL where the ingest + benchmark endpoints live. |
| `INGEST_SECRET` | Bearer secret for both endpoints (mapped to the script's `CRON_SECRET`). |
| `BENCHMARK_JUICE_SHOP_URL` | OPTIONAL. URL of a self-hosted labeled target on our infra (see below). Read-only here. |

Run it locally (dry run without a secret just logs what it would POST):

```sh
node scripts/benchmark-sweep.mjs \
  --base https://wolfpack-instinct.vercel.app --secret "$CRON_SECRET"
```

## Self-hosting a labeled target

To get true recall numbers the sweep needs at least one target with labeled ground
truth. Stand up an intentionally-vulnerable app ON OUR INFRA so we both own the
deployment and know the planted vulns. Never scan a public demo instance; that is a
third-party system and is off-limits.

1. **Deploy it.** OWASP Juice Shop is the seed fixture (`self-hosted-juice-shop` in
   `BENCHMARK_CORPUS`). Run it on a Wolfpack-owned host:

   ```sh
   docker run -d -p 3000:3000 bkimminich/juice-shop
   ```

   Do not expose it publicly without auth. A private host, internal network, or a
   gated Fly/Vercel deployment is fine.
2. **Point the corpus at it.** Set `BENCHMARK_JUICE_SHOP_URL` to the deployment's URL
   in the workflow's environment (and locally when running the script). The corpus
   entry reads its `baseUrl` from this env var; it is never a hardcoded remote demo.
3. **Fill in ground truth.** The seed entry already lists a few planted Juice Shop
   classes. For full recall scoring, extend its `groundTruth` array in
   `corpus.ts` with a `findingClass` + `expectedSeverity` for each planted vuln (and
   known-good baselines). The scorer reads these to compute recall (planted vulns
   found) and noise candidates (classes reported that match no label).
4. **The sweep treats it READ-ONLY.** Once `BENCHMARK_JUICE_SHOP_URL` is set, the
   continuous sweep scans it read-only like any other corpus target.

   **Active recall against it needs a separate authorized run.** Probing the planted
   vulns (the part that actually exercises recall on the injectable endpoints) is
   active testing. Even though the entry is `activeAllowed: true`, the continuous
   sweep never does it. Run active recall as a separate, explicitly-authorized
   pentest pass gated by a pentest scope token (`src/lib/platform-scan/pentest/`),
   not from this workflow.

## Adjacent labeled targets

Beyond Juice Shop, the corpus carries three more self-hosted, labeled fixtures so
recall/precision are measured across more modalities (web, api) and against an app
that mirrors our own Node/Express stack. Each reads its `baseUrl` from an env var
(same env-guarded pattern as Juice Shop); with the var unset the entry falls back
to an inert loopback placeholder the SSRF floor refuses, so nothing is probed by
accident. All are `provenance: "self-hosted-benchmark"`, `activeAllowed: true`, and
carry a modest, honest ground-truth set (a handful of well-documented classes each,
not exhaustive guesses) so the scorer's recall signal stays clean.

| Target | Env var | Modality | Why chosen |
|---|---|---|---|
| `owasp-benchmark` | `BENCHMARK_OWASP_URL` | http, browser | Industry-standard scored benchmark; the precision/recall reference for injection + crypto classes (sqli, cmdi, xpathi, ldapi, weak crypto, trust boundary, xss). |
| `vampi` | `BENCHMARK_VAMPI_URL` | http (api) | Vulnerable REST API for the api modality; covers OWASP API Top 10 classes (BOLA/IDOR, mass assignment, broken auth, excessive data exposure, sqli). |
| `nodegoat` | `BENCHMARK_NODEGOAT_URL` | http, browser | OWASP Node/Express target; matches OUR stack, so its recall signal is the closest proxy for our codebase (injection, broken access control, sensitive data exposure, security misconfig, weak crypto, ssrf). |

Self-host each on a Wolfpack-owned host (never scan a public demo instance), then
set its env var:

```sh
# OWASP Benchmark (BenchmarkJava) - build + run the scored app, then:
docker run -d -p 8443:8443 owasp/benchmark   # set BENCHMARK_OWASP_URL

# VAmPI (vulnerable REST API)
docker run -d -p 5000:5000 erev0s/vampi      # set BENCHMARK_VAMPI_URL

# OWASP NodeGoat (Node/Express) - docker compose, or npm:
docker compose -f docker-compose.yml up -d   # or: npm install && npm start ; set BENCHMARK_NODEGOAT_URL
```

**Rejected alternatives.** DVWA, bWAPP, and Mutillidae were skipped as redundant
PHP targets (Juice Shop already covers the web/JS modality and they add no class we
do not already label). WebGoat is lesson-gated (its vulns sit behind interactive
lesson state, awkward to scan headlessly). crAPI is heavier to stand up than VAmPI
for the same API modality. Google Gruyere is a hosted app, not cleanly self-hostable
on our infra, so it violates the own-the-deployment rule.
