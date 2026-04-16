# Instinct Release Report — 2026-04-16

**HEAD:** `9ebf5ba` · **Tests:** 1796/1804 passing (1 skipped, 7 pre-existing baseline) · **Type errors on touched files:** 0 · **4 commits today**

## Headline

Three client-reported gaps on `/sites` shipped to production:

- **Sites can be archived** — soft-delete (status flip + audit row) from both the list card and the detail-page header. Archived sites disappear from `/sites` but history, triple-write rows, and deployment record stay intact.
- **Sites detail page is now a guided 1→2→3 flow** — single column, mobile-responsive, status banner that tells the user the next step ("Deploying… (~1 min) — The Open button will appear here when ready"). Designed for non-technical users (Max + Meghan), not engineers.
- **Expired sessions redirect to `/login` instead of rendering blank** — every authenticated `fetch("/api/...")` call from a `"use client"` component now goes through `fetchWithRefresh`, which transparently rotates a 401 access token via the HttpOnly refresh cookie or, on refresh failure, clears the session and routes to `/login?next=<current>`. Permanent guardrail test (`no-raw-api-fetch.test.ts`) blocks any future raw-fetch regression.

## Stats

- **Tests:** 1750 → 1796 passing (+46 net new)
- **Test suites:** 120 → 122
- **Files migrated to `fetchWithRefresh`:** 46 (45 dashboard pages + components, plus `lib/integrations/connect.ts`)
- **New API routes:** 1 (`DELETE /api/sites/[id]`)
- **New analytics events:** 1 (`site.archived`, registered in the `ApexEventType` union)
- **Lib changes:** `sites.ts` (`deleteSiteProject` soft-archive + `listSiteProjects` filters archived rows), `analytics.ts` (event registration)

## Production-incident bug count today

**2 silent Vercel deploy failures** caught only because I curl'd the deployed JS chunk for the new banner copy and it wasn't there.

The `fetchWithRefresh` migration inserted `import { fetchWithRefresh } from "@/lib/client-auth";` at line 1 of 9 client components that already had `"use client";` at line 1 — pushing the directive to line 2. Next refuses to build that:

> The "use client" directive must be placed before other expressions.

Local `jest`, `tsc`, and `eslint` all stayed green. `scripts/verify.sh` (the canonical pre-push) ran lint + tsc + jest and reported all stages passed. Two consecutive commits (`d0427b7`, `e4fd772`) deployed-but-failed in Vercel without any local signal. The redesigned detail page never actually reached prod until the third attempt.

Each of the 9 affected files now has `"use client"` back on line 1. The class is now locked behind a regression — `npx next build` is Stage 4 of `scripts/verify.sh`, mandatory pre-push, skippable in inner-loop with `VERIFY_SKIP_BUILD=1`.

## Verification on prod (`https://wolfpack-instinct.vercel.app`)

After `e82d71f` deployed (Vercel state: success), I curl'd `/sites/<id>` to grab the chunk URLs, then grep'd each chunk for the new banner copy. All 8 redesign strings live in `/_next/static/chunks/0-3zbd05rox01.js`:

| String | In bundle |
|---|---|
| `Draft — not yet deployed` | ✓ |
| `Live — preview is ready` | ✓ |
| `Last deploy failed` | ✓ |
| `Generate preview` | ✓ |
| `Re-deploy` | ✓ |
| `Edit the brief` | ✓ |
| `Upload images` | ✓ |
| `Archive site` | ✓ |

This proves the build shipped. **Eyes-on-glass click-through with auth (open the page in a browser, log in, walk the flow, confirm layout + interactions on real screens) was not done in this session** — it's flagged in the handoff as the only remaining verification gap.

## Architecture wins

1. **Status-banner copy is unit-testable** — the `statusCopy(status, hasPreview)` helper got exported from `sites/[id]/page.tsx` and pinned with 7 regression tests in `sites-detail-ui.test.tsx`. Each user-visible message ("Draft — not yet deployed", "Live — preview is ready", "Last deploy failed", etc.) is contract-tested. Full-page UI render is deferred to a future Playwright suite (`use(params: Promise)` doesn't unwrap inside RTL's `waitFor` scheduler — flagged in `.ai/conventions.md` line 70 as the trigger to finally add Playwright).

2. **Soft-archive over hard-delete** — `deleteSiteProject` flips `status` to `'archived'` rather than dropping the row, so the audit log, triple-write entries, and deployment history stay intact. List query filters with `WHERE status != 'archived'`. Reversible by design.

3. **`fetchWithRefresh` dedupes concurrent refreshes** — a single in-flight refresh promise is shared across N parallel 401s, so a stale token doesn't trigger N parallel refresh calls. Refresh-token theft detection (re-use of a revoked token revokes the entire family + emits `system.refresh_token_reuse_detected`) was already wired in the 04-15 release; today's work is the client-side adoption.

4. **Build-gate hardening** — `next build` now sits between `jest` and the push, catching the entire class of "compiles in TS, builds in Next, but Next refuses to ship it" bugs (mis-ordered directives, server/client component import drift, MDX/font/image misuse). This is the kind of gate that pays for itself the first time it catches one.

## Process gap noted (for transparency)

Initial commit (`d0427b7`) shipped without reading `wolfpack-apex/CLAUDE.md` or `.ai/conventions.md` — the session had pivoted from wolfpack-auto and I assumed the loaded sibling-repo docs covered Instinct. They don't. Remediation:

- Read both files.
- Added `feedback_read_repo_claude_first.md` to AgenticQA memory so the next session reads the target repo's CLAUDE.md before touching code, even when a sibling's is already in context.
- Wrote this report + the 04-16 handoff at session end (per Instinct's `.ai/conventions.md` "Per-session context" rule — `npm run handoff` then fill in conversational context).

## Commits this session

| Hash | Message |
|---|---|
| `d0427b7` | feat(sites): delete site + redesigned detail page + dashboard auth-redirect |
| `e4fd772` | test(sites): statusCopy regression suite + handoff doc |
| `e82d71f` | fix(build): "use client" must be first line — d0427b7 broke Vercel |
| `9ebf5ba` | docs: handoff — record the deploy gap, fix, and prod verification |

## Known blockers (unchanged from 04-15)

- `INSTINCT_JWT_SECRET` (≥32 chars) — code throws in production without it.
- `RESEND_API_KEY` + sender domain — required for invite + notification flow.
- `GITHUB_TOKEN_WOLFPACK_AGENCY` + `WOLFPACK_SITES_WEBHOOK_SECRET` — Sites module deploys.
- `PROD_DOMAIN` — activates the TLS hybrid posture CI assertion.
