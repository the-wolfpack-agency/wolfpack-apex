# Instinct Release Report — 2026-04-18

**HEAD:** `8b7ad91` · **Tests:** 82 new (this session) · **Type errors:** 0 new · **2 feature commits today**

## Headline

Sites went from "shell works" to "non-technical team can design a whole site". Theme editor (color palette + Google font), three new section types (testimonial, pricing, FAQ), and admin-gated hard-delete all shipped with mount-based flow tests. Separately, the stuck-"Deploying…" bug the user caught live on `wolfpack-test4` got root-caused and fixed end to end: preflight now aborts the deploy with an actionable error if Instinct's env is missing required vars, and the same deploy path self-heals repo secrets on every attempt so pre-existing repos can't stay permanently broken.

## Stats

- **Tests:** 82 new across 5 suites — 42 theme (30 helpers + 12 mount), 32 new section types (10/11/11), 8 hard-delete flow tests. All green. 0 new tsc errors.
- **Test total touched (sites/brief/theme/sections suite):** 426 tests across 32 suites, 100% passing.
- **Runtime deps added:** 0.
- **New sections:** 3 (`testimonial`, `pricing`, `faq`) + backward-compatible `items[]` widening.
- **New components:** 4 (`ThemeEditor`, `sections/testimonial`, `sections/pricing`, `sections/faq`).
- **New analytics events:** 5 (`site.theme_edited`, `site.section_testimonial_added`, `site.section_pricing_added`, `site.section_faq_added`, `site.deploy_failed` now carrying `reason: "env_not_configured"` + `missing: [...]`).
- **Security fix:** 2 raw-`fetch("/api/...")` violations replaced with `fetchWithRefresh` — raw-fetch guardrail now green.

## Commits (today)

| Commit | Scope | What |
|---|---|---|
| `38a33ac` | **sites** | **theme editor, testimonial + pricing + FAQ sections, hard-delete UI, raw-fetch fix** |
| `8b7ad91` | **sites** | **preflight + self-heal to kill the "stuck Deploying…" bug** |

## The three new features

### 1. Theme editor (`src/components/sites/ThemeEditor.tsx`)
Five color rows (primary / accent / background / foreground / muted) each with a swatch + hex text input. Tolerant input — typing `#abc` or `#aabbcc` both work. Font picker is a curated 12-family dropdown (Inter, Roboto, Poppins, Work Sans, DM Sans, Lora, Merriweather, Playfair Display, Source Serif Pro, Space Mono, JetBrains Mono, Bebas Neue), every family ends with a generic fallback.

`render-brief.tsx` now emits theme CSS vars as an inline `style` on the site's `<main>` plus a scoped `<style>` block, so every section component consumes `var(--wp-site-primary)` etc. with built-in fallbacks. Debounced 500 ms `site.theme_edited` analytics — colors typed quickly don't spam the event.

**Backcompat:** legacy flat `theme = {primary: "#...", font: "Inter"}` persisted briefs still parse. `normalizeTheme()` lifts flat → nested at render time. Validator accepts both shapes.

### 2. Testimonial / Pricing / FAQ sections
- **Testimonial** — figure/blockquote/cite, optional `https://`-only author photo (tested with `javascript:alert(1)` payload and rejected).
- **Pricing** — tier cards with `data-highlighted` attribute + `pricing-highlighted` class on the featured tier. Feature list is a `<ul>`, edited as a single textarea in BriefForm (one feature per line; empty-line noise dropped automatically).
- **FAQ** — native `<details>`/`<summary>`, JS-free collapse.

All three register in `SUPPORTED_SECTION_TYPES`, dispatched by `render-brief.tsx`, and emit per-type analytics (`site.section_*_added`). Invalid items are skipped individually; a malformed pricing tier cannot break the page.

### 3. Admin-only hard delete
Detail page now shows **Delete permanently** next to **Archive site** when the logged-in user's role is ceo, cto, or hr (matches the server gate `hasRole(role, "hr")`). Confirms with a consequence-aware dialog naming both the GitHub repo and the Vercel project that will be removed. Surfaces the cleanup result (per-lane: "GitHub: wolfpack-cftr removed · Vercel: wolfpack-cftr removed", or "GitHub: 403 forbidden · Vercel: wolfpack-cftr removed") in the sites-list flash after redirect.

Mount-based flow tests cover all four role branches (sales/dev hidden, hr/ceo/cto visible), confirm-cancel, success + cleanup display, partial cleanup failure, and 403 error handling.

## The stuck-deploy fix (`8b7ad91`)

**Root cause** — reproduced live on `wolfpack-test4`: when Instinct's own Vercel env lacks `VERCEL_TOKEN_WOLFPACK_AGENCY` / `VERCEL_ORG_ID` / `WOLFPACK_SITES_WEBHOOK_SECRET`, every dispatched `canary-deploy.yml` dies at `vercel pull --token=` (empty token) before the "Notify Instinct" step runs. No webhook callback → project stays at `deploying` until the 10-minute reaper. UI spins with no way forward except "Archive".

**Fix** — three changes in one commit:

