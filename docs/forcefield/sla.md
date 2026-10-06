# Forcefield Service Level Agreement (DRAFT, internal, confidential)

Status: DRAFT. Targets are proposals marked `[COMMIT]`; do not publish or contract
on them until you commit the numbers and a public status endpoint exists to make
them credible. No em dashes.

## 1. Scope

This SLA covers the Forcefield central control plane: the observe/decide engine,
the ingest path, and the client dashboard, hosted on our infrastructure. It does
NOT cover the customer's own site, their edge platform (their Cloudflare/Vercel
account), or outages at a subprocessor that are outside our control (see
`subprocessors.md`).

## 2. The fail-open guarantee (the most important line)

Forcefield is designed so that if the central engine is slow, erroring, or
unreachable, the customer's site keeps serving. The edge shim fails open: on any
error, timeout, or bad response it returns "allow" and the request proceeds. This
means a Forcefield outage degrades protection, never the customer's availability.

This is a design guarantee, verifiable in the shim code, and it is the backbone of
every other commitment here: we can be conservative about uptime precisely because
our failure mode does not take the customer down.

## 3. Availability target `[COMMIT]`

- Control-plane monthly uptime target: `[COMMIT]` (proposal: 99.9% for the engine
  + ingest; the dashboard a notch lower is acceptable since it is read-only).
- Measurement: by a public status endpoint and external checks (NOT built yet;
  this is a prerequisite before the SLA is credible, tracked in the README).
- Exclusions: scheduled maintenance (announced), subprocessor outages, the
  customer's own edge/platform, force majeure.

## 4. Support response targets `[COMMIT]`

Proposal (align to the pricing tiers):

| Tier | Channel | First-response target `[COMMIT]` |
|---|---|---|
| Starter | Email | 2 business days |
| Growth | Email, priority queue | 1 business day |
| Scale / Enterprise | Email + named contact | 4 business hours for a severity-1 |

Severity-1 = the engine is down or wrongly blocking legitimate traffic at scale
(note: wrongly blocking is bounded by fail-open and by enforce mode being
client-controlled, so a true sev-1 block event is rare by design).

## 5. Incident handling

- During a reported incident, the customer's fair-use allowance is not counted
  (see pricing) and enforcement can be dialed back to watch-only on request.
- Alerting on high-confidence hostile signals (trap trips, payload attacks) is a
  product feature, not only an SLA term.

## 6. Remedies `[COMMIT]`

Proposal: service credits for missed monthly uptime (e.g. 10% of the monthly fee
per 0.1% below target, capped at one month). Credits are the sole remedy. Counsel
to finalize the credit schedule and the liability interaction with the ToS.

## 7. Open items before this is contractable

- Commit the uptime and response numbers (`[COMMIT]`).
- Stand up a public status endpoint + external monitoring (prerequisite).
- Counsel: credit schedule, remedy-exclusivity, interaction with ToS liability.
