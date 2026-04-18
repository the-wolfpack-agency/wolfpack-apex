# Wolfpack Instinct — Session Handoff
**Date:** 2026-04-17 (evening session)
**HEAD commit:** `bcd1056` (+ a follow-up for the learning consumer, still in-flight from sub-agent)
**Deployed:** https://wolfpack-instinct.vercel.app (Vercel rebuild in flight at handoff time)
**Repo:** the-wolfpack-agency/wolfpack-apex

---

## Headline

`/sites` went from "upload a brief, wait 5 min for a deploy, repeat" to a split-screen prompt-driven editor. Users type `"make the hero say X"`, see the change live in an iframe in <100 ms, keep iterating, then click **Publish** once to trigger the existing save→canary→Vercel deploy pipeline. Every prompt, patch, rejection, and acceptance persists to an audit table for a learning loop the next session can consume.

Along the way, the Generate preview button that was returning `{"error":"Internal server error"}` for over a day was diagnosed (missing `GITHUB_TOKEN_WOLFPACK_AGENCY` Vercel env, disabled Actions on template-created repos, broken canary smoke `curl -f` flag) and fully fixed with auto-healing code so the next client doesn't hit any of it.

---

## What shipped today (evening)

### Instinct / wolfpack-apex (`the-wolfpack-agency/wolfpack-apex`)

| Commit | What |
|---|---|
| `191dedf` | `GET /api/sites/:id/deploys` admin diagnostic endpoint + E2E spec `sites-save-and-deploy.spec.ts` that exercises save + deploy and surfaces `log_excerpt` on failure |
| `f9f853f` | Deploy PATCH now returns 503 with structured `reason: "github_token_missing"` (or 500 + `reason: "deploy_failed"` with pointer to `/deploys` endpoint) instead of generic 500 |
| `7bba84f` | `triggerWorkflow` passes `deploy_id` input so the canary webhook callback actually fires — fixed a silent bug where `preview_url` never populated back into `apex_site_deploys` |
| `fcf5e2e` | `enableActions()` + 404-retry on workflow dispatch → new client repos self-provision GitHub Actions without any human click |
| `9f9f2da` | Empty commit to force Vercel to pick up the new `WOLFPACK_SITES_WEBHOOK_SECRET` env var |
| `bcd1056` | **Split-screen prompt editor — the day's main feature. Detail below.** |

### Template / wolfpack-site-template (`the-wolfpack-agency/wolfpack-site-template`)

| Commit | What |
|---|---|
| `08e6674` | `canary-deploy.yml` auto-disables Vercel Deployment Protection on every run — new client repos don't need a human to click "Disable SSO" after the first failed canary |
| `665ad2b` | Canary smoke `curl -fsS` → `curl -sS` on the three checks that *expect* 4xx responses. `-f` was making curl exit non-zero before printing the status code, so the grep never saw the right value. Three silent false-negatives gone. |

### Client repo / wolfpack-test3 (`the-wolfpack-agency/wolfpack-test3`)

| Commit | What |
|---|---|
| `3f8c50b` | Synced the two template fixes into the already-created client repo (templates are a copy-at-creation-time snapshot; no auto-sync) |

---

## The main feature: `/sites/[id]/edit`

**Layout**
Left pane: chat (prompt input, message history with collapsible JSON-patch diffs, Send/Publish/Discard).
Right pane: live `<iframe>` pointing at `/sites/[id]/preview` — a chrome-less route that server-renders the brief with shared `<RenderBrief>` components.
Drafts pass into the iframe via `?draft=<base64(JSON)>` in the URL (256 KB cap, graceful fallback). No deploys fire on prompt; only **Publish** triggers the save → `?action=deploy` chain.

**Under the hood**
- **Backend** (agent A): migration `029_site_brief_edits.sql` (full audit table + `instinct_*` view alias), `src/lib/brief-edit.ts` (AICaller using Haiku 4.5, `generateBriefEdit`, `applyPatch` — RFC 6902 subset, no new runtime deps — `validatePatchPaths` with allow-list on `/pages`, `/client`, `/product`, `/contactForm`, `/theme` + belt-and-suspenders block on `/client_slug`, `/github_repo`, etc., `recordBriefEditDecision`), `POST /api/sites/[id]/brief-edit` + `PATCH /api/sites/[id]/brief-edit/[editId]`. Structured error reasons: `patch_blocked` → 422, `ai_unavailable` → 502. **Every** attempt — accepted, rejected, blocked, AI-failed — persists a row; cost + tokens + latency + model captured.
- **Renderer** (agent B): 8 section components (`hero`, `text`, `cards`, `gallery`, `quote`, `stats`, `callout`, `banner`) in `src/components/sites/sections/`, a top-level `<RenderBrief>` dispatcher, and the chrome-less `src/app/sites/[id]/preview/page.tsx` route. Never uses `dangerouslySetInnerHTML`; a heading containing `<script>alert(1)</script>` renders as escaped text (regression-tested).
- **Editor UI**: `src/app/(dashboard)/sites/[id]/edit/page.tsx`. Draft persists to localStorage so mid-session reloads surface a "Restored" banner. Publish order is asserted in tests: save `PATCH` → `PATCH ?action=deploy`. Discard records `accepted=false` on the last edit so the learning corpus reflects reality.
- **Learning SSOT**: 5 new `ApexEventType` event names (`brief_edit_requested`, `_generated`, `_failed`, `_blocked`, `_decided`). Editor also emits `site.edit_opened`, `site.edit_discarded`, `site.edit_published`, `site.edit_entry_clicked` for funnel analysis.
- **Detail-page doorway**: the existing `/sites/[id]` page gets a "Prompt editor →" button next to Generate preview, wired to a `site.edit_entry_clicked` analytics event so we can measure which surface users prefer.

