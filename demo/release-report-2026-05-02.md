# Release Report — 2026-05-02

**Repo:** the-wolfpack-agency/wolfpack-apex
**HEAD:** `8f08208`
**Deployed:** https://wolfpack-instinct.vercel.app

## Headline

Operating Principles platform expanded from a 5-validator scaffold into a full team-scoreboard product: 5 new evaluator binds, 3 calendar validators for two new principles, real Microsoft sign-in flow that unifies auth + Graph access in one click, app-only Graph foundation (flag-gated, currently off), the SharePoint write-back leg for the weekly report cron, and a hard rebuild of the team-member identity layer (UNIQUE-on-email constraint, orphan dedup, canonical-id resolution at every read site). 31 commits, 8 migrations (121–128), one DB-level data-integrity guard that prevents the entire principles set from getting mass-retired by an empty SharePoint parse.

Not all of it landed gracefully. See the **Day-end honest assessment** at the bottom.

## Migrations

| # | Title | What it does |
|---|---|---|
| 121 | `principle_weekly_doc_uploads` | Audit table for the SharePoint write-back leg of the weekly report. One row per upload attempt (status / reason_code / web_url / etag / byte_count). |
| 122 | `principle_observations_dedupe` | UNIQUE expression index on `(principle_id, validator_id, COALESCE(subject,''), COALESCE(subtype,''), observed_at, COALESCE(sourceId,''))`. Pre-existing duplicates removed. ON CONFLICT DO NOTHING in `insertObservations` makes idempotent. (Initial version used `date_trunc('minute', observed_at)` and was rejected with PG 42P17 — IMMUTABLE requirement; rewritten to use raw `observed_at` since application-side `snapToOrgDay` already provides determinism.) |
| 123 | `principle_observations_cleanup` | Cleanup pass — TRUNCATE accumulated rows produced by pre-fix code (incl. duplicates from concurrent runs and per-user fan-out of team-wide validators). Re-asserts the unique index. |
| 124 | `principle_observations_resnap` | Second cleanup. Migration TRUNCATEs again so cron repopulates against the corrected `focus_block_ratio` iteration (Dallas-calendar-day walk, not UTC + 24h) and the corrected `meeting_outcome_logged` tier function (`scoreOutcome`). |
| 125 | `seed_wolfpack_team` | Seeds `instinct_team_members` rows for the 7 team seats: Hoxsie (CEO), Jorge (VP), Max (EVP), Meghan (CCO), Alicia (Program Director), Ashley (Project Manager), David (Instructional Designer). Includes `ALTER TABLE ... DROP NOT NULL` on `password_hash` so MS-sign-in primary accounts can land NULL. Idempotent. |
| 126 | `team_members_role_fix` | Inserts Nick Homyk row (was missing from 125) with `role='cto'`. Corrects any pre-existing row that landed as `'ops'` from a prior MS-signin upsert. |
| 127 | `principles_unretire_orphans` | Restores principles that were retired by an empty-parsed-set sync (the 2026-05-02 data-integrity incident — see below). For each slug whose most-recent row is retired AND there is no currently-active row, sets `retired_at = NULL`. Pairs with the `WriteQueryError(empty_parsed_set)` guard in `syncPrinciplesFromParsed`. |
| 128 | `team_members_dedupe_and_unique` | Merges duplicate `instinct_team_members` rows by `LOWER(email)`, repoints `instinct_ms_tokens.connected_by` to canonical id, TRUNCATEs observations, deletes non-canonical rows, adds the `UNIQUE INDEX ... ON LOWER(email)` constraint that should have shipped in migration 001. Step 2a dedupes ms_tokens BEFORE repointing to avoid colliding with the existing UNIQUE-on-connected_by index. |
| 129 | `personal_signals_for_team_principles` | Adds 9 per-member signal lines to **Define Done**, **Red Early = Respect**, and **Pushback is Expected** (3 each). Each new row binds at evaluate time to a per-user validator (`tasks.weekly_finish_rate`, `tasks.weekly_priority_count`, `tasks.overdue_rate`). Idempotent on description match. validator_id stays NULL on insert; eval-runner resolves at runtime. |

