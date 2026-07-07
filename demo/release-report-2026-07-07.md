# Wolfpack Instinct, Release Report 2026-07-07

## TL;DR

Two client-facing capabilities shipped to production on `wolfpack-instinct.vercel.app`. **(1) The Invoice Tracker**: a single `/invoices` hub that unifies the existing AP invoice upload/scan queue ("Vendor Invoices") with a new **read-only, live SharePoint mirror** of PCNA's budget & SOW "Summary" workbook, modeled on `/job-codes`, gated to three named finance viewers, cross-tenant-safe (read via the viewer's Microsoft token), and config-driven so the next company is one entry. **(2) Deployment notifications actually fire now**: the release-gate notifier was fully built but its cron was never listed in `vercel.json`, so it never ran and nothing ever reached the notification bell, scheduled it, retuned the notify policy to per-state thresholds (so "changes waiting to deploy" and "tests failing - fix needed" both surface), and added a coverage guardrail that immediately caught a second orphaned cron (`principles-weekly-report`). All anti-spam protections from the prior email-spam incident were left intact.

## Commits (this session → main)

### Features

| SHA | What |
|---|---|
| `99332902` | **feat(invoices): read-only PCNA invoice tracker mirroring SharePoint (#133).** Config-driven tracker registry (`src/lib/invoice-tracker/`), generic SharePoint-workbook reader (delegated viewer token first for cross-tenant PCNA, app-only fallback), 10-min cache (migration `218`) with serve-stale-on-Graph-failure so the page never blanks, explicit per-tracker email allowlist (homyk / nick / jorge), and `invoice_tracker.*` analytics on every view/refresh/denial. |

### Fixes

| SHA | What |
|---|---|
| `bb0b560f` | **fix(invoices): land the hub rework #133 merged without (#134).** The first cut added a *second* "Invoices" nav item pointing at a new `/invoices`, shadowing the existing AP upload page. Reworked into one `/invoices` hub with **Vendor Invoices** (the existing `InvoicesPanel`) + **PCNA** as sub-pages, breadcrumbs on both, `/finance/invoices` → `/invoices/vendor` redirect (single mount, DRY), and an OR-gated nav (finance roles OR the PCNA viewers). PCNA table restyled to match `/job-codes` (search, freshness chip, gold refresh, source link). |
| `99e89541` | **fix(deploy): schedule the release-gate notifier so deployment activity hits the bell (#135).** Root cause: `/api/cron/release-gate-check` existed and was tested but was never in `vercel.json` crons, so Vercel never fired it → zero notifications. Scheduled it `*/30`. Replaced the single "ready_to_merge/awaiting_approval past 4h" rule with a per-state threshold map (`ready_to_merge` prompt, `awaiting_approval` 4h, `checks_failing`/`merge_conflict` 8h stall, `checks_running` never). Added `cron-schedule-coverage.test.ts` guardrail, which caught `principles-weekly-report` also orphaned (scheduled `0 8 * * 1`). Every anti-spam guard (email off by default, 6h cooldown, fail-closed dedupe, per-run cap) untouched. |
| `4a3077d2` | **fix(feedback): exclude E2E smoke-test noise from the inbox.** The `smoke-e2e@` "E2E SCREENSHOT FLOW" rows flooded the newest-200 window and buried real CEO feedback; the inbox query now excludes them. |
| `74a46deb` / `5e2ee415` | **fix(feedback): reader sees EVERY note (not workspace-scoped).** Feedback readers now see submissions across every workspace they read, not just their own. |
| `faf8371b` | **fix(mail): never send to undeliverable seed domains.** Stops the mailer-daemon bounces to `wolfpack.dev` seed addresses (undeliverable-recipients guard). |

## Numbers

| Metric | Value |
|---|---|
| PRs merged to main this session | 3 (`#133`, `#134`, `#135`) + feedback/mail fixes |
| New migrations | 1 (`218_invoice_tracker_cache`) |
| New analytics events | 4 (`invoice_tracker.viewed/refreshed/refresh_failed/access_denied`) |
| New guardrail tests | 1 (cron-schedule-coverage) + invoice suite (config/parser/resolver/route/UI/hub/breadcrumbs) |
| Orphaned crons found + scheduled | 2 (`release-gate-check`, `principles-weekly-report`) |
| Full suite | green (~13,894 tests) |
| tsc / lint / `scan:tenant-isolation` | clean / clean / `unclassified: 0` |

## What's measurably different in production

### Invoices (`/invoices`)
- One hub with sub-page cards for each surface the user can open: **Vendor Invoices** (AP upload/scan queue, finance-gated) and **PCNA** (read-only SharePoint mirror, viewer-allowlisted). More companies later = another card, one config entry.
- PCNA reflects the SharePoint "Summary" tab live, searchable, with a colored freshness chip and a manual "Refresh now"; a Graph failure serves the last-synced copy instead of blanking, and a cold-cache failure surfaces as a clear error, not a silent empty table.
- Old `/finance/invoices` deep links (ScanInvoiceWidget, scan-invoice assistant tool, bookmarks) still work, they 308-redirect to `/invoices/vendor`.

### Deployment notifications (the bell)
- **Before:** the `/admin/deployment` page showed release activity but the bell never fired, the cron driving it was never scheduled.
- **After:** every 30 min the notifier sweeps the release gate and pushes an in-app notification (to the PR author + admins) when a change is **ready to deploy** (prompt), **awaiting approval** (4h), or a **stalled red / conflicted PR** (8h, the "tests failing - fix needed" case). Email stays opt-in.
- A cron-coverage guardrail now fails the build if any cron route is left unscheduled, the exact bug class that hid both of these.

## Cross-repo note (not Instinct)

Porsche **Experience OS** (`wolfpack-porsche-weekend`, `weekendwithporsche.com`) shipped this session too via manual `vercel --prod`: brand accent **Guards Red → Porsche Black** across `/admin`, and the floating assistant launcher iterated to a neutral chat glyph (crest/wordmark read as branding, not a control). That admin OS still lives on the unmerged PR #16 branch; the prod domain runs the branch build directly. Open decision: whether the **Pending** status chip should stay black or return to Guards Red.

**Aidan Mulready site** (`wolfpack-aidan-mulready`, `wolfpack-aidan-mulready.vercel.app`): a client asked for heatmap numbers past 30 days, so `/admin/heatmaps` gained **90d / 1y / All** range pills on top of 24h / 7d / 30d. Also fixed a latent API bug where any range over 90 silently fell back to 7d; large values now clamp to 366 and `days<=0` (or `days=all`) means all-time, still bounded by the existing `LIMIT 50000`. Shipped via `vercel --prod`; git synced by PR #8. tsc clean, 16 heatmap tests pass, verified the live prod bundle serves the new pills.

**Product enablement**: a shareable, non-technical **one-pager set** for the product line (Instinct, OGIAM / Agentic IAM, Agentic Workforce, Agentic QA, Beyond, Experience OS) was produced as a hosted Artifact for client and team use. Each product gets a plain-English dossier (what it is, who it is for, the problem, how it helps, a client one-liner, a status chip). Rewritten once to remove every em dash and de-market the copy per house style.

## Verify-on-deployed checklist (do before trusting green tests)

1. `/admin/deployment` → trigger a manual sweep → confirm bell notifications appear (or read the `{checked, notified, degraded}` JSON).
2. `/invoices/pcna` → confirm it renders PCNA's Summary against Nick's connected Microsoft account (cross-tenant delegated read).
3. `/invoices/vendor` and the old `/finance/invoices` redirect both land on the AP queue.
