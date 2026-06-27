# OGIAM Client Deployment Plan (internal)

Status: working plan. Goal: land the QA / security / automation offering with
existing and adjacent clients to build credibility and get more tools running in
production. Sequence by RISK, lead with READ-ONLY, gate active testing behind
written authorization.

## Why existing clients first

We already operate several client systems. They are the fastest path to two
things at once: real credibility (findings on real systems, governed and
audited) and more tools in production. Each onboarded client is a new production
deployment of the platform.

## The capability safety order

- READ-ONLY first, everywhere: security + quality scans, the system map, and the
  report. Zero risk to a client system.
- ACTIVE testing (pen test) only after a signed rules-of-engagement and an issued
  scope token. The harness is fail-closed: nothing actively probes until an admin
  issues a time-boxed, host-scoped, budgeted, killable scope.
- Every engagement is audit-chained, so there is a defensible per-client record.

## Phases

### Phase A: internal proof (now)
Onboard our own deployed apps (wolfpack-auto, beyond) as the first targets via
the onboarding flow. Run baselines, generate the reports, and keep them as
internal reference case studies. Zero risk, already proven (the live
info-disclosure probe against wolfpack-auto passed and reconfirmed an earlier
fix held).

### Phase B: 1 to 2 friendly existing clients (design partners)
Pick clients with a strong relationship and low blast radius. Offer a
complimentary or discounted Baseline Engagement, READ-ONLY only (scan + system
map + report). The report is the credibility artifact: real findings on their
real system, governed and audited. No active pen test in this phase.

### Phase C: graduate to active testing, with authorization
For partners who want it, run the active pen-test suite (broken access control /
IDOR, authentication bypass, missing rate limits, information disclosure,
injection) ONLY after a signed rules-of-engagement and an issued scope token.
This is where Enterprise-tier value lands.

### Phase D: land-and-expand + case studies
Convert design partners to continuous subscriptions (Essentials then Pro), add
remediation retainers, and publish anonymized case studies (for example:
"confirmed N critical access-control issues on a live system, fixes opened as
review-gated PRs, posture tracked continuously"). Use these to drive new sales.

## Guardrails

- Never run an active probe without written authorization; the scope token
  enforces this technically and the kill switch stops any run instantly.
- Start read-only on every new client; earn the active-testing step.
- Keep client credentials per-workspace (see the Phase 3 credential model: client
  repo access via a GitHub App install is recommended over a shared token).
- Every action is recorded in the tamper-evident audit trail for a defensible
  record per engagement.

## Sales motion mapped to the offering

1. Baseline Engagement (read-only) lands the relationship and proves value fast.
2. Essentials subscription keeps the posture current (continuous scans + report).
3. Pro adds automation mapping + recommendations + remediation PRs.
4. Enterprise adds active, authorized pen testing + SLAs + multiple systems.

## Open decisions (need owner sign-off)

1. Which 1 to 2 existing clients are the first design partners.
2. Free vs discounted Baseline Engagement for design partners.
3. The rules-of-engagement template and who signs it before active testing.
4. The credential model for client repos (GitHub App vs PAT).

## Related

See [ogiam-pricing-and-packaging.md](./ogiam-pricing-and-packaging.md) for the
pricing model these tiers reference.
