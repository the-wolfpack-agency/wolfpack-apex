# OGIAM Market Analysis (internal)

Status: working analysis. Honest and grounded. Financial figures are illustrative
scenarios with stated assumptions, dependent on execution and sales, not
forecasts. Do NOT publish.

Last major revision reflects the cross-layer capability buildout (multi-layer
scanning, cross-scan insights, self + competitive benchmarking, the OGIAM AI
gate, and the in-product close-the-loop). Shipped capability is grounded in code;
where something is partial or phased, it is flagged explicitly.

## 0. Positioning (what we now are)

We are the know-all system of record for whether a client's software AND the AI
acting on it are correct, secure, accessible, and improving over time. One tool
scans every layer of a client system (frontend/UI, backend/APIs, database and
tenant isolation, security passively and actively, accessibility, UX, and
end-to-end user journeys), correlates findings ACROSS those layers and over
history into higher-order insights, governs any AI agent that touches the system
through a deterministic, tamper-evident gate, and closes the loop from finding to
fix to a safe production promotion, in one place.

That category did not previously exist as a single product. The market sells
each layer separately: a DAST tool here, a SAST tool there, an accessibility
checker, a QA suite, an emerging AI-governance point solution. Buyers stitch them
together and still have no single system that says "your software is correct,
secure, accessible, and improving, and here is the proof." We are that system.

This is a deliberate widening from the prior framing (a governed pen-test +
remediation agent). Security is still a spine of the product, but the honest
description of what shipped is broader than security alone, and the strategy
sections below are updated to match.

## 1. Comparable products and services, and where they fall short

The structural pattern across the whole landscape: every category is single-LAYER
(or single-capability). The opening is not that any one of them is bad at its job;
several are excellent. The opening is that NONE of them sees the whole system at
once, so none can correlate across layers, and the buyer is left integrating
point tools and reconciling their findings by hand.

| Category | Examples | What they do | Layer(s) covered | Where they fall short (our opening) |
|---|---|---|---|---|
| Boutique / firm pen testing | NCC, Bishop Fox, Big 4 | Human-led, high-quality point-in-time pen test + report | Security | Slow (weeks), expensive, stale the day it ships, find-not-fix, no continuity, single-layer |
| Pen-test-as-a-service | Cobalt, HackerOne, Synack, Bugcrowd | Human + platform, faster, subscription/credits | Security | Still human-bottlenecked, costly, mostly find-not-fix, no deterministic governance, no cross-layer map |
| SAST / DAST / SCA tooling | Snyk, Semgrep, Checkmarx, Veracode, GitHub Advanced Security, Detectify, Intruder | Automated code/app scanning | Security (code or app surface) | High false-positive rates (scanner fatigue), no active confirmation, limited remediation (Snyk opens dep PRs only), no cross-layer correlation, no governance layer |
| Attack-surface / continuous monitoring | Various ASM vendors | Watch the external surface continuously | Security (external surface) | Breadth not depth, no remediation, no governed action, no UI/UX/a11y/journey view |
| Automated QA / E2E | Mabl, Testim, Playwright suites | UI test automation | UX / functional | Quality only, not security, not a11y, not remediation, no system-wide correlation |
| Accessibility checkers | axe, WAVE, Lighthouse, Pa11y | WCAG/a11y rule scanning | Accessibility | a11y only, separate budget, separate tool, no link to security or UX regressions |
| AI-governance point solutions (emerging) | AI guardrail / LLM-firewall / agent-observability startups | Filter or observe model/agent behavior | AI governance | Mostly model-/framework-specific, observe-or-filter rather than a deterministic allow/block/approve gate, rarely fail-closed-on-unauditable, not tied to the system being acted on |
| AI-native security agents (emerging) | AI-pentest and AI-remediation startups (2024 to 2026) | AI-driven pen test OR AI remediation | Security | Fast-moving and well-funded, but mostly SINGLE-capability, and few have a deterministic governance gate + tamper-evident audit. They are often the risk, not the control |

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

### 2a. The cross-layer buildout (what changed, and why it is the moat)

The five points above describe a governed security lifecycle. The buildout makes
the product see and reason about the WHOLE system, not just its security surface.
This is the part competitors are structurally unable to copy quickly, because
each of them is built around a single layer.

6. Complete cross-layer scanning, one tool, one system. We scan the frontend/UI
   (browser-driven capture of console errors, CSP violations, failed API calls,
   render state), the backend/APIs (route health, auth enforcement, server
   errors, latency), security passively AND with active authorized probing
   (broken access control / IDOR, auth bypass, injection, missing rate limits,
   information disclosure), accessibility (axe-core / WCAG), UX, and end-to-end
   user journeys (an agentic driver records ordered actions; server-side detectors
   classify friction). Most tools cover ONE of these. Shipped. Database and
   tenant-isolation checks are the lightest layer today: the detector and tests
   exist and the isolation probe runs, but it is less deep than the HTTP, browser,
   and pen-test layers and is being hardened. Calling it out honestly so we do not
   oversell it.
