# Release Report — 2026-04-28 (Instinct)

**Scope:** Two-track day. Morning was the support@ auto-acknowledge launch + AI cost-control work. Afternoon collapsed into a single deep debug + fix marathon on the porsche-classes inbox poller — the demo-blocker the operator had been hitting since the 04-26 ship.

**Branch:** main (every commit pushed to `the-wolfpack-agency/wolfpack-apex`)
**Final commit on main:** `6c33f4b feat(automations): surface quarantined messages inline on Run-now`
**Deploy status at end of session:** ✅ green on Vercel.

---

## Highlights

### Support — auto-acknowledge ships

- **`feat(support): support@ auto-acknowledge — Phase 1 of full automation`** ([755f139](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/755f139)) — every inbound support ticket now fires an immediate auto-reply (templated, branded, signed). Phase 1 of the full-auto support track.
- **`feat(support): self-healing auto-ack retry pass in poller`** ([777fd15](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/777fd15)) — when the auto-ack send fails (Graph 502, scope blip), the poller picks it up on the next tick and re-tries; idempotency keys prevent dupes.
- **`feat(support): add auto-ack diagnostic retry endpoint`** ([f13f061](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/f13f061)) — operator-facing manual retry button for stuck acks.
- **`feat(support): AI savings analytics dashboard at /support/analytics`** ([b253daa](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/b253daa)) — surfaces tokens-saved-vs-baseline, cache-hit rate, average response time per ticket type. Visible at `/support/analytics`.
- **`fix(support): isDraftGeneratorAvailable accepts Azure OpenAI config too`** ([ea8cc9e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/ea8cc9e)) — unblocked Azure OpenAI tenant config which was being checked only against the OpenAI shape.
- **`fix(support): unwrap { ticket } envelope on feedback response`** ([1a6a1ab](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/1a6a1ab)) — third (and final) mutation path with a stale envelope shape.
- **`fix(support): preserve paragraph breaks when stripping HTML email body`** ([868bf5a](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/868bf5a)) — incoming HTML emails were getting flattened to one paragraph.
- **`test(support): cover self-healing auto-ack retry pass in poller`** ([245c90d](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/245c90d)) — Jest coverage on the new retry path.
- **`test(e2e): support flow Playwright spec hits live deploy`** ([8cddcef](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/8cddcef)) — full submit → ack → reply chain tested against the deployed URL.

### AI cost — persistent response cache

- **`feat(ai): persistent response cache — only novel requests burn tokens`** ([584a9d1](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/584a9d1)) — Postgres-backed cache keyed on hashed prompt + model + context-window. Cache hit returns the previous response instantly with zero tokens. Hit rate exposed via the new support analytics dashboard.

### porsche-classes inbox poller — the marathon

The 04-26 ship had a working ingest pipeline against `homyk@`'s mailbox in an isolated test, but the operator's live "Run Inbox Poll Now" returned `Seen 0 · Matched 0` no matter what they tried. Eight hours of layered fixes:

**Diagnostic surface area** (so the next bug is one click, not 30 minutes of grep):

- **`feat(automations): graph-probe diag for porsche-classes`** ([c546796](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/c546796)) — auth-gated endpoint that reports token mailbox, Graph `/me` UPN, inbox total, newest 5 messages, and the raw fallback URL the poller builds.
- **`feat(automations): inline diag block on poll-now when seen=0`** ([88df0a9](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/88df0a9)) — when Run-now reports 0, the response now carries a `diag` block rendered under the counter line. No DevTools dance.
- **`chore(probe): include fallback's filtered URL in graph-probe output`** ([bab3cb4](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/bab3cb4)) — surfaces the exact $filter URL so the diag is reproducible.
- **`feat(automations): diag now probes the UPN-target mailbox in search mode`** ([55aa1ad](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/55aa1ad)) — when `AUTOMATION_POLL_MAILBOX_UPN` is set, the diag also reports the target mailbox's inbox + 5 newest, so a wrong-mailbox config is visible at a glance.
- **`feat(diag): poll-now diag enumerates ALL polled bases`** ([10bf87e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/10bf87e)) — once multi-mailbox shipped, the diag iterates every mailbox the poller actually reads.
- **`chore: whoami endpoint for diagnosing ms_tokens identity mismatches`** ([a690d3b](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/a690d3b)) — `/api/whoami` shows the lookup key the poll feeds to `getValidToken`.
- **`feat(automations): surface quarantined messages inline on Run-now`** ([6c33f4b](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/6c33f4b)) — Run-now now includes the most recent quarantined exceptions (kind, detail, subject extracted from the raw .eml) so the operator sees what failed and why.

**Auth identity correctness:**

- **`fix: POST poll route uses auth.user.email like GET does`** ([e1ad404](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/e1ad404)) followed by **`fix: revert POST/GET to auth.user.id — demo emails are placeholders`** ([bb9697e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/bb9697e)) — demo accounts have placeholder emails (`cto@wolfpack.dev`) that don't match any real Microsoft mailbox; `auth.user.id` is the stable anchor. `getValidToken`'s dual `(connected_by OR user_email)` lookup still covers id-anchored AND email-anchored token rows.

