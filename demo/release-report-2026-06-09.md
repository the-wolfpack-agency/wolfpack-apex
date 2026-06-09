# Release Report — 2026-06-09 · Instinct Survey Platform + Weekend with Porsche

**Repo:** the-wolfpack-agency/wolfpack-apex (Instinct) · **Branch:** main · **HEAD:** `325c4ae`
**Deploy:** wolfpack-instinct.vercel.app (Vercel; migrations run via `vercel-build`)

## Summary
Shipped a complete, in-house, client-facing **survey platform** integrated with the existing QR module, and used it to stand up two themed, comparison-ready surveys for the **"A Weekend with Porsche"** program. No third-party form SaaS; no paid builder license.

## Live surfaces
| Surface | Path | Notes |
|---|---|---|
| Survey builder | `/surveys` (+ left-nav) | create/edit, 7 question types, themes, upload-from-JSON, QR, insights |
| Public responder | `/s/<slug>` | anonymous, themed, server-validated, funnel-instrumented |
| Porsche survey v1 | `/s/weekend-porsche` | porsche.com theme (white / Guards Red / Porsche Next) |
| Porsche survey v2 | `/s/weekend-porsche-2` | pitch-deck theme (sage green / dark) |
| QR module | `/qr` | idempotent survey-linked QR + deep-link + deletion-lock |

## Commits (17, this session)
```
30018b6 fix(qr): center QR inside its white box (no top-only gap)
2d4e371 fix(qr): remove duplicate boxSizing key that broke vercel-build
0642e9b feat(qr): deletion-lock for active QR campaigns
fd717ff feat(surveys): in-house client-facing survey builder (Phase 1)
8d9fc91 feat(surveys): question types for the "Weekend with Porsche" survey
ca4ff98 feat(surveys): analytics funnel, pre-loaded Porsche survey, nav + builder UX
58044ee fix(db,guard): stop .down.sql running as forward migrations; refine raw-fetch guard
43cb810 feat(surveys): inline QR display + clearer publish lifecycle + results overflow fix
2bde8b3 feat(surveys): edit surveys, custom vanity URLs, idempotent QR linking
1214926 feat(surveys): upload-from-JSON + detect retired QR (re-link instead of dead code)
9d7c5c3 feat(surveys,qr): deep-link "Manage in QR Codes" to the exact code + clickable public link
4e8ab5e fix(qr): make ?code deep-link reactive via useSearchParams (was unreliable)
d144ba1 feat(surveys): Porsche brand theme for the public responder
96f443e feat(surveys): v2 pitch-deck (sage) theme + Porsche wordmark on forms
31c3712 fix(surveys): use the official Porsche wordmark SVG (not hand-spaced text)
bccfce1 fix(surveys): styled "Upload file" button (hide native file input)
325c4ae fix(surveys): raise contrast on the v2 sage theme for legibility
```

## Database migrations (additive, idempotent)
`160` qr_code_lock · `161` surveys + survey_responses · `162` survey_analytics (views + duration/device/country/referrer) · `163` seed weekend-porsche · `164` survey theme column (+ v1 → porsche) · `165` seed weekend-porsche-2 (sage).
Plus the **migrate-runner fix**: `.down.sql` no longer runs as a forward migration; real `rollback()` + `down <name>` CLI added.

## Data / learning
Every survey + QR action emits typed `survey.*` / `qr.*` analytics (Postgres + triple-write fan-out); admin mutations also write hash-chained `recordAudit`. Responses, views, and scans persist to Postgres (source of truth). Funnel: views, completion rate, avg time-to-complete, device/geo/referrer, per-question aggregate incl. "Other" themes.

## Verification
- **~148 survey/responder tests green** — pure validator units, contract tests (200/201/400/401/404/409/429 incl. rate-limit + untrusted-answer rejection), builder + responder RTL (edit, upload, QR, theme, wordmark), seed-drift guards, theme + migrate-discovery units.
- `tsc --noEmit` clean and `eslint` clean on all shipped files.
- Each push verified locally before merge; CI E2E gate is chromium-only per the existing pipeline.

## Known / pre-existing (not introduced here)
`capability-coverage`, `audit-coverage`, `meeting-insights/*` suites fail locally — systemic, untouched files. Survey routes are audit/analytics-compliant; the public submit route is allowlisted in AUDIT_ALLOWLIST.

## Companion docs (`docs/`)
- `survey-builder-build-vs-buy-2026-06-09.md`
- `weekend-with-porsche-hosting-estimate-2026-06-09.md` (single all-in hosting line ~$300/mo; raw ~$30/mo pilot incremental; Azure OpenAI capped)

## Rollback
Each migration has a paired `.down.sql`; roll back deliberately with `tsx src/db/migrate.ts down <name>.sql`. Seeds (163/165) use `ON CONFLICT DO NOTHING` and are safe to re-run.
