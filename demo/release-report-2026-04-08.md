# Instinct Release Report — 2026-04-08

**HEAD:** `663ed9f` · **Tests:** 735/735 across 37 suites · **Type errors:** 0 · **20 commits today**

## Headline

Two new sidebar entries shipped to production:

- **Sites** — drag-and-drop client site builder for Max + Meghan (drop a brief, get a hosted client site)
- **HR** (renamed from People) — Alicia's workspace with Benefits parser, smart-router Documents store, and the closed-loop recommendation engine

Both features are fully closed-loop instrumented (39 new analytics events total). HR is fully self-contained — zero external API calls, demo-safe by design. Sites requires two Vercel env vars to actually call GitHub (see handoff doc).

## Stats

- **Tests:** 705 → 735 (+30 net, including the dashboard render smoke + HR documents UI E2E + Benefits regression locks)
- **Test suites:** 33 → 37
- **New lib files:** 6 (`sites.ts`, `github-client.ts`, `benefits.ts`, `hr-documents.ts`, `people.ts`, `client-auth.ts`)
- **New API routes:** 11 (sites: 5, people: 6)
- **New migrations:** 3 (009_sites, 010_people, 011_hr_documents)
- **New analytics event types:** 39
- **New roles:** 1 (`hr` at level 4)

## Production-incident bug count today

11 production bugs caught and fixed in real time, every one now locked behind a regression test:

1. Sites: `previewUrl` undefined coercion (Vercel typecheck)
2. Sites: dropzone above form layout confusion
3. Sites: slug `/test` rejected with no clear feedback
4. Sites: file input single-click (browser detached-input issue)
5. Sites: multipart Content-Type leak from authHeaders()
6. Benefits: pdf-parse DOMMatrix crash on serverless (→ pdf2json → unpdf)
7. Benefits: pdf2json hanging in production
8. Benefits: parser layout mismatch with unpdf's multi-line cell output
9. Benefits: PG NUMERIC string `.toFixed()` crash → "This page couldn't load"
10. Benefits: missing `runners_up` undefined access
11. Benefits: Vercel file tracer dropping unpdf from function bundle

Each one revealed a category of test that should exist. All four layers (unit, API, integration, UI E2E) now have working examples for the feature areas they cover, and the dashboard-pages-render smoke test catches the entire class of "page crashes on first render" bugs across all 15 dashboard pages.

## Architecture wins

1. **Smart-router pattern for the Documents tab** — single drop zone, deterministic classifier, files appear in the right specialized tab via category filter (no duplication, one source of truth). When a doc classifies as `benefits_renewal`, the smart router ALSO runs the benefits parser pipeline so the Benefits tab has its plans + recommendation. Same pattern can extend to future Payroll/Compliance tabs.

2. **Forward-compatible apex→instinct rename** — login writes both `instinct_token` and `apex_token` localStorage keys; `client-auth.ts` reads either; `INSTINCT_JWT_SECRET` falls back to `APEX_JWT_SECRET`. Existing pages keep working unchanged. New pages use the canonical helper. Zero risk migration.

3. **Closed loop on every recommendation** — `hr.benefit_recommendation_accepted` and `_rejected` events let the brain measure which scoring rules produce useful suggestions over time. Same pattern for `hr.document_recategorized` (classifier accuracy) and `site.deploy_succeeded` / `_failed` (deploy reliability).

4. **Brief schema mirrors scaffolder one-to-one** — anything Sites stores is guaranteed to render in the wolfpack-site-template scaffolder. Strict server-side validation enforces the contract.

## What didn't ship (deferred to 2026-04-09+)

- Onboarding sub-tab on HR (was in People plan, deferred for v1 value density)
- Field extraction per HR doc type (W-4 fields, I-9 fields, expiration tracking)
- HR Documents → employee linking dropdown UI (schema supports it, no UI yet)
- Aetna/Cigna/UHC benefits parser variants (architecture supports custom extractors)
- Apex→Instinct page-level rename completion (sites/journal/clients/etc. still read `apex_token` directly via the forward-compat path)

## Demo-blocker reminders (for tomorrow)

- **Vercel `wolfpack-instinct` project**: needs `GITHUB_TOKEN_WOLFPACK_AGENCY` and `WOLFPACK_SITES_WEBHOOK_SECRET` env vars before Sites can deploy a real client site
- **`the-wolfpack-agency/wolfpack-site-template` repo**: needs `INSTINCT_WEBHOOK_URL` and `WOLFPACK_SITES_WEBHOOK_SECRET` Actions secrets for the canary callback to work
- **HR feature**: zero env vars required, fully working in production right now

## Test stack rule (now memory-locked)

For every user-facing feature shipped from this point on:
1. **Unit** tests for pure functions, parsers, scorers
2. **API/route** tests for auth gates, validation surfaces, status codes
3. **Integration** tests for multi-step flows against real route handlers with stateful in-memory stores
4. **UI E2E** tests with real React render via React Testing Library + jsdom, walking the actual user flow with `userEvent.click` / `fireEvent.drop` / `userEvent.type` AND inspecting the actual fetch calls made

UI E2E is the **final layer** that catches what the lower layers miss. Skipping it because you "have unit coverage" is exactly how the 11 production bugs above shipped.

## Files of interest

- Handoff: [demo/handoff-2026-04-08.md](handoff-2026-04-08.md)
- Migrations: `src/db/migrations/009_sites.sql`, `010_people.sql`, `011_hr_documents.sql`
- Smart router: `src/lib/hr-documents.ts`
- Benefits engine: `src/lib/benefits.ts`
- Sites engine: `src/lib/sites.ts`

---

## Tomorrow's first actions, in order

1. Set Vercel env vars for Sites (2 min in browser, unblocks Sites entirely)
2. Pick a follow-up from the handoff doc (#2 employee linking is highest UX value for smallest effort)
3. When you get an Aetna/Cigna/UHC benefits PDF, drop it on HR Documents and paste me the raw extracted text — I'll add the parser variant in one round
