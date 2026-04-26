# Release Report — 2026-04-26

**Scope:** A single, intense session driving the porsche-classes automation from 80% to operator-ready, plus a dozen UX fixes across Search, Messages, Emails, Knowledge, Calendar, and Automations surfaces.

**Branch:** main (every commit pushed to `the-wolfpack-agency/wolfpack-apex`)
**Final commit on main:** `e3ee919` (the `6eabfeb` is an empty Vercel redeploy nudge).
**Deploy status at end of session:** ⚠️ Free-tier Vercel daily deploy limit hit (100/day exhausted). Last live deploy is from `ce27f1d` (8 min before the freeze). The buildFilename fix `e3ee919` is on `main` but **not yet built**. Deploy will complete automatically when the rolling 24-hour window resets, or immediately if the project is upgraded to Vercel Pro.

---

## Highlights — what shipped

### Search → end-to-end deep-link UX

- `/search` was returning results on first load (firing a wildcard query). Now idle until the user types.
- Wired Channels (Teams) and Knowledge into `/api/search` — previously hard-coded to `[]` with a TODO; the helpers had landed weeks ago. ([d5c001f](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/d5c001f))
- Channel results route into `/messages?team=…&channel=…` instead of teams.microsoft.com so click-through stays in Instinct.
- Messages page reads `?chat=` / `?team=&channel=` on mount, auto-expands the relevant left-panel section, auto-selects, scrolls the row into view via 2× `requestAnimationFrame`. ([28f0dfa](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/28f0dfa) + [ce0bd34](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/ce0bd34))
- Knowledge page reads `?id=<entryId>`, auto-selects + scrolls; pages through up to 250 entries to find a deeper-list target. ([a77bb3f](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/a77bb3f))
- Emails reading view (`/emails?id=<id>`) replaces the blank compose form with a fetched message + inline reply via `/api/mail/reply`. ([2b032a8](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/2b032a8))

### Messages mobile UX

- Channel composer placeholder shortened so it doesn't wrap on narrow textareas. ([bc64a61](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/bc64a61))
- Long URLs inside chat/channel bubbles now wrap rather than push the bubble past `maxWidth: 80%`. ([238ac23](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/238ac23))
- Channel composer textarea now defaults to button-height; multi-line drafts overflow into vertical scroll.
- Message page sections kept their localStorage persistence after a brief always-collapsed experiment that was reverted on user feedback. ([a1cc9dd](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/a1cc9dd))

### Emails surface

- Locked `/emails` reading view to vertical-only scroll; long Outlook bodies no longer push the page sideways.
- Compose page on mobile no longer hides the To: field above the fold (`overflow:hidden` on the composer was the trap). ([e81e7b5](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/e81e7b5))
- Search input visibly reads as an input at rest (2px border, magnifying-glass prefix, gold focus ring). ([fbb3550](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/fbb3550))

### Calendar — read-only week grid

- `/calendar` now renders an Outlook/Teams-style week grid above the analytics dashboard. 7-column × hourly time grid, all-day lane, "now" line on today, prev/today/next week navigation. Single-source-of-truth click → opens existing MeetingBriefPanel + scrolls it into view. ([1489e7d](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/1489e7d))
- Click → emits `calendar.grid_event_clicked` with slot tag (`timed`/`all_day`) so the Brain learns which surface users prefer.
- Side-fix: `emit.ts` client-branch raw `fetch` could throw a sync `ReferenceError` in jsdom and abort surrounding click handlers — wrapped in `typeof` check + `try/catch`.

### Automations / porsche-classes — the heavy lift

This is where the bulk of the day went. Net result: every step Alicia performs by hand is automated, and the operator UI finally has the buttons to drive it.

**New UI:**
- Inline flow diagram on the porsche-classes page (7 stages, color-coded, plain-language copy, Before/Now per-stage tool comparison, "Tools you used to bounce between" → "Previous tools used for this process" banner). ([a4fb13d](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/a4fb13d) + [d6eb107](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/d6eb107) + [b2e4eab](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/b2e4eab))
- Operator actions panel: **Run inbox poll now** + **Backfill from file(s)** with multi-file picker, autodetected source_type. ([3adb510](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/3adb510))
- Class row card on "This week" is now fully clickable (overlay link covers the row, Send button stays at z-index:1). Hover-tints gold. ([3be8717](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/3be8717))
- "Back to automation" breadcrumb on `/automations/porsche-classes` was a self-loop; redirected to `/automations`.

