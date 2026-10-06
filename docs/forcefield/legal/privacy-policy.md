# Forcefield Privacy Policy (DRAFT TEMPLATE, NOT legal advice)

> DRAFT TEMPLATE for legal counsel, NOT a finalized or enforceable notice. The
> factual claims come from `security-and-data-handling.md` (fact-checked vs code);
> counsel completes the legal framing, regimes, and rights. No em dashes.

Controller/entity: `[LEGAL ENTITY NAME]`. Contact: `[PRIVACY CONTACT]`.

## 1. Scope
This notice covers the Forcefield service. For personal data we process on behalf
of a customer (their site's request metadata), the customer is the controller and
we are the processor; the DPA governs that processing.

## 2. What we collect
Request METADATA and classifications only, as detailed in our Security and Data
Handling statement:
- path, HTTP method, User-Agent, header NAMES only, coarse country, a derived
  operator fingerprint, and the classification outcome/counts.

We do NOT collect page content, header values, cookies, authorization headers,
form field values, request bodies, precise IP addresses in the event record, or
visitor identity. We design to avoid personal data; coarse country is the only
location signal.

## 3. Why we process it
To detect, record, and optionally block automated/agent traffic to the customer's
site, to show the customer their dashboard, to alert on hostile signals, and to
improve the shared detection ruleset using aggregated, de-identified statistics.

## 4. Legal bases `[counsel per regime]`
`[GDPR/UK GDPR legal basis: legitimate interests in network/site security; the
customer's basis for its own end-users. CCPA treatment. Counsel to complete.]`

## 5. The optional AI triage summary
If an operator uses the AI risk summary during signup review, the submitted signup
fields (name, work email, site, note) are sent to our model provider to generate a
short triage note. This is operator-facing, off unless configured, and does not
use the customer's live site traffic.

## 6. Sharing / subprocessors
We share data only with the subprocessors listed in `subprocessors.md` (hosting,
database, and, for the AI summary only, the model provider), under contract. We do
not sell personal data and use no advertising third parties.

## 7. Retention
`[DECISION: state the window from security-and-data-handling.md, e.g. raw events
90 days, aggregates longer.]`

## 8. Security
Tokens stored hashed; tenant-scoped access; transport over HTTPS. See the Security
and Data Handling statement for specifics and honestly-stated pending hardening.

## 9. Rights `[counsel per regime]`
`[Access, deletion, objection, etc., and how an end-user exercises them through
the customer-controller vs us-processor split.]`

## 10. International transfers
`[Counsel: transfer mechanism if data crosses regions, tied to subprocessor
regions once confirmed.]`

## 11. Changes and contact
`[How changes are notified; privacy contact; supervisory-authority info per
regime.]`
