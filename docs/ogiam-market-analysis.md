# OGIAM Market Analysis (internal)

Status: working analysis. Honest and grounded. Financial figures are illustrative
scenarios with stated assumptions, dependent on execution and sales, not
forecasts. Do NOT publish.

## 1. Comparable products and services, and where they fall short

| Category | Examples | What they do | Where they fall short (our opening) |
|---|---|---|---|
| Boutique / firm pen testing | NCC, Bishop Fox, Big 4 | Human-led, high-quality point-in-time pen test + report | Slow (weeks), expensive ($15k to $50k+), stale the day it ships, find-not-fix, no continuity |
| Pen-test-as-a-service | Cobalt, HackerOne, Synack, Bugcrowd | Human + platform, faster, subscription/credits | Still human-bottlenecked, costly, mostly find-not-fix, no deterministic governance or full-system mapping |
| SAST / DAST / SCA tooling | Snyk, Semgrep, Checkmarx, Veracode, GitHub Advanced Security, Detectify, Intruder | Automated code/app scanning | High false-positive rates (scanner fatigue), no active confirmation, limited remediation (Snyk opens dep PRs only), no system map, no governance layer |
| Attack-surface / continuous monitoring | Various ASM vendors | Watch the external surface continuously | Breadth not depth, no remediation, no governed action |
| Automated QA | Mabl, Testim, Playwright suites | UI test automation | Quality only, not security, not remediation |
| AI-native security agents (emerging) | AI-pentest and AI-remediation startups (2024 to 2026) | AI-driven pen test OR AI remediation | Fast-moving and well-funded, but mostly SINGLE-capability, and few have a deterministic governance gate + tamper-evident audit. They are often the risk, not the control |

## 2. The whitespace we fill (not sold as one product today)

1. One governed agent across the FULL lifecycle: map, diagnose, verify security,
   actively confirm vulnerabilities, recommend automations, open remediation pull
   requests, report, and keep it current. Competitors are point solutions; nobody
   packages the whole arc under one governed agent.
2. Deterministic governance + tamper-evident audit ON the agent's actions. As
   enterprises adopt AI agents, "prove what the agent did and that it could not
   exceed its authority" becomes the buying question. Our gate + audit chain is
   built for exactly that. Most AI security tools lack this; they are the new risk
   surface, we are the control over it.
3. Fix, not just find: an actively confirmed finding becomes a review-gated pull
   request, re-verified on the next run. The find-fix-verify loop, closed and
   governed, across classes (not just dependency bumps).
4. Precision first: we deliberately chose precision over recall (the difference
   between a noisy 690-finding dump and a trustworthy near-zero-false-positive
   signal). Scanner fatigue is the top reason security tools get ignored.
5. Onboard-once, deploy-fast: register a target and get a baseline in hours to
   days, then continuous, versus weeks for a consultancy.

## 3. Speed and time-to-deployment

- Traditional pen test: weeks (scoping, execution, write-up).
- OGIAM: onboard a target in minutes, baseline (map + scan + recommend + report)
  in hours to days, continuous thereafter. Active testing turns on the same day a
  scope is authorized.
- Time-to-first-value is measured in days, not weeks. That compression is itself
  a sellable differentiator and lowers the trial barrier for a first engagement.

## 4. Realistic value at scale

Markets for context (real and growing): application security and pen testing is a
multi-billion-dollar market (pen testing alone roughly $2B to $4B, broader AppSec
$10B+), DevSecOps tooling is growing double digits, and "AI agent governance and
security" is an emerging category forming now. We do not need a large share of
these to be a strong business.

Bottom-up, grounded in the actual motion (warm clients first). Assumptions are
explicit; treat as scenarios, not forecasts.

Pricing assumed (from the pricing doc): Baseline Engagement $6k to $12k one-time;
subscription blended $4k to $8k per system per month for Pro/Enterprise.

| Scenario | Clients | Systems/client | Blended sub | Approx recurring ARR | + engagements | Notes |
|---|---|---|---|---|---|---|
| Year 1 (warm clients) | 6 | 1.5 | $5k/mo | ~$540k | ~$50k | Land existing trusting clients, read-only first |
| Year 2 (expand + new logos + case studies) | 18 | 2 | $6k/mo | ~$2.6M | ~$150k | Land-and-expand, first referenceable wins |
| Year 3 (category traction) | 35 | 2.5 | $7k/mo | ~$7.3M | ~$300k | Requires repeatable sales motion |

These are execution-dependent. The honest read: a focused, well-executed niche
product starting from warm relationships can realistically reach roughly $0.5M
ARR in year 1 and a few million ARR within 2 to 3 years. Security SaaS trades at
roughly 5x to 10x ARR, so a few million ARR implies tens of millions of
enterprise value at the upper end of execution. That is a real, valuable
business, not a unicorn fantasy and not a rounding error.

The single biggest accelerant is the warm-client beachhead: existing clients who
trust us remove the hardest part of security sales (trust + the first reference).
Each becomes a production deployment and a case study that compounds.

## 5. Risks and what has to be true (honest)

- The AI-pentest / AI-remediation space is hot and well-funded; speed of execution
  matters. Our durable edge is the governance + audit + full-arc + precision
  combination, plus warm clients, not any single feature.
- Active pen testing carries liability; the signed rules-of-engagement + fail-closed
  harness mitigate it, but it must stay disciplined.
- Security sales cycles are long for cold logos; the warm-client beachhead is what
  makes year 1 realistic.
- Incumbents will add AI; our answer is the governed full-lifecycle agent they are
  not structured to ship quickly, and the precision + trust posture.
- Multi-tenant + per-client credential model (GitHub App) must land before scaling
  beyond a handful of clients (see the deployment plan).

## 6. Verdict

The product is functionally complete and proven end-to-end, fills a real
whitespace (the unified, governed, precise, fix-not-just-find lifecycle agent),
deploys in days, and starts from trusting clients. The realistic path is land the
warm clients read-only, convert to continuous subscriptions, graduate to
authorized active testing, and let case studies compound into new logos. A few
million ARR within 2 to 3 years is a grounded target with the beachhead we have.

## Related
- [ogiam-pricing-and-packaging.md](./ogiam-pricing-and-packaging.md)
- [ogiam-client-deployment-plan.md](./ogiam-client-deployment-plan.md)