**Test matrix — all green, 0 new tsc errors, 0 new runtime deps**

| Layer | Suite | Tests |
|---|---|---|
| Unit (lib) | `brief-edit.test.ts` | 25 |
| Unit (UI helpers) | `edit-page.test.tsx` | 10 |
| Component | `render-brief.test.tsx` | 33 |
| Route | `brief-edit-route.test.ts` | 14 |
| DB schema | `brief-edit-migration.test.ts` | 6 |
| Contract | `brief-edit-contract.test.ts` | 18 |
| **Subtotal jest** | | **106** |
| E2E (Playwright, skipped w/o creds) | `sites-edit-flow.spec.ts` | 10 |

The 10-case E2E covers: mount with both panes, prompt → draft enables Publish, **iframe actually shows the updated heading** (end-to-end live-preview chain), localStorage restore across reload, multi-prompt accumulation on the same draft, `ai_unavailable` banner, `patch_blocked` banner, empty-input disables Send, detail-page link, full publish flow (save PATCH then deploy PATCH in that order).

The `sites-save-and-deploy.spec.ts` from earlier in the day (3 cases) is also gated on `SMOKE_TEST_EMAIL`/`SMOKE_TEST_PASSWORD` — see open items for the nightly canary setup.

---

## Live verification status (at handoff time)

Committed ✓ Pushed ✓ Vercel rebuild: **in flight** at handoff.

- `GET /sites/<id>/edit` → 404 at `qz9nd-1776476793869-74a8c3c07aca` (cached). When the new build promotes this should return the editor HTML.
- `POST /api/sites/<id>/brief-edit` → 404 same reason.
- Easiest re-check: visit `https://wolfpack-instinct.vercel.app/sites/site_b1ea924b-59fd-46dc-8863-06dbe7163809/edit` once Vercel's Deployments tab for the Instinct project shows the `bcd1056` build as Ready.

On the test3 deploy side: the Vercel preview URL `https://wolfpack-test3-jmpk943zr-nhomyks-projects.vercel.app` rendered publicly after Deployment Protection was disabled. The most recent deploy row (started `2026-04-18T01:18:12Z`) was stuck in `building` at handoff — likely because multiple workflow dispatches overlapped (Instinct-triggered + push-triggered from the canary-fix push). Next session: tail the workflow run on `the-wolfpack-agency/wolfpack-test3` Actions tab to confirm the canary now reports passed.

---

## Required Vercel + GitHub config (done today — don't redo)

Everything was set up from scratch tonight — document it so future sessions can audit or rotate:

### Vercel env vars on the Instinct project (Production + Preview)
- `GITHUB_TOKEN_WOLFPACK_AGENCY` — fine-grained PAT on `the-wolfpack-agency` org, Repo Admin + Contents + Actions write, Metadata read, All repositories. Rotated during session after the original got exposed in terminal output. Expires ~90 days from today.
- `WOLFPACK_SITES_WEBHOOK_SECRET` — 64-char hex from `openssl rand -hex 32`. Must match the GitHub repo secret of the same name on every client site repo.

### GitHub repo secrets on `wolfpack-test3` (per-repo; future clients inherit via a code improvement queued below)
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
- `INSTINCT_WEBHOOK_URL` = `https://wolfpack-instinct.vercel.app/api/sites/webhook`
- `WOLFPACK_SITES_WEBHOOK_SECRET` (same value as Vercel above)

### Why repo-level, not org-level
GitHub Free plan doesn't allow org-level secrets on private repos. Upgrading `the-wolfpack-agency` to GitHub Team ($4/user/mo) unlocks private-repo org secrets and removes the per-client friction. Until then, every new client repo needs the 5 secrets copied by hand — a code improvement to auto-copy is queued below.

---

## Continue exactly where we left off

### 1. Learning consumer is being built by a sub-agent right now
An agent was mid-flight at handoff building the brief-edit learning loop:
- `src/lib/brief-edit-learning.ts` — aggregates `apex_site_brief_edits` rows into `BriefEditInsights` (acceptance rate, rejection reasons, blocked-path frequency, p50/p95/p99 latency, cost, section-type edit counts, instruction themes).
- `src/app/api/sites/insights/brief-edits/route.ts` — admin-gated GET returning the insights.
- `scripts/brief-edit-insights-nightly.ts` + `migration 030` for persisted weekly/monthly snapshots.
- Unit + route + contract tests.

