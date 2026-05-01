# Wolfpack Instinct — Release Report
**Date:** 2026-05-01
**HEAD commit:** `00a7461`
**Deployed:** https://wolfpack-instinct.vercel.app
**Repo:** the-wolfpack-agency/wolfpack-apex

---

## Headline

Shipped the **Operating Principles platform** end-to-end (13 PRs from spike → real validators → leadership scoreboard → weekly auto-report → native in-app CRUD), plus the **Cost Budget platform** with WPA xlsx round-trip, customizable per-user left nav, and three closes-the-loop fixes that finished yesterday's open threads (QR per-scan attribution detail view, Outlook animated signature import, signature-detect graph 400). 20 PRs merged, 8 new migrations (112, 114, 115, 116, 117, 118, 119, 120), 17,864 LOC added, 37 test files touched, 220+ new test cases.

Side stream: **wolfpack-aidan-mulready v2** copy refresh + 5 follow-up fixes (6 PRs).

---

## What shipped — Wolfpack Instinct (PRs #73 – #92)

### Operating Principles platform — 13 PRs (#78 – #90)

Hoxsie maintains a SharePoint `Wolfpack_Operating_Principles_and_Scoreboard.docx`. Instinct now parses that doc, evaluates every member of the org against its principles, and reports back. End-to-end:

- **#78 — SharePoint .docx parser spike + Hoxsie explainer doc.** Plain-English principle format with `## Principle:` / `**Domain:**` / `**Signal:**` / `**Counter-signal:**` markers. Explainer doc at `docs/principles-explainer.md` is paste-ready into the top of the SharePoint document.
- **#79 — Schema + sync cron + validator framework + 5 starters.** Migration 116 (`instinct_principles`, `instinct_principle_signals`, `instinct_principle_observations`). Sync cron (`/api/cron/principles-sync`) re-reads every 2hrs. Validator framework + 5 starter validator stubs.
- **#80 — Leadership control plane + per-user fan-out evaluator.** Migration 117 (audit views). Evaluator iterates every user in the org and applies every active principle's validators — single org-wide pass, observations stored per (user, principle, signal).
- **#81 — `/principles` UI.** Member view (your principles, your evidence) + leadership team scoreboard with per-user drill-down at `/principles/team/[userId]`.
- **#82 — Finalize: 4 real validators + names + drill-down + bootstrap baseline.** Replaced 5 stubs with 5 real validators that hit live data:
  - `calendar.focus_block_ratio` — Outlook calendar
  - `mail.after_hours_send` — Outlook mail
  - `tasks.overdue_rate` — Planner / To Do
  - `goals.kr_measurability` — Instinct's own Goals system
  - `code.pr_cycle_time_under` — GitHub
- **#83 — Weekly auto-report.** Migration 118 (`instinct_principle_weekly_reports`). Cron builds a Monday-morning report per principle with ranked evidence; surfaces in the leadership banner. Closure loop per the explainer doc.
- **#84 — Self-service config.** Migration 119 (`instinct_principles_config`). Paste a SharePoint URL + click Sync — no env vars, no redeploy.
- **#85 — Surface real sync error + collapse setup UI when configured.** Setup card auto-collapses once the URL is set; sync errors show the actual upstream message instead of an opaque "failed".
- **#86 — Replace mammoth with direct JSZip+regex .docx extractor.** mammoth blew up on the live SharePoint file; ~150 LOC JSZip+regex extractor handles it cleanly with zero new deps.
- **#87 — Accept plain-text + inline-listed field markers.** Hoxsie wrote `Domain: code, comms` instead of `**Domain:** code, comms` in one principle. Parser now tolerates both bold and plain markers, and inline `Signal: ... Signal: ...` on one line.
- **#88 — Native CRUD: create / edit / retire principles in-app.** No SharePoint required to author. `/principles` + new admin actions write directly to `instinct_principles`.
- **#89 — Fan out evaluation across the org on create / edit.** Editing a principle in-app immediately re-evaluates the org against it instead of waiting for the next sync.
- **#90 — Persist `observed_at` per row + surface metric in evidence.** Drill-down evidence tiles now show "value=42% on 2026-04-28" rather than just the principle title.