## New validators

10 new bindings shipped today across three commits:

| Validator id | Surface | What it scores | Backs principle |
|---|---|---|---|
| `tasks.weekly_priority_count` | tasks | High-importance active task count vs cap (3) | Fewer Priorities |
| `tasks.weekly_finish_rate` | tasks | Ratio of (created in window) → (completed) | Finish Strong, Define Done, Red Early, Pushback |
| `goals.kr_friday_status` | goals | Active KRs without a contribution row this window | Define Done, Red Early, Pushback (team-wide) |
| `calendar.meeting_outcome_logged` | calendar | Past meetings with decision/action/next-step markers in body | Reality Over Optics, Calendar Hygiene |
| `calendar.recurring_meeting_drift` | calendar | Recurring series ≥3 instances with <50% outcome notes | Finish Strong |
| `calendar.meeting_density` | calendar | Business-hours meeting count per user per window | Async Default, Calendar Hygiene |
| `calendar.meeting_agenda_present` | calendar | Upcoming meetings with agenda markers in body | Async Default |
| `calendar.declined_attendance_rate` | calendar | Past events with `responseStatus='declined'` or `tentativelyAccepted` | Calendar Hygiene, Direct Over Delayed |

Plus 3 existing validators marked `teamWide: true` (goals.kr_measurability, goals.kr_friday_status, code.pr_cycle_time_under) so they emit ONCE per evaluation under `subject_user_id = NULL` and surface as `(team-wide)` rows on the scoreboard instead of duplicating under each member.

## Auth / identity

- **Unified Microsoft sign-in.** New `getSigninAuthUrl()` + `POST /api/auth/microsoft-start` + signin-flagged state envelope (`signin:<nonce>`). The existing `/api/microsoft/callback` now branches on state shape: signin path domain-gates to `@thewolfpack.agency`, upserts the team-member row, mints an Instinct JWT + refresh token, sets HttpOnly cookies, redirects to `/`. Same shape as `/api/auth/login`.
- **Login UI.** "Sign in with Microsoft" button above the email/password form. Password form retained per the transition plan.
- **`/api/auth/whoami`.** Reads the access-token cookie, returns `{ token, user }` so the dashboard layout can hydrate localStorage from the HttpOnly cookie after MS sign-in. Self-heals stale user-id sessions: when the token's userId is no longer in `instinct_team_members` (e.g. after migration 128 dedup), looks up by email and re-mints the JWT under the canonical id.
- **Dashboard layout.** Calls `/whoami` on every mount; replaces localStorage if token/id has changed since last login.

## App-only Graph foundation (FLAG-GATED, currently off)

Foundation only — turned OFF in production after a 401 incident.

- `getAppOnlyToken()` — client-credentials flow + 1-hour cache.
- `getReadTokenForUser(userId)` orchestrator — returns `{ accessToken, isAppOnly, userPath }`. Tries app-only first when `INSTINCT_GRAPH_APP_ONLY=true`, falls back to delegated.
- `graphPathForReadToken()` — `/me/{x}` ↔ `/users/{email}/{x}` switch.
- `mail.after_hours_send` validator converted as proof-of-concept; other 9 validators still on delegated.

**Status:** flag set to `false` in Vercel after deploy revealed Azure tenant-admin Application-permission consent has not been granted-with-effect yet (Graph token issue succeeds, Graph data calls 403). The flag stays off until consent is verified in Azure portal. When ready, set `INSTINCT_GRAPH_APP_ONLY=true` and redeploy. A probe-and-fallback pattern (detect 401/403 from app-only Graph calls, fall back to delegated) is queued for next session before re-enabling.

## SharePoint write-back

