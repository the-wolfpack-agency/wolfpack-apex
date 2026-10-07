# Trust-Center Kit (DRAFT, internal, strategy)

## What it is
A reviewer-facing trust center + auditor evidence pack that reads one canonical,
self-verified control model, so the page can never disagree with the code. Already
built twice (ford and apex); the opportunity is to make it a reusable, white-label
component other teams drop into their own app.

## Who buys it
SaaS teams who keep getting security questionnaires and want a living trust center
instead of a stale PDF; and it is the natural front-end of the Compliance &
Assurance product.

## What we ALREADY have
- apex `/admin/trust-center` - honest section summaries (security, data, AI
  governance, subprocessors, self-testing, the controls-vs-stamp philosophy,
  certification status) each deep-linked to live evidence.
- ford `/app/trust-center` + `/app/evidence` + `/app/evidence/readiness/[framework]`
  - the same pattern with an auditor evidence table + per-framework readiness,
  prints cleanly to PDF, backed by `src/config/compliance-controls.ts` + the
  readiness engine.
- The markdown-to-in-app docs viewer (apex) for the surrounding policy docs.

## Product surface to add
- Extract the shared pattern into a drop-in kit (component + a control-model
  adapter) so a customer wires their own evidence source.
- A shareable, access-controlled public trust-center link + questionnaire
  auto-answer (the ford assistant already answers reviewer questions from a
  deterministic responder, a strong thing to generalize).

## Honest gap to market
It exists twice but is not yet a packaged, reusable kit; that extraction + the
shareable external link are the build. Strongest as a feature of Compliance &
Assurance rather than a standalone SKU. ~65%.

## Positioning + pricing hook
"A trust center that is always true because it reads your running system." Bundle
with Compliance & Assurance; or a low-tier standalone to seed the funnel.