7. Cross-scan insights (the real moat). Because we see every layer on the SAME
   system and retain finding history, we correlate findings across layers and over
   time into higher-order insights no single-layer tool can produce: compound
   attack paths (a UI flaw plus an API gap plus a missing rate limit that combine
   into a real exploit), regressions (a resolved finding that reopened),
   systemic patterns (the same class recurring across many routes), and coverage
   blind spots (layers or routes we have not yet scanned). Shipped: a correlation
   engine over the full finding corpus, persisted insights, and a dashboard. A
   point tool cannot do this no matter how good it is, because it never has the
   other layers in view.
8. Provable, improving accuracy. We do not assert that we are accurate; we measure
   it and publish the number. A continuous self-benchmark scores our detection
   recall and precision against known-vulnerable targets with ground-truth labels,
   tracked over time so improvement (or regression) is visible. A competitive
   benchmark runs leading freely-available scanners (for example ZAP and Nuclei)
   against the SAME targets, normalizes their findings into our taxonomy honestly,
   and scores us head-to-head with the same scorer. Shipped, with the runs
   persisted and surfaced in a dashboard. This converts "trust us" into "here is
   the scoreboard," which is rare in this market and is itself a sales asset.
9. Safe AI enablement (the OGIAM gate). We govern ANY AI agent (any model, any
   framework) that acts on the client system: every action is checked against a
   deterministic policy and either allowed, blocked, or sent for human approval,
   and every decision is written to a tamper-evident, hash-chained, append-only
   ledger that is fail-closed-on-unauditable (in enforce mode, if the decision
   cannot be recorded, the action is treated as blocked). Bring your own agent or
   use ours. Shipped, with one honest phasing note: the gate currently defaults to
   "monitor" mode (decisions are computed and logged but not yet enforced by
   default); enforce mode exists and is tested. This is the inverse of the AI risk
   most of the market is selling INTO; we are the control over the agent, not
   another agent that is itself an unaudited risk.
10. Close the loop in-product. From finding to insight to a deterministic
    remediation recommendation to a review-gated pull request (itself gated by
    OGIAM and never auto-merged) to an in-product release gate that shows what is
    blocking production and offers a one-click promote when a change is verified
    ready. A client can find, fix, AND ship safely from one place. Shipped, with
    every stage instrumented (analytics) and security-relevant stages
    hash-chained (audit). No competitor closes find-to-production inside one
    governed tool.

## 3. Speed and time-to-deployment

- Traditional pen test: weeks (scoping, execution, write-up).
- OGIAM: onboard a target in minutes, baseline (map + scan + recommend + report)
  in hours to days, continuous thereafter. Active testing turns on the same day a
  scope is authorized.
- Time-to-first-value is measured in days, not weeks. That compression is itself
  a sellable differentiator and lowers the trial barrier for a first engagement.

## 3a. Why now

Three shifts make the cross-layer story land specifically in 2025 to 2026, not
earlier:

- AI agents are now acting on production systems, so "prove what the agent did and
  that it could not exceed its authority" has moved from a theoretical concern to
  an active buying question. The OGIAM gate answers exactly that question, and few
  point solutions can.
- Tool sprawl fatigue is real: buyers own a DAST tool, a SAST tool, an a11y
  checker, a QA suite, and now an AI-governance tool, each with its own console,
  its own findings, and no shared view. Consolidation pressure favors a single
  cross-layer system of record.
- Browser automation and deterministic agent orchestration matured enough that
  scanning the UI, journeys, and accessibility of a live system continuously, and
  correlating that with the security and API layers, is now buildable. It was not
  cleanly buildable as one product a few years ago. We built it.

## 4. Realistic value at scale

Markets for context (real and growing): application security and pen testing is a
multi-billion-dollar market (pen testing alone roughly $2B to $4B, broader AppSec
$10B+), DevSecOps tooling is growing double digits, and "AI agent governance and
security" is an emerging category forming now. We do not need a large share of
these to be a strong business.

