# Compliance & Assurance (DRAFT, internal, strategy)

## What it is
Continuous, evidence-derived audit readiness plus a reviewer-facing trust center.
Instead of a consultant filling a spreadsheet once a year, it reads the live system
on every change and tells you, per control, covered / partial / gap, with the
evidence attached, and assembles the auditor pack. The external audit becomes a
last-mile stamp on machine-generated evidence.

## Who buys it
Any B2B SaaS chasing SOC 2 / ISO 27001 / ISO 42001 to unblock enterprise deals;
AI companies that now also face ISO 42001 / NIST AI RMF / the EU AI Act. The buyer
is a founder/CTO or a security lead who is losing deals to a missing cert.

## What we ALREADY have
- `src/lib/compliance/` - the engine: `frameworks.ts` (SOC 2, ISO 42001, NIST AI
  RMF, EU AI Act control sets), `evidence.ts` (collects LIVE signals: audit chain,
  gate decisions, red-team runs, enforcement posture, crypto), `orchestrate.ts`
  (`runComplianceReport`), `export.ts`. Status derived from measured evidence,
  never asserted.
- In-app: `/admin/compliance` + `/admin/compliance-scan` + report export.
- `src/lib/readiness/` + `npm run readiness` - the production-readiness board
  (ready/partial/gap from real repo facts) with a ratchet so scores only climb.
- `/admin/trust-center` (apex) and `/app/trust-center` + `/app/evidence` (ford) -
  the reviewer hand-off and the auditor evidence pack, already built.
- The markdown-to-in-app docs viewer pattern (apex `/admin/forcefield/docs`).

## Product surface to add
- A multi-tenant version (today it assesses our own workspace) so a customer
  points it at THEIR system / repo and gets their own report.
- Connectors to pull evidence from a customer's stack (their CI, cloud, identity).
- A shareable, access-controlled trust-center link (public or gated per reviewer).
- Scheduled re-assessment + drift alerts.

## Honest gap to market
Multi-tenant evidence collection and the customer-facing trust-center link are the
real build. The frameworks + the evidence-derivation + the export + the readiness
ratchet exist. Needs the same non-fakeable externals as any assurance product
(pen-test signature, the customer's own legal). ~70% built.

## Positioning + pricing hook
"Compliance you can prove on any commit, not a binder you refresh once a year."
Priced per monitored system or per framework, services-assisted for the first
audit. Anchors below a vCISO/consultant engagement, above a static policy
generator.
