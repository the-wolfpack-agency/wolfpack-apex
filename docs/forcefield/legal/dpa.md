# Forcefield Data Processing Addendum (DRAFT TEMPLATE, NOT legal advice)

> DRAFT TEMPLATE for legal counsel, NOT a finalized or enforceable addendum. It
> structures the processor relationship; counsel must confirm it satisfies the
> specific regimes the customer falls under (GDPR/UK GDPR/CCPA) and complete the
> bracketed terms and any Standard Contractual Clauses. No em dashes.

Parties: the Customer (controller) and `[LEGAL ENTITY NAME]` (processor). This DPA
forms part of the Terms of Service.

## 1. Roles
The Customer is the controller of the request metadata relating to its site's
visitors/clients. We are the processor, acting on the Customer's documented
instructions (configuring and using the service is the instruction).

## 2. Subject matter and duration
Subject matter: detection, recording, and optional enforcement of automated
requests to the Customer's site(s). Duration: the subscription term plus the
retention window below.

## 3. Nature and purpose of processing
As described in `security-and-data-handling.md`: classify and record request
metadata, serve the dashboard, alert on hostile signals, and improve the shared
ruleset using aggregated, de-identified data only.

## 4. Categories of data and data subjects
- Data: request metadata (path, method, User-Agent, header names, coarse country,
  derived operator fingerprint) and classification counts.
- Explicitly NOT processed: page content, header values, cookies, form data,
  precise IP in the event record, or direct identifiers (see the Security
  statement).
- Data subjects: the automated and human clients that make requests to the
  Customer's site.

## 5. Subprocessors
We use the subprocessors in `subprocessors.md`. `[DECISION: notice period, e.g.
30 days, and the Customer's right to object before we add one that processes
personal data.]`

## 6. Security measures
Hashed tokens at rest, tenant-scoped access backed by a build-failing guardrail,
HTTPS transport, least-data-by-design collection. `[Counsel: Annex of technical
and organizational measures; reference the honestly-pending items, e.g. DB-level
RLS, so the Annex is accurate.]`

## 7. International transfers
`[Counsel: SCCs or other mechanism, tied to the confirmed subprocessor regions.]`

## 8. Data subject requests and assistance
We assist the Customer in responding to data-subject requests to the extent
Forcefield holds relevant data (which, by design, is minimal metadata). `[Counsel
to detail the mechanism and timelines.]`

## 9. Breach notification
We notify the Customer without undue delay after becoming aware of a personal-data
breach affecting their data. `[Counsel: timing, content, contact.]`

## 10. Retention and deletion
`[DECISION: retention window, matching the Privacy Policy and Security statement.]`
On termination we deactivate the tenant and delete or return the data per the
window, except aggregated de-identified statistics.

## 11. Audits
`[Counsel: audit rights, scope, frequency, and how they are satisfied, e.g. via
documentation and the readiness/security posture rather than site visits.]`

## 12. Liability and order of precedence
`[Counsel: how this DPA interacts with the ToS liability cap and precedence.]`