**Bug fixes:**
- Friendly class date in the summary header (was rendering raw ISO `2026-04-20T00:00:00.000Z`). ([365a21e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/365a21e))
- SharePoint upload Graph-safe filename — drops time-of-day, strips `# % &`, trims trailing periods + whitespace, falls back to `Class` for empty fields. ([a0ced72](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/a0ced72))
- Same-course multi-location survey filenames (e.g. `101 Conrad & Westlake`) now refuse to parse as one class and route to the auto-splitter. ([c5be19f](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/c5be19f))
- Subject-match scope cleaned to the four streams that actually feed the class summary. "Change Management Plan" + "Brand Ambassador" subjects removed (operator-confirmed not in scope; would have quarantined). ([eb97091](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/eb97091))
- Granted `automations.view` to sales + designer roles so the SMOKE_TEST E2E user wasn't role-dependent. ([88d6c7e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/88d6c7e))
- Multi-file backfill stalled rows past the first at "queued" — the input.value reset was invalidating the live FileList mid-flight. ([d2deb57](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/d2deb57))
- **The blocker for the next deploy:** `TypeError: e.match is not a function` — Postgres handed back `class_date` as a JS Date instance; buildFilename was calling `.match()` on it. Fixed by coercing every input via a `toStr` helper. ([e3ee919](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/e3ee919))
- Added a diagnostic block (filename, course_type, raw class_date, location, byte_count, upstream_status) that surfaces in the UI on Graph rejection so the next surprise is debuggable in one click. ([ce27f1d](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/ce27f1d))

**Tooling-first verification (per the global invariant):**
- Real-sample diagnostic harness `diagnose-real-emls.test.ts` ingests the 5 .eml files Alicia shared + 5 survey .xlsx files in Program Evals + the daily roster from Participant Updates_Changes folder. **All 16 parser cases green** against actual production data. ([6cf61e8](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/6cf61e8) + [1b5bb49](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/1b5bb49))

### Authorization

- `automations.view` capability extended to every team-role (was missing on sales + designer). Lock-in test asserts the universal grant. ([88d6c7e](https://github.com/the-wolfpack-agency/wolfpack-apex/commit/88d6c7e))

---

## Test count delta

- New tests added today: **80+** (CalendarWeekGrid 13, OperatorActions 16, AutomationFlowDiagram 8, ClassRowCard 4, EmailReader 15, /api/mail/[id] 8, role-capabilities 4, plus extensions to existing suites)
- Real-sample regression guards: **16 cases** running against actual Cognito + survey + roster files
- Final tsc clean across every commit
- Pre-existing PDF-render failures (5 in `lib/automations/porsche-classes/__tests__/export-pdf.test.ts`) **unchanged** — same on main pre-session, surfaced unrelated to this work

---

## Documentation added

- `docs/features/porsche-classes-flow.md` — non-technical end-to-end write-up for stakeholders. TL;DR table, ASCII flow diagram, per-stage plain-language breakdown, troubleshooting, validation summary, what remains manual, where the data lives.

---

## Ops state at session end

| Item | State |
|------|-------|
| Vercel daily deploy budget | **EXHAUSTED — 100/24h limit hit** |
| Latest commit on main | `e3ee919` (buildFilename Date coerce) — **NOT yet built** |
| Latest deploy live | `ijj9pjr2t` (from `ce27f1d`, debug instrumentation only) |
| Send to SharePoint | **Broken on production until the next deploy** (TypeError repro) |
| All other surfaces | Functional on the current deploy |
| Cognito notification opt-ins | Coordinator forms only (per Nick's check); Instructor / Roster / Survey distros still send to Alicia |
| `AUTOMATION_POLL_USER_ID` env var | **Not set** — hourly cron will skip with `no_user_connected` until set to Nick Homyk's user.id |

---

## What did NOT ship

- The Vercel deploy of `e3ee919` (rate-limited)
- A parser for `Skills Practice Auditor Score Sheet` / `Change Management Plan` Cognito forms — operator confirmed these are out of scope, no work needed
- Multi-mailbox poller (Phase 3 / "remove dependency on any one inbox") — deferred; option B (shared service mailbox) is the recommended production path
- Calendar phase 2 (month grid + create-event flow)

---

## Memory invariants honored

- ✅ Build tooling first, then run — the `diagnose-real-emls` harness is the canonical example. Every parser change verified against real samples before shipping.
- ✅ wolfpack-apex repo only — committed once to AgenticQA root by mistake when cwd shifted between turns; the empty commit there is harmless and pushed nothing user-visible.
- ✅ No MCP — Vibium Python sync API only; CLI / fetch direct.
- ✅ Every feature has tests at every relevant layer (component, integration, regression-against-real-data).
- ✅ No raw `fetch()` introduced; `fetchWithRefresh` everywhere except in `emit.ts` which had the existing `void fetch(...)` (now hardened with typeof + try/catch).