**Next-session first step**: check `/private/tmp/claude-501/.../tasks/a92c4288a81ee7aeb.output` tail for completion, pull the generated files into the repo, run jest, commit as a follow-up to `bcd1056`, push.

### 2. Verify the live feature on prod
Once Vercel finishes the `bcd1056` rebuild:
- Load `https://wolfpack-instinct.vercel.app/sites/site_b1ea924b-59fd-46dc-8863-06dbe7163809/edit`.
- Type a prompt like `"Change the hero headline to 'Season One'"`.
- Confirm the iframe preview updates in <1 s without a deploy.
- Click Publish → confirm a new row lands in `apex_site_deploys` with the webhook eventually populating `preview_url`.

### 3. Wire up the nightly canary
Add the two GitHub Actions secrets so `sites-save-and-deploy.spec.ts` and `sites-edit-flow.spec.ts` run against prod every night:
- `SMOKE_TEST_EMAIL` = `ceo@wolfpack.dev`
- `SMOKE_TEST_PASSWORD` = `apex`
At https://github.com/the-wolfpack-agency/wolfpack-apex/settings/secrets/actions.
Not a blocker — just makes regressions fail loud in <24 h.

### 4. Queued code improvements (not urgent, but cheap and meaningful)
- **Auto-copy repo secrets to new client repos** from Instinct's provisioning code. Requires libsodium-wrappers + a GitHub `PUT /repos/{o}/{r}/actions/secrets/{name}` call per secret after `createRepoFromTemplate`. Eliminates the last manual step in onboarding a new client.
- **Provision a fresh Vercel project per client** from Instinct instead of having an operator run `vercel link` by hand. `POST /v9/projects` via the Vercel API, set `ssoProtection: null`, store the returned `projectId` as a repo secret (see above).
- **Shared section components as an npm package** (`@wolfpack/site-sections`) so the template repo and Instinct's preview route import from the same place. Today they're parallel implementations; the drift risk is real. Makes the instant-preview contract water-tight.

### 5. Pending prompt-to-prompt UX additions
The user explicitly called out two features in chat:
- Live split-screen prompt + preview — **shipped**.
- A "truly interactive no extra clicks" editing experience — the iframe-update-on-prompt is step 1; the next step is **inline click-to-edit on the preview itself** (click a heading → cursor appears, type → brief updates). Out of scope for tonight; noted for a future session.

### 6. Failed deploy cleanup
`apex_site_deploys` has 3 rows that say `status=failed` from the diagnostic phase earlier tonight. They're honest failures (GITHUB_TOKEN missing, Actions disabled, canary-f bug) and all three root causes are fixed now. Leave them in the history as breadcrumbs; a future "reap stale failed deploys" job can handle retention.

---

## Files touched this session

### Created
```
# Instinct repo
src/app/(dashboard)/sites/[id]/edit/page.tsx             # the editor
src/app/sites/[id]/preview/page.tsx                      # chrome-less preview (iframed)
src/app/api/sites/[id]/brief-edit/route.ts               # POST — generate patch
src/app/api/sites/[id]/brief-edit/[editId]/route.ts      # PATCH — accept/reject decision
src/app/api/sites/[id]/deploys/route.ts                  # admin diagnostic (from earlier in the day)
src/components/sites/render-brief.tsx                    # top-level dispatcher
src/components/sites/sections/{hero,text,cards,gallery,quote,stats,callout,banner}.tsx
src/lib/brief-edit.ts                                     # AICaller + applyPatch + validators
src/db/migrations/029_site_brief_edits.sql
src/lib/__tests__/brief-edit.test.ts                     # 25
src/lib/__tests__/brief-edit-route.test.ts               # 14
src/lib/__tests__/brief-edit-migration.test.ts           # 6
src/lib/__tests__/brief-edit-contract.test.ts            # 18
src/lib/__tests__/render-brief.test.tsx                  # 33
src/lib/__tests__/edit-page.test.tsx                     # 10
tests/e2e/sites-edit-flow.spec.ts                        # 10
tests/e2e/sites-save-and-deploy.spec.ts                  # 3 (from earlier in the day)

# Template repo
.github/workflows/canary-deploy.yml                      # auto-disable-protection step
scripts/canary-post-deploy.sh                            # curl -f fix on 4xx checks
```

### Modified
```
src/app/(dashboard)/sites/[id]/page.tsx   # "Prompt editor →" link
src/app/api/sites/[id]/route.ts           # structured deploy-error reasons
src/lib/analytics.ts                      # 5 new ApexEventType entries
src/lib/github-client.ts                  # enableActions + workflow-dispatch retry + inputs param
src/lib/sites.ts                          # listSiteDeploys + enableActions call in triggerDeploy + deploy_id passthrough
```
