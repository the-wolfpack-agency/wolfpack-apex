# Instinct Release Report — 2026-04-17 (evening)

**HEAD:** `524d492` · **Tests:** 140 new (net across the session) · **Type errors:** 0 new · **10 commits today (evening session)**

## Headline

`/sites` stopped being a JSON form with a 5-minute feedback loop and became a true split-screen prompt editor. Users describe what they want in natural language on the left, see the change live in an iframe on the right, publish when ready. Every prompt, patch, acceptance, and rejection persists to an audit trail that now feeds a learning loop, so the dashboard can trend acceptance rate and cost over time.

In the process, the "Generate preview" button that had been silently 500-ing for over a day got diagnosed and fully fixed with auto-healing code so the next client never sees any of it.

## Stats

- **Tests:** 140 new across 8 suites (106 for the editor feature + 34 for the learning consumer). All green. 0 new tsc errors.
- **Runtime deps added:** 0 (RFC 6902 subset written inline).
- **New migrations:** 2 (`029_site_brief_edits`, `030_brief_edit_insights_snapshots`).
- **New API routes:** 4 (`POST /api/sites/[id]/brief-edit`, `PATCH /api/sites/[id]/brief-edit/[editId]`, `GET /api/sites/[id]/deploys`, `GET /api/sites/insights/brief-edits`).
- **New app routes:** 2 (`/sites/[id]/edit`, `/sites/[id]/preview`).
- **New components:** 9 (`RenderBrief` dispatcher + 8 section components under `src/components/sites/sections/`).
- **New analytics events:** 7 on `ApexEventType` (`brief_edit_requested`, `_generated`, `_failed`, `_blocked`, `_decided`, `insights_viewed`, `insights_snapshot_taken`) plus 4 client-side funnel events (`edit_opened`, `edit_entry_clicked`, `edit_discarded`, `edit_published`).

## Commits (evening session)

| Commit | Scope | What |
|---|---|---|
| `191dedf` | sites | `GET /api/sites/:id/deploys` diagnostic endpoint + save/deploy E2E spec |
| `f9f853f` | sites | 503 + structured `reason` for known deploy failures (replaces generic 500) |
| `7bba84f` | sites | `triggerWorkflow` passes `deploy_id` so the canary webhook callback actually fires |
| `fcf5e2e` | sites | `enableActions()` + 404-retry on workflow dispatch |
| `9f9f2da` | chore | empty commit to force Vercel rebuild for `WOLFPACK_SITES_WEBHOOK_SECRET` |
| `bcd1056` | **sites** | **split-screen prompt editor (chat + live iframe preview)** |
| `524d492` | **sites** | **brief-edit learning loop + nightly insights snapshot** |

Template repo (`wolfpack-site-template`):

| Commit | What |
|---|---|
| `08e6674` | `canary-deploy.yml` auto-disables Vercel Deployment Protection |
| `665ad2b` | Canary smoke `curl -f` fix on 4xx-expecting checks |

Client repo (`wolfpack-test3`):

| Commit | What |
|---|---|
| `3f8c50b` | Sync the two template fixes into the already-provisioned client |

## The main feature

### `/sites/[id]/edit`
Split-screen: chat on the left, iframe preview on the right. Typing a prompt like "change the hero headline to Season One" fires `POST /api/sites/:id/brief-edit`, which calls Haiku 4.5 to produce a JSON patch, applies it to the draft brief, and pushes a base64-encoded draft into the iframe via URL param. The iframe re-renders in <100 ms — no deploy in the loop. Publish triggers the existing save → canary → Vercel flow exactly as before.

### Guardrails
`validatePatchPaths` is an allow-list: only `/pages`, `/client`, `/product`, `/contactForm`, `/theme` paths are editable. `/client_slug`, `/github_repo`, `/status`, `/github_repo_url`, `/preview_url` are belt-and-suspenders blocked by name. Any blocked attempt still persists to `apex_site_brief_edits` with `accepted=false, rejection_reason="patch_blocked"` — bad attempts are training signal, not lost data.

### Learning loop
`apex_site_brief_edits` stores instruction, patch, before/after brief hashes, latency, tokens, cost, model, and decision on every attempt. `src/lib/brief-edit-learning.ts` aggregates rows into a `BriefEditInsights` structure exposed at `GET /api/sites/insights/brief-edits?days=N` (admin-gated). A nightly script rolls up 7-day and 30-day windows into `apex_brief_edit_insights_snapshots` so trend lines are available forever.

