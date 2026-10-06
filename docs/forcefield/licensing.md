# Forcefield Licensing and Subscription Terms (DRAFT, internal, confidential)

Status: DRAFT commercial outline. The license grant and restrictions here are the
business intent; the enforceable wording lives in the Terms of Service
(`legal/terms-of-service.md`) and must be finalized by counsel. No em dashes.

## 1. What is licensed

A non-exclusive, non-transferable, revocable subscription to use the Forcefield
service for the protected site(s) named on the customer's active plan, for the
subscription term, subject to the plan's tier and fair-use allowance.

The subscription licenses the SERVICE (the hosted engine + dashboard + the right
to run the edge shim against the customer's own site). It is not a sale of
software and conveys no ownership of the engine, the rulesets, or the shim code.

## 2. Unit of licensing: the protected site

- A license is granted per site/domain the customer registers (the `siteLabel`
  on the tenant). Subdomains of a registered apex are covered unless listed as
  separate sites.
- The per-tenant ingest token is the credential that binds a deployment to a
  license. Sharing or reusing a token outside the licensed site(s) is a breach
  (and is technically scoped: stats and attribution are per tenant).

## 3. Term, renewal, cancellation

- Term: monthly or annual per the plan. `[DECISION]` on default.
- Auto-renewal: `[DECISION]` (renew unless cancelled N days prior, vs opt-in).
- Cancellation: self-serve, effective at the end of the paid period. On
  cancellation the token is deactivated (resolveTenantByToken already returns
  null for a non-active tenant, so the edge path falls back to the shared path and
  never errors the client's site: fail-open on offboarding too).
- Refunds: `[DECISION]`. Stub: no partial-month refunds on monthly; pro-rata or
  no-refund on annual, counsel to confirm consumer-law constraints.

## 4. Restrictions (what the license does not permit)

- No reselling, sublicensing, or offering Forcefield as a service to third
  parties without a separate reseller agreement.
- No using the service to protect a site the customer does not own or control
  (tie to the target-ownership posture; see Acceptable Use Policy).
- No reverse engineering the engine or rulesets, no attempting to extract other
  tenants' data, no circumventing the fair-use cap through token sharing.
- No using Forcefield to attack, probe, or disrupt others (AUP).

## 5. Data and portability

- The customer owns their own site's traffic. Forcefield stores only request
  metadata and classification counts (see `security-and-data-handling.md`), never
  page content.
- On request or on termination, the customer's tenant stats can be exported
  (counts-only, the same shape the dashboard and my-stats endpoint already serve)
  and the tenant record deactivated. `[DECISION]` on a retention/erasure window
  (default proposal: deactivate immediately, purge raw events after the standard
  retention window in the DPA).

## 6. Changes to the service

- We may improve detection, rulesets, and the engine continuously (that uniform,
  one-deploy-protects-all-sites property is the product). Material adverse changes
  to a committed SLA or to pricing follow the notice terms in the ToS.

## 7. Open decisions

- Default term + auto-renewal posture (business).
- Refund/cancellation policy (business + consumer-law, counsel).
- Reseller/white-label path: separate agreement, out of scope for self-serve v1.