**Delta-mode fallback (the operator's mailbox):**

- **`fix(automations): inbox-list fallback when Graph delta returns 0`** ([115c49e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/115c49e)) — Microsoft delta endpoint returns 0 items during per-mailbox index-rebuild windows even when the inbox has fresh messages. Fallback drops to `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ...` for a 7-day window.
- **`test: cover delta→inbox-list fallback + cursor-poison guard`** ([e0cff8f](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/e0cff8f)) — Jest covers the cursor-not-saved-when-delta-empty contract.
- **`fix: inbox-list fallback re-resolves token + URL-encode properly`** ([e4dbb57](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/e4dbb57)) — pre-token can expire mid-poll between the delta call and the fallback; fallback now calls `getValidToken` itself.

**THE encoding bug** (8h of "but the URL is identical!"):

- **`fix: inbox-list fallback URL must use %20 not + for spaces`** ([9dd7a6f](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/9dd7a6f)) — Microsoft Graph KQL silently returns 0 rows when `$orderby` / `$filter` values contain `+` instead of `%20`. `URL.searchParams.set` form-encodes spaces as `+`. The probe (which used manual concat + `encodeURIComponent`) returned 48 messages; the poller (which used `URLSearchParams`) returned 0 against the identical mailbox.
- **`fix: kill +/%20 encoding bug in search-mode + historical paths`** ([436ecca](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/436ecca)) — same bug in `pollInboxBySearch` + `pollInboxHistorical`; `mode` now surfaced on PollResult so we'd never lose another hour to "which path ran?"

**Multi-mailbox + KQL hygiene** (Alicia receives some Cognito notifications, the operator gets the rest while parallel-testing — the single-UPN env var couldn't cover both):

- **`feat: multi-mailbox poll via AUTOMATION_POLL_MAILBOX_UPNS`** ([9eefb3b](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/9eefb3b)) — comma-separated UPN list, optional `me` token for the operator's own inbox without `Mail.Read.Shared`. Per-base cursor (synthetic `${userId}::${base}` key). Aggregate counts on `bases_polled`.
- **`fix: strip wildcard senders from KQL search clause`** ([9e170db](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/9e170db)) — the porsche-classes filters include `@thewolfpack.agency` (any internal sender) and `@` (universal fallback) for client-side substring matching. Both break Graph KQL `from:` clauses (silent return-0). `isKqlSafeSenderPattern` keeps only `local@host` shapes; wildcards stay in the client-side filter list as defense-in-depth.
- **`fix: search-mode falls back to inbox-list when KQL returns 0`** ([82ab803](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/82ab803)) — Graph $search with delegated tokens against `/users/{upn}/messages` can silently return 0 even when the inbox genuinely contains matching mail. Drop to `?$filter=receivedDateTime ge` + client-side filter; privacy preserved by the same client-side filter.
- **`fix: skip cursor filter when search-mode fallback runs`** ([03e513a](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/03e513a)) — fallback's job is to surface history the cursor would otherwise skip; artifact-level dedup catches duplicates downstream.

**Window widening** (the operator wanted to populate past classes, not just next week's):

- **`feat(porsche-classes): widen active class window to -30 / +365 days`** ([82d1024](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/82d1024)) — was `{-7, +60}`. The Porsche Academy schedule ships months in advance; the dashboard was hiding ingested classes that landed past the 60-day horizon.
- **`feat: widen inbox-list fallback lookback from 7 to 30 days`** ([5503fbe](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/5503fbe)) — pulls a month of class mail per Run-now click instead of one week.

### Outcome

Final operator-side test: `Seen 96 · Matched 12 · Ingested 4 · Duplicate 5 · Quarantined 2 · 9676ms · mode=search`. Pipeline confirmed working end-to-end against both `homyk@` and `alicia@` mailboxes. The 2 quarantined emails were verified-correct rejections (Cognito "Shared Link" notifications + a "TEST Test" form entry, both legitimately empty of class data — operator declined to add a `subject_exclude` filter to suppress them since they document Cognito form lifecycle).

### Sharepoint upload (carried forward from 2026-04-26)

- **`fix(automations): upgrade Files.ReadWrite → Files.ReadWrite.All`** ([13fd533](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/13fd533)) — final piece of the SharePoint Graph permission chain.

---

## What didn't ship

- The operator declined the `subject_exclude` filter offered for the 2 Cognito noise quarantines — they prefer those visible as ongoing form-lifecycle signal.
- Multi-mailbox cursor cleanup: per-base cursor keys are stored as `${userId}::${base}` synthetic strings in the existing `delta_link` column. Schema migration to a proper per-base cursor table is the durable fix; works fine as-is.

## Validation

- 34 Jest tests pass on `inbox-poller.test.ts` (up from 31; multi-mailbox + fallback paths covered).
- `OperatorActions.test.tsx` 16 tests green.
- Full project `npm test` clean apart from pre-existing `export-pdf` + DOCX dispatcher failures unrelated to this work.

## Rollout

All commits live on `main`. Vercel auto-deploy was green throughout. The `AUTOMATION_POLL_MAILBOX_UPNS` env var was set to `alicia@thewolfpack.agency,homyk@thewolfpack.agency` via `vercel env add` (the legacy `AUTOMATION_POLL_MAILBOX_UPN` was removed since the plural takes precedence).