1. **`deployEnvPreflight()`** at the top of `triggerDeploy`. If any required var is missing, the deploy row is marked failed immediately with an actionable message naming the missing vars, project status flips to failed, `site.deploy_failed` fires with `reason: "env_not_configured"`, `missing: [...]`, and the workflow is **not** dispatched.
2. **Self-heal** — `provisionClientRepoSecrets` now re-runs on every deploy for pre-existing repos (not only newly-created). GitHub's PUT secret API is idempotent so this is ~zero cost, and it closes the gap where repos created before the auto-provision path landed stayed permanently broken.
3. **Reaper** 10 min → 3 min. A healthy canary is ~1.5 min; waiting 10 was cruel.

**Tests:** 1 new preflight test in `sites.test.ts`, reworked `sites-secret-provision.test.ts` (inverted "skips provisioning for existing repo" → "re-runs as self-heal"), and `sites-e2e.test.ts` beforeAll now sets the full Vercel env.

## Data + learning loop audit

A dedicated audit agent traced all 5 new analytics events through the triple-write contract:

- **Postgres** — every event INSERTs into `apex_events` (JSONB metadata w/ GIN index, `src/db/migrations/001_foundation.sql:41-53`).
- **Qdrant** — `tripleWriteEvent` (`src/lib/triple-write.ts:49-76`) upserts a knowledge point per event.
- **Neo4j** — same `tripleWriteEvent` records a knowledge interaction node/edge.
- **Audit log** (for `site.hard_deleted` specifically) — `recordAudit` appends to `instinct_audit_log` (hash-chained, PII-redacted).

**Result: GREEN.** No gap, no fix needed. Audit-signals anomaly detection picks up `site.hard_deleted` generically (resource-type agnostic), so no allow-list change was needed.

## Pre-existing guardrail fix (bonus)

Audit agent surfaced two raw `fetch("/api/analytics")` calls in `sites/[id]/edit/page.tsx:108` and `sites/[id]/page.tsx:561` that predated the `no-raw-api-fetch` guardrail. Both replaced with `fetchWithRefresh` + `jsonHeaders` in the same session. Guardrail test now green.

## Non-technical stats (for non-engineer stakeholders)

- Team can now design a site's **visual identity** (brand colors + font family) in the dashboard without touching code.
- Team can now add **social proof** (testimonials), **pricing pages**, and **FAQ** sections without code.
- **Admin users can permanently remove** a site along with its GitHub repo and Vercel project — no more orphaned cloud resources.
- The "stuck Deploying…" scenario that the team saw today on the live site is fixed at the code level. Once the three Vercel env vars are set, the **same deploy button will just work**.

## Open follow-ups

1. **Instinct Vercel env vars** (hard blocker for Monday): set
   `VERCEL_TOKEN_WOLFPACK_AGENCY`, `VERCEL_ORG_ID`,
   `WOLFPACK_SITES_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`.
2. **Playwright E2E spec** (`tests/e2e/sites-new-features.spec.ts`) covering
   one full journey: login → template → theme edit → section add → save
   → admin hard-delete.
3. **Surface `log_excerpt` on failed deploys** in the detail page so
   users see the actual reason instead of the generic "Check GitHub
   Actions logs" hint.
4. **AI image generation** — provider undecided (fal.ai / OpenAI / Vercel AI SDK).
5. **Click-to-edit on preview iframe** — next UX beat.

## Files touched

### New (11)
- `src/components/sites/ThemeEditor.tsx`
- `src/components/sites/sections/testimonial.tsx`
- `src/components/sites/sections/pricing.tsx`
- `src/components/sites/sections/faq.tsx`
- `src/lib/site-theme.ts`
- `src/lib/__tests__/site-theme.test.ts`
- `src/lib/__tests__/theme-editor.test.tsx`
- `src/lib/__tests__/testimonial-section.test.tsx`
- `src/lib/__tests__/pricing-section.test.tsx`
- `src/lib/__tests__/faq-section.test.tsx`
- `src/lib/__tests__/sites-hard-delete-flow.test.tsx`

### Modified
- `src/lib/sites.ts` — preflight + self-heal + 3 min reaper
- `src/lib/sites-schema.ts` — theme type widening + 3 section validators
- `src/lib/analytics.ts` — 5 new event types
- `src/components/sites/BriefForm.tsx` — theme panel + 3 new section editors
- `src/components/sites/render-brief.tsx` — theme CSS vars + 3 dispatch cases
- `src/app/(dashboard)/sites/[id]/page.tsx` — hard-delete button + raw-fetch fix
- `src/app/(dashboard)/sites/[id]/edit/page.tsx` — raw-fetch fix
- `src/lib/__tests__/sites.test.ts` — preflight test + Vercel/secrets mocks
- `src/lib/__tests__/sites-secret-provision.test.ts` — inverted existing-repo test to self-heal
- `src/lib/__tests__/sites-e2e.test.ts` — full preflight env in beforeAll
- `src/lib/__tests__/render-brief.test.tsx` — extended dispatcher test

## How to resume

```bash
cd /Users/nicholashomyk/mono/wolfpack-apex
git pull
npx jest --no-coverage
```