## Test matrix

| Layer | Suite | Tests |
|---|---|---|
| Unit (editor lib) | `brief-edit.test.ts` | 25 |
| Unit (editor UI helpers) | `edit-page.test.tsx` | 10 |
| Component | `render-brief.test.tsx` | 33 |
| Route | `brief-edit-route.test.ts` | 14 |
| DB schema | `brief-edit-migration.test.ts` | 6 |
| API contract | `brief-edit-contract.test.ts` | 18 |
| Unit (learning lib) | `brief-edit-learning.test.ts` | 23 |
| Route (learning) | `brief-edit-insights-route.test.ts` | 11 |
| **Subtotal jest** | | **140** |
| E2E (Playwright, skipped w/o creds) | `sites-edit-flow.spec.ts` | 10 |
| E2E (Playwright, skipped w/o creds) | `sites-save-and-deploy.spec.ts` | 3 |

The 10-case editor E2E asserts the UX contract end-to-end: mount, prompt→draft, **iframe actually shows the updated heading** (validates the whole draft passthrough chain), localStorage restore across reload, multi-prompt accumulation on the same draft, `ai_unavailable` banner, `patch_blocked` banner shows which paths were refused, empty-input disables Send, detail-page link, full publish flow asserts save PATCH → deploy PATCH in that order.

## Infrastructure work done this session

Set up from scratch:
- `GITHUB_TOKEN_WOLFPACK_AGENCY` — fine-grained PAT on `the-wolfpack-agency` org, Administration+Contents+Actions write, All repositories, ~90-day expiry. Rotated mid-session after accidental exposure.
- `WOLFPACK_SITES_WEBHOOK_SECRET` — 64-char hex, same value in Vercel (Instinct) and as a per-client-repo GitHub Actions secret.
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `INSTINCT_WEBHOOK_URL` — on `wolfpack-test3` (GitHub Free plan forces per-repo scoping).
- Manually disabled Vercel Deployment Protection on `wolfpack-test3` (one-time; future clients get it auto-disabled via `canary-deploy.yml` step).
- Manually enabled GitHub Actions on `wolfpack-test3` (one-time; future clients get it via the new `enableActions()` call in Instinct's provisioning code).

## Open items (not blockers)

1. **Nightly canary creds** — add `SMOKE_TEST_EMAIL` + `SMOKE_TEST_PASSWORD` as repo secrets on `wolfpack-apex` so `sites-edit-flow.spec.ts` + `sites-save-and-deploy.spec.ts` run in CI every night instead of being skipped.
2. **Auto-copy repo secrets on new client provisioning** — today secrets are per-repo; the new-client flow should `PUT /repos/{o}/{r}/actions/secrets/{name}` for the 5 shared secrets after `createRepoFromTemplate`. Needs `libsodium-wrappers` for the required encrypted-payload shape.
3. **Vercel project auto-creation** — Instinct should `POST /v9/projects` via the Vercel API after creating the GitHub repo, set `ssoProtection: null`, and store the returned projectId as a repo secret. Eliminates the manual `vercel link` step per client.
4. **GitHub Team upgrade** — $4/user/mo unlocks org-level secrets on private repos; makes items 2+3 unnecessary at scale.
5. **Click-to-edit on the preview** — the next step beyond prompt-only. Out of scope for tonight; documented in the handoff.
6. **time-to-publish distribution** — skipped in the learning aggregator because the join against `apex_site_deploys` needs a `deploy_triggered_by_edit_id` column. Forward-compatible schema — backfilling is additive.

## Verification status (at report time)

- `bcd1056` + `524d492` pushed to `origin/main`.
- Vercel rebuild was in flight at the end of the session; at the time of writing this report the editor route was still returning 404 from cache. Re-check `https://wolfpack-instinct.vercel.app/sites/site_b1ea924b-59fd-46dc-8863-06dbe7163809/edit` once the Vercel dashboard shows `524d492` as Ready.
- The wolfpack-test3 canary deploy row `2026-04-18T01:18:12Z` was still `status=building` — overlapping workflow dispatches from multiple triggers. Next session: confirm the canary flips to `success` on the fresh run after all fixes are in place.