`POST /api/cron/principles-weekly-report` now:
1. Builds the markdown report (existing).
2. Persists to `instinct_principle_weekly_reports` (existing).
3. **(New)** Generates the Wolfpack Operating Principles weekly .docx via JSZip-only OOXML construction (no docx-js, no mammoth — per directive).
4. Uploads to the same SharePoint folder as the source principles doc via Microsoft Graph PUT.
5. Records audit row in `instinct_principle_weekly_doc_uploads` (migration 121) with status / reason_code / byte_count / web_url.
6. Emits one of three new `InstinctEventType`s: `principle.weekly_report_uploaded` / `_upload_skipped` / `_upload_failed`.

Best-effort — failure of the SharePoint leg never rolls back the markdown row. Full coverage in `src/lib/principles/__tests__/sharepoint-write.test.ts`.

## UI

- **"Evaluate all"** button on the SharePoint config bar at the top of `/principles`.
- **"Run all"** button next to "+ New principle" in the Manage principles section. Both hit `POST /api/principles/evaluate-all` and ride the per-principle 60s→5s throttle.
- **Team-coverage banner** on the Team scoreboard: "X of Y team members connected — not yet: …" (filters out `@wolfpack.dev` demo accounts).
- **Dallas timezone** for all calendar/mail validators (`ORG_TZ = "America/Chicago"`, override via `INSTINCT_ORG_TZ`).
- **Date-only rendering** for daily-rollup observations (focus_block_ratio, meeting_density, weekly_priority_count, etc.) — no more bogus 8:00 PM time on calendar-day rows.
- **Empty-state copy** swap: when a principle has only team-wide rows for the logged-in user, message reads "No personal observations — N team-wide observations this week (see Team scoreboard)" instead of the misleading "keep it up."
- **Subheader** updated: "Edited directly in Instinct; every change is versioned in the audit log" (was "synced from the canonical SharePoint doc").
- **`scoreLabel` / `scoreColor`** boundary fix: `<= -0.3 → drift`, `>= 0.3 → adherence` (was strict `<` and `>`, off-by-one made -0.3 render as "neutral").
- **`meeting_outcome_logged` tier function (`scoreOutcome`)**: long agenda invites (≥150 chars meaningful body without explicit recap markers) score `0` (neutral) instead of `-0.3` (missed). Reduces false drift on rich invites that weren't appended-to post-meeting.

## Data integrity

- **`syncPrinciplesFromParsed` mass-retirement guard.** The function used to retire every active principle when called with an empty parsed set (which happens whenever the SharePoint parser returns `[]` — stale URL, missing doc, parser error). One incident this morning retired all 10 of Hoxsie's principles. Migration 127 restored them via `retired_at = NULL` on the most-recent row per slug. Going forward the function throws `WriteQueryError("empty_parsed_set")` rather than silently nuking everything.
- **Observation idempotency.** Migrations 122/123/124 lock down `instinct_principle_observations` with a UNIQUE expression index on the natural key + `INSERT ... ON CONFLICT DO NOTHING` + application-side `snapToOrgDay` for rollup observed_at. Two cron firings in the same Dallas day produce ONE row.
- **Team-member identity.** Migration 128's UNIQUE-on-`LOWER(email)` index closes the door that allowed multiple `instinct_team_members` rows to share an email (which fanned per-user evaluators 4× for the same person).
- **Aggregate canonicalization.** Both `/api/principles/team` and `/api/principles/me` now canonicalize subject_user_ids through a DB CTE (team_members → ms_tokens → re-resolve by LOWER(email)) so any historical-id observation rolls up cleanly into one row per real person.

## Tests

237+ across 23+ suites in `src/lib/principles/__tests__/`. Touched suites all green at end of session. New cases this release:

