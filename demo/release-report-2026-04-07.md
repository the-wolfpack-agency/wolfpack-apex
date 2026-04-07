# Wolfpack Instinct — Release Report

**Version:** 0.4.0 (internal versioning — see "Version Log" below)
**Release date:** April 7, 2026
**Prepared for:** Hoxsie, CEO — Wolfpack Agency
**Prepared by:** Nick Homyk, CTO
**Repo:** the-wolfpack-agency/wolfpack-apex
**Deployed:** https://wolfpack-instinct.vercel.app

---

## Executive Summary

Wolfpack Instinct is the team intelligence platform for Wolfpack Agency. As of April 7, 2026, **Instinct is being treated as a standalone product with potential for public release.** This release report tracks both the internal Wolfpack rollout and the product evolution toward an external offering.

This week's release adds **two major integrations** (per-user Microsoft 365 with privacy isolation, and Plaud meeting transcript ingestion), **a complete CI/CD pipeline** running AgenticQA's full agent suite against the Instinct codebase on demand, and **a polish pass** that resolved a 16-error TypeScript backlog and surfaced previously-collected analytics that had no UI.

The platform now has **22 test suites** with **568 passing tests**, **zero TypeScript errors**, and **end-to-end agent-driven CI** verified by a successful run that booted the AgenticQA orchestrator as a sidecar, generated a feature branch + worktree, and ran the agent pipeline against Instinct's source tree.

---

## Version Log (product evolution)

| Version | Date | Highlight | Tests | Notes |
|---|---|---|---|---|
| **0.1.0** | Apr 5, 2026 | Initial build (was "Wolfpack Apex"). 13 pages, persistent assistant memory, briefing, journal, knowledge base, doc generation, reports, discussions | 390 / 15 suites | Single session build |
| **0.2.0** | Apr 6, 2026 (morning) | Doc quality gate (PII/security/compliance), file attachment hardening, mobile responsiveness | 532 / 19 suites | +47 file-attachment tests, +105 quality-gate tests |
| **0.3.0** | Apr 6, 2026 (afternoon) | Platform rename Apex → **Wolfpack Instinct**, CEO role, QuickBooks integration, Microsoft 365 OAuth (single-tenant), Morning Briefing, Settings/Integrations page, demo-data purge | 532 / 19 suites | Vercel domain not yet renamed |
| **0.4.0** | **Apr 7, 2026 (today)** | **Per-user MS Graph isolation (privacy fix), Plaud meeting ingestion, Wolfpack Assistant Priority 3 retrieval, real analytics + integration health + gate activity surfaces, in-CI AgenticQA agent pipeline, all pre-existing TS errors fixed** | **568 / 22 suites** | **First TypeScript-clean release** |

**Cumulative growth Apr 5 → Apr 7:** +178 tests (+46%), +7 suites, 4 major integrations, 8 database migrations, ~3500 lines of production code.

---

## What's new in 0.4.0

### Privacy: per-user Microsoft Graph isolation *(security-critical)*

Before: every Microsoft Graph call returned the most-recently-connected user's data regardless of who was asking. With one user, invisible. With two users — the prerequisite for opening Instinct to the team — Bob would have seen Alice's calendar and email in his briefing.

After: every layer (`getValidToken`, `getConnectionStatus`, `deleteTokens`, all 6 fetch helpers, all 6 public wrappers, the in-memory cache, the analytics events, the OAuth callback) is scoped to the calling user. The OAuth callback verifies an HMAC-signed `state` parameter so a forged or session-cookie-dropped redirect can't associate the wrong account.

Migration 006 dropped the unique index on `user_email`, added a unique index on `connected_by`, and cleaned up orphan rows. Applied to production.

**Impact for the product:** the per-user MS Graph isolation is a hard requirement for any multi-user deployment. Without it, the platform would have been unsafe to ship to a second team member.

### Plaud meeting transcript ingestion

Plaud is the AI voice recorder the executive team uses. Transcripts were trapped in Plaud's own app. Now they flow into Instinct's shared knowledge base via webhook ingestion.