**Surface count:** 5 cron routes, 12 API routes, 2 UI pages, 14 lib modules (parser, store, evaluators, weekly-report, sharepoint-fetch, user-names, config, authz, validators, evaluate-runner, users-iterator, parser-slug, user-nav-prefs-bridge, built-in-validators), 14 test suites covering ~189 cases.

### Cost Budget platform — 1 PR (#92)

End-to-end multi-tenant cost budget tool with the WPA template format Hoxsie already uses in Excel.

- Migration 120 (`instinct_program_budgets`, `instinct_program_budget_lines`, `instinct_program_budget_actuals`).
- `src/lib/programs/budget-store.ts` (835 LOC) + `budget-xlsx.ts` (541 LOC, full WPA template parser/builder).
- 8 API routes: list, detail, lines CRUD, actuals, export-xlsx, import-xlsx.
- UI: `/programs/budgets` (list) + `/programs/budgets/[id]` (detail with line-item editor, 602 LOC).
- Round-trip preserves WPA template formatting — Hoxsie can export, edit in Excel, re-import.
- 24 lib + 8 API test cases (35 total).
- Test fixture: `test-fixtures/wpa-cost-budget-template.xlsx`.

### Dashboard customizable left nav — 1 PR (#76)

- Migration 115 (`instinct_user_nav_prefs`).
- `src/lib/user-nav-prefs.ts` (163 LOC).
- Per-user reorder + hide/show of left-nav items. Persists across sessions.
- Action-item emails now deep-link directly to the relevant nav target (e.g. `/email?openMessage=<id>`).

### Closing yesterday's open threads — 3 commits + 2 PRs

- **`c4dc20a` — QR per-scan attribution detail view + migration 112.** Closed the open thread from yesterday's handoff. Added `assistant.qr_scan_detail_viewed` to `InstinctEventType`, finished `/api/qr/[id]/scans/route.ts`, ran migration, restored the `View all scans` panel on `/qr`.
- **`e11d9ac` — Import animated signatures from Outlook + drop template description boilerplate.** Detection plumbing from yesterday now has UI + import flow. Animated signatures (img with Outlook CID) are preserved, not stripped.
- **#73 — Graph 400 on signature detect + mobile compose buttons + hide `/sites` from nav.** Detection request body shape was wrong; mobile compose button was hidden under safe-area inset.
- **#75 — Preserve body when over-eager strip would zero it.** Signature stripper was eating the entire body on threads with very short replies. Guard: never zero the body.

### Other fixes

- **#74 — Client toast copy.** "Client created!" was firing on update + delete. Fixed to "Client updated" / "Client deleted".
- **#77 — Restore lint baseline.** Ignore `.claude` worktrees + suppress two unstable rules that were spamming PR diffs.
- **#85 (also)** — Setup UI collapse when configured.
- **#91 — Insights Quick Actions: accept bare page names.** Quick-actions normalizer was rejecting `/qr` style pages (only the long form worked). Now accepts both.

---

## What shipped — wolfpack-aidan-mulready (separate repo)

6 PRs on the personal-pilot site (Aidan):

- **#2** — v2 copy refresh: CRJ-900 hero, expanded pilot bio, DPN A permit. Includes Playwright contract guards (h1 + `/contact` CTA).
- **#3** — Canonical h1 + Partner With Us CTA → `/contact` (unblocks Playwright).
- **#4** — Pilot panel min-height clamp (driver story was collapsing on tall viewports).
- **#5** — Hide `/admin/images` from left nav.
- **#6** — Wire Download Media Pack to a real press zip.
- **#7** — Drop self-URL link from footer (domain is live; circular link).
- Plus `docs(contributing)` doc explaining the GitHub PR + Vercel preview workflow for Max.