- Validator scoring: `scoreForPriorityCount`, `scoreForFinishRate`, `scoreOutcome`, `scoreSeries`, `scoreForMeetingCount`, `scoreForDeclinedCount`.
- App-only Graph: `getAppOnlyToken` (no-tenant / no-creds / 401-no-consent / cache hit), `getReadTokenForUser` (flag off / app-only happy / consent-missing fallback), `graphPathForReadToken` (delegated / app-only / leading-slash strip).
- Dedupe: `insertObservations` collapses identical input rows; preserves distinct-sourceId rows.
- Throttle: concurrent `evaluatePrinciples([principle], { forceBootstrap: true })` calls share one run; follow-up within cool-down emits `principle.evaluation_skipped(reason=throttled)`.
- Self-heal: `/api/auth/whoami` re-mints when token's userId is missing from team_members.
- Empty-parsed-set guard: `syncPrinciplesFromParsed` refuses with the right error code.
- Sharepoint write-back: round-trips OOXML through the existing JSZip parser; covers all Graph response surfaces (403/404/500/network).

## Day-end honest assessment

20+ "fix" deploys today. Some unavoidable (deploy errors only catchable in Vercel's full build); most preventable. Three failure modes worth naming:

1. **Type errors only catchable by full `tsc --noEmit`**: shipped a `WriteQueryError("empty_parsed_set")` literal that wasn't in the union. Caused one Vercel build-fail. Fix: run `tsc --noEmit` locally before every push when touching cross-file type contracts.
2. **Migration ordering vs constraint shape mismatches**: 23502 (NOT NULL on password_hash), 42P17 (date_trunc not IMMUTABLE), 23505 (UNIQUE-on-connected_by violation during repointing). Each was caught only at deploy time. Fix: run migrations against a local PG dev branch before pushing structural changes.
3. **Theory-driven debugging when prod state was the missing input**: see `feedback_get_runtime_data_first.md` (just added). One-hour Saturday burn finished with the realization that Hoxsie was logged in as the demo CEO seed account, not his real Microsoft account. localStorage value was always one paste away. Eight deploys' worth of speculative fixes shipped before that paste landed.

## Open follow-ups (not blocking, deferred)

- **Hoxsie sign-in correction (Monday).** Hoxsie's session is still on `demo-ceo` (migration-001 demo seed). On Monday he should sign out + sign in with the Microsoft button using `nick@thewolfpack.agency`. His My-principles tab will populate against his real subject id.
- **Demo accounts hardening.** One-line migration that sets `is_active = FALSE` on `instinct_team_members` rows where `email LIKE '%@wolfpack.dev'`. Hides them from the MS-signin upsert lookup and prevents the demo password login from creating a fake authenticated session that misses real data. Safe ship Monday.
- **App-only probe-and-fallback.** Before re-enabling `INSTINCT_GRAPH_APP_ONLY=true`, add a startup probe that hits `/users/{me}/mailFolders/sentitems` with the app-only token. If it returns 401/403, mark app-only as unavailable for the process and use delegated. ~15 min of work.
- **Convert remaining 9 validators to the `getReadTokenForUser` orchestrator** once app-only is verified working. Enables the 5 unconnected team seats to have data without each one OAuthing personally.
- **Dependabot:** GitHub flagged 2 moderate vulns on default branch (pre-existing all session, mentioned in every push). Worth a triage Monday.
- **Stale meeting_agenda_present scoring** for "MEGS OOO" / vacation-style events. Empty-body OOO holds correctly score drift but they're not really meetings; consider filtering on `showAs='oof'` in the validator.
- **`tasks.weekly_priority_count` zero-priority adherence**: emits +0.5 for "0 high-importance active tasks" — semantically dubious. Tier should probably consider absent + present states differently. Worth tightening.

## Pickup checklist for next session

1. Read this report + the handoff doc.
2. Confirm Hoxsie has logged in via Microsoft (his My-principles tab populates).
3. Pick from the open follow-ups above; the demo-account hardening + app-only probe are the highest-yield small wins.
4. Before any code change to authenticated routes, get prod data first per `feedback_get_runtime_data_first.md`.
5. Before any structural migration, dry-run against a local PG.