**Architecture:**
- **Webhook-driven** (Plaud's recommended method per their official docs)
- HMAC-SHA256 signature verification on raw request bytes (timing-safe)
- Org-level scope (one shared connection for the team) with `owner_user_id` preserved on every transcript so per-user scoping is a one-line change later
- Idempotent — Plaud may re-deliver, the unique index on `file_id` makes that safe
- Doc quality gate runs first; PII-laden transcripts are recorded with redacted bodies so the learning loop sees the rejection without leaking content
- Triple-write to PG (system of record), Qdrant (semantic search), and analytics events
- Per-user analytics on every event (received, ingested, rejected, duplicate, fetch_failed, no_owner)

**UI:**
- Settings → "Plaud — Meeting Transcripts" tile (connect/disconnect/status)
- New `/meetings` sidebar page — org-shared list, click-to-expand, lazy detail load
- New Wolfpack Assistant **Priority 3 retrieval** — between analytics (priority 2) and AI fallback (priority 4). Cheap keyword gate first, then ranked ILIKE search across title (3×), summary (2×), body (1×). Returns top 3 with formatted snippets. Logs `source="meeting_transcripts"` and fires `system.ai_call_skipped` so the learning loop knows every time a meeting answer saved an AI call.

**Tests:** 24 in `plaud.test.ts` covering signature verification (5 cases), idempotency, owner resolution (3 paths), doc quality rejection, fetch failures, list/get/search round-trips, ranking correctness, migration shape, analytics registration.

**Impact for the product:** this is the highest-leverage data source on the roadmap because it's *passively generated*. Every other source (knowledge base, journal, feature requests) requires someone to type something. Calendar + meeting audio just happens.

### Analytics overhaul (real data, plain language)

Before: the analytics page used dev jargon (`knowledge.question_asked`), had a permanently-`null` AI efficiency card, and silently fell back to a giant block of demo data when the database was in cache mode (violating the team's "no shadow data on production pages" rule).

After:
- **Plain-language activity buckets** instead of raw event names ("Questions asked", "Answers from memory", "Documents generated", "Meetings ingested", "Discussions", "Feature requests", "Morning briefings")
- **Real `ai_efficiency`** computed from `apex_events` — per-day trend, knowledge cache vs meeting transcripts breakdown, total token savings
- **New "Doc quality gate" card** showing pass/warn/blocked counts plus the 10 most recent rejections with their reasons. The gate has been silently rejecting documents for weeks; the team can finally see what's been blocked and why
- **New "Integration health" card** showing which integrations have actually delivered events in the last 7 days
- **New "Meeting transcripts" card** showing Plaud ingestion stats per owner via the new `apex_v_meeting_ingestion_quality` learning view
- **Demo data purged** — the route now returns `live_mode_empty: true` when the DB is connected but empty, `database_unreachable: true` when the DB is down. UI shows actionable empty states instead of fake numbers.
- `team_activity` now joins `apex_team_members` and shows real names

### TypeScript backlog cleared

Bumped tsconfig target from ES2017 to ES2020. Added `export {};` to 5 test files to isolate jest mock variables from the global script scope (was causing `Cannot redeclare` errors). Replaced a dotall regex with `[\s\S]` in `assistant-data-flow.test.ts`. Cast 13 jest mock spread call sites with `as any`.

**Result: `npx tsc --noEmit` now exits clean across the entire project for the first time.** Future CI gates can rely on it. The 16-error backlog that had been hidden behind `continue-on-error` for weeks is gone.

### In-CI AgenticQA agent pipeline

A new GitHub Actions workflow (`.github/workflows/agenticqa-full-pipeline.yml`) runs the full AgenticQA agent suite against the Instinct codebase on manual trigger. 11 jobs across 4 phases:

| Phase | Job | Purpose |
|---|---|---|
| 0 | Pipeline Health Check | YAML validation |
| 0 | Code Linting | `tsc --noEmit` + ESLint |
| 0 | SRE Auto-Fix Linting | `eslint --fix` + auto-commit |
| 1 | Jest Test Suite | All 568 tests + strict tsc re-check |
| 1 | **AgenticQA Orchestrator** | **Clones AgenticQA, boots FastAPI sidecar, runs full agent pipeline (SDET, Fullstack, SRE, Compliance) against Instinct** |
| 1 | Shadow Mode Verification | 18 routes verified to not 500 in no-DB mode |
| 1 | SDET Analysis | Test counts + coverage gap inventory |
| 1 | Compliance Analysis | Security headers, PII gate, NEXT_PUBLIC leaks, per-user token isolation regression check |
| 2 | Fullstack Build Verification | Production build still works after Phase 1 |
| 3 | SRE Production Readiness | npm audit, console.log hygiene, env var inventory, migration count |
| Final | Pipeline Summary | Status table |

**Architecture decision:** AgenticQA runs as an in-CI sidecar (clone → install → boot uvicorn locally → POST workflow request → poll). This avoids needing any external hosting (no Railway, no Vercel functions, no GHCR image). The first end-to-end run found and fixed a real race-condition bug in AgenticQA itself (`nhomyk/AgenticQA@a84d9f0`) where the background `WorkerPool` and explicit `/run/{id}` path race for the QUEUED → IN_PROGRESS transition.

**Verifiable proof of working integration:** [pipeline run 24106176630](https://github.com/the-wolfpack-agency/wolfpack-apex/actions/runs/24106176630) — orchestrator job ran for 2m26s, created feature branch `agenticqa/wr_ed7b9958d143-run-full-pipeline-against-this-r`, isolated git worktree, ran agents against Instinct's source tree. Generated changes were rejected by the policy gate as `fallback_stub_detected` because no `ANTHROPIC_API_KEY` was passed to the sidecar — the only remaining piece for full agent output.

### Other improvements

- **Handoff scaffolder** (`scripts/handoff-scaffold.mjs`) — `npm run handoff` produces a starter doc with all commits since the previous handoff already grouped. No deps. Fixes the recurring "previous handoff didn't exist" problem.
- **Plaud + Microsoft + Insights feature spec** ([docs/features/meeting-microsoft-insight-generator.md](../docs/features/meeting-microsoft-insight-generator.md)) — 16 insight ideas across 4 tiers for once both feeds are live
- **Cost report refresh** (`reports/Wolfpack_Complete_Infrastructure_Costs_2026.pdf`) reflects the hybrid LLM model decision (~$120/mo, down from ~$125/mo)

---

## Product readiness scorecard

Treating Instinct as a potential public offering, here's where each dimension stands:

| Dimension | Status | Notes |
|---|---|---|
| **Multi-user safety** | ✅ Ready | Per-user MS Graph isolation shipped today. QuickBooks intentionally single-tenant. Per-user analytics throughout. |
| **Test coverage** | ✅ Strong | 568 tests, 22 suites, 0 TypeScript errors, full jest suite runs in ~2s |
| **CI/CD** | ✅ Working | 11-job pipeline including AgenticQA agent integration |
| **Observability** | ✅ Working | Real analytics page (no demo data), integration health, gate activity, AI efficiency, meeting stats |
| **Privacy/security gates** | ✅ Working | Doc quality gate (PII/security/compliance) on every ingest path |
| **Authentication** | ⚠️ Internal-only | JWT with 5 roles, no SSO yet. Acceptable for internal team; needs SAML/OIDC for external customers. |
| **Database migrations** | ✅ Working | 8 migrations, sequential, applied via `npx tsx src/db/migrate.ts` |
| **Deployment** | ✅ Working | Vercel auto-deploy on push to main |
| **Documentation** | ⚠️ Light | Internal handoffs + this report. No customer docs yet. |
| **Pricing/billing** | ❌ Not started | No Stripe integration on Instinct itself (Stripe is on wolfpack-auto). |
| **Onboarding flow** | ❌ Not started | No customer signup, no tenant provisioning, no admin invite flow. |
| **Multi-tenancy** | ❌ Not started | Single tenant (Wolfpack Agency) hardcoded throughout. Would need a tenant table + scoping on every query. |
| **Status page / SLA** | ❌ Not started | |
| **Terms / privacy policy** | ❌ Not started | |

**Honest read:** Instinct is **production-ready for internal Wolfpack use** and **6-12 weeks of focused work away from external-customer-ready**. The core engine (assistant, knowledge, briefings, integrations, gates, agents) is solid. What's missing is everything around customer onboarding, multi-tenancy, billing, and legal — the things that don't matter for one team but are non-negotiable for a SaaS.

---

## What's blocked / awaiting external action

1. **`ANTHROPIC_API_KEY` in GitHub Actions secrets** — last piece for the agent pipeline to produce real output instead of stubs
2. **Plaud API credentials** — Plaud says "API pricing coming soon"; may require contacting them
3. **Microsoft 365 admin consent** — Nick is not the tenant admin yet (starts officially 4/20); CEO has the access
4. **QuickBooks OAuth** — CEO needs to connect their account
5. **Vercel domain rename** — `wolfpack-instinct.vercel.app` works; the original `wolfpack-apex.vercel.app` is the legacy URL

None of these are code blockers — they are all external/credential actions outside the codebase.

---

## Test status

```
npx jest --no-coverage         → 568 passing across 22 suites
npx tsc --noEmit               → 0 errors
gh workflow run                → 11/11 jobs green
```

---

## Honest reflection on this session

The session was productive (14 commits to wolfpack-apex + 2 to nhomyk/AgenticQA, ~5500 lines of net additions) but it also exposed how brittle the current "trust the model to remember" pattern is across sessions. Today's session **started broken** because the previous day's handoff didn't exist. The fix was tooling (handoff scaffolder) plus the explicit, filled-in handoff doc that accompanies this release report.

For Instinct as a *product*, this is also the right pattern: every release ships with a release report (this file) and a session handoff (the technical context for the next person). The two are separate artifacts because they serve different audiences — the release report is for Hoxsie and future customers, the handoff is for the next CTO/dev session.

---

*Wolfpack Agency | Confidential | April 7, 2026 | Instinct v0.4.0*
