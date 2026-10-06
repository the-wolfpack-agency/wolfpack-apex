# Forcefield Subprocessors (DRAFT, internal, confidential)

Status: DRAFT, fact-checked against the stack on 2026-10-06. This list backs the
DPA; keep it current, and publish a customer-facing version only once confirmed.
Regions marked `[CONFIRM]` must be verified against the actual account settings.
No em dashes.

## What a subprocessor is here

A third party we use to deliver Forcefield that may process customer data (the
request metadata defined in `security-and-data-handling.md`). The customer's own
edge platform is NOT our subprocessor (it is their infrastructure); it is listed
separately for clarity.

## Our subprocessors

| Subprocessor | Purpose | Data it sees | Region `[CONFIRM]` |
|---|---|---|---|
| Vercel | Hosting the central engine, ingest, dashboard (`wolfpack-instinct`) | Request metadata in transit; serves the API | `[CONFIRM]` |
| Neon | Postgres: tenant registry, signup requests, `site_analytics_events` | Stored request metadata + classification counts, hashed tokens | `[CONFIRM]` (e.g. us-east) |
| Microsoft Azure OpenAI | OPTIONAL: the operator AI triage summary only | Only the submitted signup fields (name, work email, site, note); never live traffic | `[CONFIRM]` |

Notes:
- Azure OpenAI is engaged ONLY if the AI summary is configured and used by an
  operator. If unconfigured, no data goes to it. The model router enforces the
  per-workspace AI budget and region policy.
- No analytics/marketing third parties receive Forcefield customer data.
- No MCP servers are used (house policy).

## Customer-controlled infrastructure (not our subprocessors)

| Component | Who controls it | Note |
|---|---|---|
| Cloudflare Worker adapter | The customer (their CF account) | The shim runs at the customer's edge and forwards signals to our engine. If we host the Worker for a managed-onboarding customer, Cloudflare becomes our subprocessor for that customer and must be added to their DPA. |
| Next.js middleware adapter | The customer (their app) | Runs in the customer's own deployment. |

## Change process

- `[DECISION]` subprocessor-change notice period (proposal: 30 days notice before
  adding a subprocessor that processes customer data, with a right to object).
- Counsel to confirm the notice/objection terms in the DPA match this.