Because the product is now multi-layer, it sits across several budgets that are
usually separate line items: application security (DAST/SAST/PTaaS), QA and test
automation, accessibility/compliance, and the forming AI-governance category. The
strategic implication is not "add up all those TAMs and claim them" (we will not
overclaim). It is twofold and more useful: (1) the addressable spend per account
is larger and stickier, because we can land on one budget and expand into the
adjacent ones without a new vendor relationship, and (2) consolidation is a
durable buying motivation in its own right, since replacing four or five
single-layer tools with one cross-layer system of record is a cost and
operational-overhead argument independent of any single feature. Concretely, an
account that starts as a security engagement can expand into a11y and QA coverage
and AI governance on the same platform, which raises net revenue retention well
above what a single-layer tool can reach.

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

## 4a. The strategic thesis (why this can upend the category)

"Upend the industry" is a strong claim, so here is the argument from capability,
not from hype. The industry is organized by LAYER: vendors, budgets, consoles, and
expertise are all siloed by frontend vs backend vs security vs accessibility vs
QA vs AI governance. That organization is the incumbents' structural weakness. A
DAST vendor cannot ship cross-layer insights, because it does not have the other
layers; an a11y checker cannot reason about a compound attack path; an
AI-governance tool that only watches the model has no idea whether the system the
agent acts on is even correct. None of them can become a system of record for "is
this software and its AI correct, secure, accessible, and improving" without
becoming a different, multi-layer product, which their architecture and
go-to-market are not built to do quickly.

We already built the multi-layer product. The defensibility compounds in two
ways. First, the cross-scan insight engine and the benchmarks get better the more
we scan, because correlation and ground-truth labeling improve with corpus and
history; a new entrant starts from zero history. Second, the OGIAM gate plus the
in-product close-the-loop make us the place where work actually happens, not just
a report that gets exported, which is far stickier than a scanner. That is the
basis for "upend": not a better DAST, but a category the buyer did not previously
have, sitting across budgets the incumbents address one at a time.

The honest counterweight is in section 5: this is an argument for a durable,
expandable, multi-budget business with a real moat. It is not a claim that the
outcome is guaranteed. Execution, the depth of the lighter layers, and enforcing
the gate in production are the open work.

## 5. Risks and what has to be true (honest)

- The AI-pentest / AI-remediation space is hot and well-funded; speed of execution
  matters. Our durable edge is the cross-layer scanning + cross-scan insights +
  governance + audit + provable accuracy + precision combination, plus warm
  clients, not any single feature.
- Breadth must not become shallowness. The cross-layer story is only a moat if each
  layer is credible. The database / tenant-isolation layer is the lightest today
  (detector + tests exist, depth is in progress) and must be hardened before we
  lean on "complete coverage" in a competitive sale. Honesty here protects the
  brand; an oversold layer that a prospect catches undoes the whole pitch.
- The OGIAM gate defaults to monitor mode. The enforce path is built and tested,
  but the value proposition of "every action allowed/blocked/approved, fail-closed"
  is fully realized only once enforce mode is the default in a live engagement.
  Until then, be precise: we govern in monitor today, enforce on request.
- Active pen testing carries liability; the signed rules-of-engagement + fail-closed
  harness mitigate it, but it must stay disciplined.
- Security sales cycles are long for cold logos; the warm-client beachhead is what
  makes year 1 realistic. The multi-budget expansion thesis depends on actually
  landing the adjacent budgets, which is a sales motion we still have to prove.
- Incumbents will add AI and may attempt cross-layer; our answer is the cross-scan
  insight engine and history, the published benchmarks, and the governed
  close-the-loop, which they are not structured to ship quickly.
- Multi-tenant + per-client credential model (GitHub App) must land before scaling
  beyond a handful of clients (see the deployment plan).

## 6. Verdict

The product has graduated from a unified, governed security-lifecycle agent into a
cross-layer system of record for whether a client's software and its AI are
correct, secure, accessible, and improving. The shipped capability backs the
positioning: complete multi-layer scanning, a cross-scan insight engine that no
single-layer tool can match, self and competitive benchmarks that publish the
accuracy number rather than assert it, a deterministic tamper-evident AI gate, and
an in-product loop from finding to fix to safe promotion. The honest caveats are
named (the database layer is the lightest, and the gate defaults to monitor mode);
neither undercuts the thesis, and both are in-progress, not vapor.

The realistic path is unchanged in shape and stronger in substance: land the warm
clients read-only, convert to continuous subscriptions, expand across the adjacent
budgets (a11y, QA, AI governance) on the same platform, graduate to authorized
active testing, and let case studies and the published benchmark compound into new
logos. A few million ARR within 2 to 3 years remains a grounded target; the
multi-layer, multi-budget surface and the cross-scan moat raise the ceiling above
what a single-layer security tool could reach.

## Related
- [ogiam-pricing-and-packaging.md](./ogiam-pricing-and-packaging.md)
- [ogiam-client-deployment-plan.md](./ogiam-client-deployment-plan.md)