E2E suite expanded: `admin-heatmaps`, `admin-images`, `admin-insights`, `designer-index`, `driver-pilot-toggle`, `footer-social`, `home`, `media-pack`, `side-pages`.

---

## Migrations added

| # | Name | Notes |
|---|---|---|
| 112 | `qr_scans_extended` | Per-scan attribution columns (closed Apr-30 thread) |
| 114 | `email_signatures_body_format` | Animated signatures (HTML body format) |
| 115 | `user_nav_prefs` | Customizable left nav |
| 116 | `principles` | Schema for principles + signals + observations |
| 117 | `principles_audit_views` | Read-side views for the leadership control plane |
| 118 | `principle_weekly_reports` | Monday auto-report storage |
| 119 | `principles_config` | Self-service SharePoint URL config |
| 120 | `program_budgets` | Cost budget platform |

All have matching `.down.sql`. `npm run vercel-build` runs `migrate.mjs` so they apply automatically on next deploy.

---

## Architecture decisions worth remembering

- **Operating Principles is read-from-SharePoint AND write-from-app.** The doc is the source of truth, but in-app CRUD also writes back to `instinct_principles` directly. Sync cron is non-destructive: doc-side adds/edits become principles, but in-app principles are never overwritten unless they have the same slug.
- **JSZip+regex beats mammoth for SharePoint .docx.** mammoth pulled in 600KB of XML parsing and still choked on Hoxsie's actual file. Direct extraction of `word/document.xml` + regex over `<w:t>` runs is 150 LOC and handles every real-world .docx so far. Pattern: prefer minimal hand-rolled parsers over bloated parser libs when the input format is constrained.
- **Validator framework is just `(userId, principle) => Observation[]`.** Each validator is a single file in `src/lib/principles/evaluators/`. Adding a new validator = drop a file + register its `id` in `built-in-validators.ts`. No framework boilerplate. New principles get matched to validators by `id` strings written in the SharePoint doc.
- **Org-wide fan-out on every edit.** When a leader edits a principle, we synchronously re-evaluate the org against it (not just the editor's own user). Cost is OK because the org is small and validators are cheap; trade-off chosen for instant feedback over throughput.
- **Per-row `observed_at` is required.** Storing only the latest observation flattens trends and makes "this principle is being ignored for 3 weeks" impossible to detect. Migration 116 stores every observation; analytics roll up from there.
- **WPA xlsx is a real schema, not free-form.** `budget-xlsx.ts` knows the WPA cost-budget template's named ranges, tab order, and formula columns. Round-trip preserves all of them so Hoxsie's existing Excel workflow is unbroken.
- **Self-service config > env vars.** Adding a SharePoint URL via the UI (PR #84, migration 119) means a leader can wire up a new principles doc without redeploy. Same pattern should be applied to any future "this needs a URL" feature.

---

## Test coverage added

- 14 principles test suites covering parser, store, validators, evaluators (5), evaluate-runner, weekly-report, authz, user-names, calendar focus, mail after-hours, code cycle time, goals KR, tasks overdue. 189 cases.
- 4 programs/budget test suites. 35 cases.
- Plus E2E + API tests on dashboard nav prefs, QR scans detail, signature detect.

Total ~224 new test cases on top of yesterday's baseline.

---

## Known gaps / not done today

- **Outlook signature import UX** is functional but unstyled — the detected signature renders as raw HTML in the Settings card. Visual polish next session.
- **Principles weekly auto-report** runs on schedule but the `Wolfpack — Last Week vs Operating Principles.docx` write-back to SharePoint is not yet wired (the explainer promises this; today only the in-app version of the report exists).
- **Principles UI on mobile** is functional but cramped — leadership scoreboard table needs a card-mode breakpoint.
- **Cost Budget actuals import** is one-shot CSV/xlsx; no recurring/scheduled actuals sync yet.
