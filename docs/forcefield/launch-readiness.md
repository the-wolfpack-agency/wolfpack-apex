# Forcefield Launch Readiness and Compliance Scope (DRAFT, internal)

Status: DRAFT, internal. States honestly what Forcefield needs before production and
what it does NOT. No em dashes.

## The key distinction: Forcefield's core is deterministic, not probabilistic

Forcefield's detection and enforcement core is **deterministic**: it classifies
automated clients by behavior, trips traps, and applies rules. It is NOT a
probabilistic / LLM system. That matters for compliance scope:

- The AI-governance frameworks (ISO/IEC 42001, NIST AI RMF, the EU AI Act
  obligations) exist to govern probabilistic AI that makes or influences decisions
  about people. Forcefield's core makes deterministic, rule-based traffic
  decisions, so those AI-specific checkpoints do NOT gate the core product.
- The general SaaS security controls DO apply and are in place: tenant isolation,
  tokens hashed at rest, a tamper-evident audit trail, a strict CSP and security
  headers, durable rate limiting, and fail-open so a Forcefield outage never takes
  a customer site down.

## The two AI touchpoints (separable, gateable)

Only two optional surfaces touch a model, and both route through the governed
model router (per-workspace budget, version attribution, audit):

1. `agent-intelligence` (enrichment of agent signals).
2. The operator signup risk summary (a review aid).

Neither is in the deterministic request path. For a lean launch they are gated
OFF, which removes AI-governance from the critical path entirely. Turn them on
when the AI-governance track is complete.

## What ships WITHOUT the full pre-AI compliance / certs

- **First-party / our own sites** (ogiam.com and our properties): run the
  deterministic Forcefield now. Our data, no customer DPA, zero external
  compliance. Full dogfood.
- **Design-partner / beta clients** under a simple beta agreement (not the full
  ToS/DPA/SOC2), AI touchpoints gated off: the deterministic product with the
  general SaaS controls we already prove in CI. Framed clearly as beta (no cert,
  SLA as stated).
- **Marketing + waitlist signup**: now.

## What DOES require the full track

- Paid GA with the AI touchpoints enabled (AI-governance track).

## Billing status (both paths, one model)

The licensing/subscription model is built and serves BOTH paths:
- MANUAL (an existing client we license directly): the operator sets a plan on the
  tenants page; no Stripe needed. Live now.
- STRIPE SaaS: the signature-verified webhook keeps subscription state in sync and
  is INERT until STRIPE_WEBHOOK_SECRET is set (ships safe, goes live when the secret
  is configured). The remaining creds-gated piece is CHECKOUT (creating the
  subscription), which needs the Stripe API key; the price numbers are still a
  business `[DECISION]`.
- Enterprise / regulated clients that contractually require SOC 2 / DPA /
  certification. Run that track in parallel; it does not block the deterministic
  beta.

## What we test ourselves vs the one external step

Run continuously / on demand (no third party, no cost):

- `npm run forcefield:selftest` - the live auth-boundary / info-disclosure /
  input-validation probe against the deployed control plane. Read-only and safe;
  exits non-zero on any wrong boundary, so it can gate a release. Last run: all
  boundary checks passed (token + admin endpoints refuse unauthenticated callers
  with no data leak; public endpoints serve; empty signup body is rejected).
- CI on every change: CodeQL, the precision security self-scan, security
  governance + hygiene gates, a browser platform scan, an accessibility + UX
  sweep, and the end-to-end reality checks.
- `npm run readiness` - the production-readiness board (Forcefield graded from
  real repo facts).
- `/admin/compliance` - the live compliance report (SOC 2 / ISO 42001 / NIST AI
  RMF / EU AI Act coverage, covered/partial/gap from measured evidence).
- The deep scoped pentest engagement (`src/lib/platform-scan/pentest`) against the
  first-party target, when a scope is issued.

The one thing we cannot self-issue: an **independent third-party penetration test
and external certification**. That independence is the point. The aim is to make
the substance so complete that the external engagement is a last-mile stamp on
machine-generated evidence, engaged when a client requires it. We never present
alignment as certification.
