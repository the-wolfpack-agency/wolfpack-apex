# Forcefield pre-mortem: work backwards from failure (DRAFT, internal)

Status: DRAFT, internal. We imagine Forcefield has failed in market and enumerate
WHY, across every dimension, then map each to its control and honest status. The
point is to close what we can before launch and to never overclaim what we cannot.
Status legend: DONE (built + verified) / PARTIAL (built, gap noted) / GAP (not built)
/ EXTERNAL (needs a human, creds, or a third party). No em dashes.

## A. Availability and safety (the catastrophic ones)

| Failure | Blast radius | Control | Status |
|---|---|---|---|
| Forcefield takes a customer's site DOWN | Catastrophic, instant churn | Fail-open shim: any engine error/timeout/bad response returns allow; the site serves. | DONE + now a build-failing guard test (this PR) |
| Forcefield BLOCKS legitimate traffic (false positive in enforce) | Catastrophic trust loss | Watch-first by default (enforce off); the dashboard shows what WOULD be blocked before you enable it; enforce is client-controlled per site. | DONE (watch-first is the de-facto dry-run) |
| Central engine outage | Protection degrades, site unaffected (fail-open) | Status endpoint + SLA fail-open guarantee. | PARTIAL (needs an external uptime monitor for a credible SLA) |
| Enforce does not actually block on a live edge | We sold protection that is not there (the Sept-21 class) | Decision path verified in code (observe returns block, adapter applies); watch-first framing never claims blocking the client has not enabled. | PARTIAL: live end-to-end block must be verified on a real deployed shim in enforce mode. Do NOT market "blocks" beyond "enforcement you enable + can verify". |

## B. Correctness and trust

| Failure | Blast radius | Control | Status |
|---|---|---|---|
| Dashboard shows zero for live traffic | Client wires the shim, sees nothing, churns | The ingest path attributes `forcefield_tenant_id` from the token and stamps the site; my-stats/dashboard read that real stream (the old demo-table gap is closed). | DONE (verify on a real wired shim as part of onboarding) |
| "Connected" signal is wrong | Client thinks it works when it does not | Connection = any event ever arrived for the tenant; the dashboard re-check is on demand. | PARTIAL (add a "recent traffic" window so a long-dead shim reads disconnected) |
| Metrics inflated or fabricated | Trust destroyed | Counts-only, honest n/a-vs-zero, hostile-vs-flagged separation; numbers derived from real events. | DONE |

## C. Security

| Failure | Blast radius | Control | Status |
|---|---|---|---|
| A client's ingest token is leaked | Flooded ingest / someone reads that tenant's counts | Tokens hashed at rest; per-IP durable rate limit; tenant-scoped reads. BUT no way to kill a leaked token. | GAP -> revoke + rotate (this PR) |
| One tenant reads another's data | Isolation breach | Token-resolved tenant scoping on every read + the build-failing tenant-scoping guardrail. | PARTIAL (DB-level RLS on the attribution column is the defense-in-depth goal) |
| Public endpoints abused (DoS/cost) | Cost + noise | public-stats edge-cached; signup + ingest durably rate-limited; status short-cached. | DONE |
| AI creeps into the decision path | Non-determinism + compliance scope | Build-failing AI-containment guardrail on the cores. | DONE |

## D. Commercial and adoption

| Failure | Blast radius | Control | Status |
|---|---|---|---|
| Onboarding too hard | Client never goes live, churns | Self-serve setup on the dashboard (copy-paste config + Connected check). | DONE |
| No one finds signup | No funnel | Marketing CTAs drive to the gated signup. | DONE |
| Cannot charge | Not a business | Stripe billing. | EXTERNAL (Stripe creds + the pricing numbers) |
| Token handoff is manual | Friction, not true self-serve | Operator hands off today; claim-link email is the self-serve finish. | GAP (needs MS Graph creds; claim-link design chosen) |

## E. Legal and compliance

| Failure | Blast radius | Control | Status |
|---|---|---|---|
| Processing visitor data without a basis | Legal exposure | Collects request METADATA only (no page content/PII); DPA + Privacy drafted. | PARTIAL (counsel must finalize) |
| Regulated-vertical / enterprise customer | Deal blocked | Deterministic core needs general SaaS certs, not AI certs; compliance evidence pack + Trust Center live. | PARTIAL (SOC 2 / pen-test signature are EXTERNAL) |

## F. Operational

| Failure | Blast radius | Control | Status |
|---|---|---|---|
| An attack/outage goes unnoticed | Silent failure | Hostile-signal alerting to the security owner (cron-driven, dedup'd). | DONE |
| No incident/status comms | SLA not credible | Status endpoint built; public status page + monitor pending. | PARTIAL |
| Self-tests not run before paid audit | Overclaim risk | `npm run forcefield:selftest` (live boundary probe, all pass) + CI scans + readiness board + the compliance report. | DONE |

## The closable-now list (ranked), and what is not closable by us

Closable now (engineering):
1. Token revoke + rotate (kill a leaked credential). THIS PR.
2. Fail-open guard test (lock the no-take-down property). THIS PR.
3. Connection "recent traffic" window (honest connected/stale signal).
4. DB-level RLS on `forcefield_tenant_id` (defense-in-depth; careful on a hot shared table).

Not closable by us (surface honestly, never fake):
- Live end-to-end enforce verification on a real deployed shim (deploy-time).
- Stripe billing + final pricing numbers (creds + business).
- Claim-link onboarding email (MS Graph creds).
- SOC 2 / ISO cert + independent pen-test signature + final legal (external, by design).
- An external uptime monitor behind the SLA.

## The honest market-ready verdict

The deterministic product (see, sort, watch, dashboard, signup, onboarding) is
market-ready for a first-party + design-partner BETA now, on the controls above,
with watch-first framing that never claims a block the client has not enabled and
verified. A PAID, GA, "we block attacks" launch is gated on: the live enforce
verification, Stripe, and the external cert/pen-test signature. We market exactly
what is true and no more.
