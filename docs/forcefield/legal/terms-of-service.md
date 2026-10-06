# Forcefield Terms of Service (DRAFT TEMPLATE, NOT legal advice)

> DRAFT TEMPLATE. This is a structured starting point for legal counsel, NOT a
> finalized or enforceable agreement. Do not publish or contract on it until
> counsel reviews and completes it. Bracketed `[...]` items are decisions for the
> business or counsel. No em dashes.

Entity: `[LEGAL ENTITY NAME]` ("we", "us"). Service: Forcefield agent-defense
service. Customer: the entity that subscribes.

## 1. The service
We provide a hosted service that classifies and records automated-client requests
to the customer's registered site(s) and returns enforcement decisions, with a
dashboard. Described in our documentation; improved continuously.

## 2. Accounts and access
The customer registers one or more sites and receives a per-site ingest token. The
customer is responsible for keeping tokens confidential and for all use under
their tokens. We may suspend a token on suspected compromise or AUP breach.

## 3. Acceptable use
Use is subject to the Acceptable Use Policy (`acceptable-use-policy.md`),
incorporated by reference. Key point: the customer may only protect sites they own
or control, and may not use the service to attack or disrupt others.

## 4. Subscription, fees, term
Fees, tiers, and the fair-use model are per the current plan and the pricing
documentation. Term, renewal, and cancellation per `[licensing terms]`. Taxes
`[...]`. Fee changes on `[NOTICE PERIOD]` notice, not within a paid term.

## 5. Fail-open; no availability guarantee beyond the SLA
The service is designed to fail open: if our engine is unreachable or errors, the
customer's site continues to serve and the request is allowed. Except as expressly
stated in the SLA, the service is provided "as is" and we do not warrant that it
will detect or block every automated client.

## 6. Customer data
We process request metadata and classification counts as described in the Privacy
Policy and the DPA, which govern personal-data processing. The customer owns their
site traffic; we claim no ownership of it. We may use aggregated, de-identified
statistics to operate and improve the service and the shared ruleset.

## 7. Intellectual property
We retain all rights in the engine, rulesets, shim, and dashboard. The customer
receives only the subscription license in `[licensing terms]`. Feedback may be
used without restriction.

## 8. Confidentiality
Each party protects the other's non-public information disclosed under these
terms. `[Standard mutual confidentiality, counsel to complete.]`

## 9. Warranties; disclaimers
`[Counsel: warranty disclaimers, "as is", no guarantee of complete protection,
consistent with the fail-open design and SLA.]`

## 10. Limitation of liability
`[Counsel: liability cap (e.g. fees paid in the prior 12 months), exclusion of
indirect/consequential damages, interaction with SLA credits as sole remedy.]`

## 11. Indemnification
`[Counsel: customer indemnity for misuse / protecting sites they do not own;
our indemnity scope if any.]`

## 12. Suspension and termination
We may suspend for AUP breach, non-payment, or security risk. On termination the
token is deactivated (the edge fails open) and data is handled per the DPA.

## 13. Changes to the terms
`[Notice mechanism and effective date; material changes with notice.]`

## 14. Governing law; disputes
`[GOVERNING LAW / JURISDICTION]`. `[Dispute resolution / arbitration choice.]`

## 15. Miscellaneous
Entire agreement, assignment, severability, force majeure, notices. `[Counsel.]`
