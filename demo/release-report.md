# Wolfpack Instinct — Release Report
**Prepared by:** AgenticQA / Claude Code
**Date:** April 16, 2026
**HEAD:** `9ebf5ba`
**Repo:** the-wolfpack-agency/wolfpack-apex (renamed product, repo retains historical name)
**Deployed:** https://wolfpack-instinct.vercel.app

> Per-release detail in `demo/release-report-<date>.md`. This file is the canonical "as of today" snapshot. Rename context: Apex → Instinct on 2026-04-06; do not use "Apex" in UI, docs, or client copy.

---

## Executive Summary

Wolfpack Instinct is the internal operating system for Wolfpack Agency: briefing, assistant, knowledge base, HR (benefits + documents + onboarding), client management, hosted-site builder, and financials. Built on Next.js App Router on Vercel with Postgres (Neon) as source of truth, Microsoft Graph as the enterprise integration backbone, and triple-write fan-out (Postgres + Qdrant + Neo4j) for every durable entity.

Core principle: zero-token-first. Questions are answered from cached knowledge, codebase analysis, or analytics data before AI is ever called. When AI is needed, the response is cached so the same question never costs tokens twice. Every interaction is tracked and indexed so the platform compounds knowledge with use.

---

## Platform Architecture

| Component | Technology | Purpose |
|---|---|---|
| Framework | Next.js 16 (App Router) | Full-stack web application |
| Hosting | Vercel | Production deployment |
| Primary DB | PostgreSQL (Neon) | Structured data, analytics events, all CRUD |
| Vector Store | Qdrant | Semantic search, knowledge entries, durable-entity embeddings |
| Graph DB | Neo4j | Knowledge graph, collaboration patterns, entity relationships |
| Enterprise integration | Microsoft Graph (Mail/Calendar/Teams/OneDrive/People/Presence/OneNote/Planner/Groups) | Single source of truth for the team's calendar, mailbox, files, chats |
| Site builder backend | GitHub API + Vercel webhooks | One-click hosted client sites from a brief |
| Auth | NextAuth (JWT, 15-min TTL) + refresh tokens (7d, family-rotated, theft-detected) + MFA (TOTP) | Capability-based, role-mapped |
| Crypto | Named-algorithm registry (`hs256` active, `rs256`, `es256` ready, `ml-dsa-65-hybrid` reserved for PQ migration) | Quantum-migration-ready |
| Styling | Inline CSS variables (Wolfpack brand tokens) + Tailwind utility passes | Mobile-first, dark theme |
| Testing | Jest + React Testing Library + ts-jest | 1796 tests across 122 suites |

---

## What's Live (April 16, 2026)

### Sites (client website builder)
Drag-and-drop hosted site creation for Max + Meghan. Drop a brief (HTML/PDF/docx), get a hosted client site with a preview URL. **Updated 04-16:** Soft-archive on every site (status flip + audit row), redesigned detail page (guided 1→2→3 flow with status banner that tells the user what to do next), mobile-responsive single column.

### HR (Benefits + Documents + Onboarding)
Alicia's workspace. Multi-carrier benefits parser (Aetna / Cigna / UHC / Anthem variants with carrier-specific plan ID formats). Smart-router Documents store with deterministic classifier. Closed-loop recommendation engine — every accept/reject feeds the scoring model.

### Microsoft 365 surfaces
- **Mail** (Mail.Send / Mail.ReadWrite)
- **Calendar** (Calendars.ReadWrite + Teams online-meeting attach)
- **Teams** (personal chat, channels, channel sync)
- **OneNote** (notebook picker → Assistant RAG)
- **OneDrive** (file picker, browse, upload)
- **People** (directory + autocomplete, OOO detection)
- **Presence** (real-time status indicator)
- **Contacts** (CRUD)
- **Planner** (shared team tasks)
- **Groups** (cache + membership lookup)

### Instinct Assistant
Zero-token priority chain: knowledge cache → codebase search → analytics data → AI as last resort. Source badges on every answer. Thumbs-up/down feeds back into knowledge quality. AI responses cached for free future retrieval. Every interaction triple-written (PG + Qdrant + Neo4j).

### Knowledge Base
Cache-first Q&A. Trigram similarity search. 1-5 star answer rating. Popular-unanswered questions surface as documentation gaps. View counts track demand.

### Team Journals
Auto-populated from user actions. Optional manual notes. Mood tracking. Date navigation.

### Document Generation
Zero-token generators for API docs (TS/Python parsing), release notes (git log), feature docs (DB records). All AI artifacts auto-cleaned.

### Report Generator
7 branded templates (Platform Capabilities, Technical Architecture, Client Proposal, Implementation Plan, Product Audit, Monthly Review, Create Your Own). Custom prompts via AI, all output cleaned of AI-tells. Reports saveable as reusable templates.

### Feature Requests
Submit with zero-token analysis: complexity (keyword patterns), cost ($150/hr), risk detection, similar-feature search. Automation suggestions calculate ROI.

### Discussions
Threaded conversations with categories, role-gated pinning, resolution tracking.

### Codebase Browser
Non-technical browse of wolfpack-auto file tree. Search, stats, plain-English file explanations. All zero-token.

### Client Email Templates + Profiles
4 templates (proposal, follow-up, status update, onboarding) with variable substitution. Client CRUD with document linking + industry tags.

### Analytics Dashboard
- AI efficiency trend (zero-token % over time)
- Most asked questions (knowledge gaps)
- Team activity breakdown
- Feature request pipeline funnel
- Automation potential (manual tasks with ROI)
- Document generation stats
- Setup wizard funnel (per-step view/complete/abandon + median duration)

---

## Data Flow

```
HTTP request
  → middleware           (auth cookie, capability lookup, CSP, onboarding redirect)
  → app/api/.../route.ts (requireCapability + analytics + audit)
  → lib/<domain>.ts      (business logic)
  → lib/integrations/microsoft-<surface>.ts | github-client.ts | etc.
  → lib/triple-write.ts  → Postgres + Qdrant + Neo4j
  → lib/audit-log.ts     (hash-chained, security-relevant actions)
```

### Client-side authenticated fetches (mandatory pattern, as of 04-16)

Every `fetch("/api/...")` from a `"use client"` component goes through `fetchWithRefresh`:
1. Attaches `Authorization: Bearer <access_token>` from localStorage.
2. On 401, transparently calls `POST /api/auth/refresh` (HttpOnly refresh cookie auto-sent), stores rotated access token, retries the original request once.
3. On refresh failure, clears the session and redirects to `/login?next=<current>`.
4. Dedupes concurrent refreshes via a single in-flight promise.

Permanent guardrail: `src/__tests__/no-raw-api-fetch.test.ts` walks the entire `src/` tree and fails CI if any client component reaches `/api/*` with raw `fetch()`.

---

## Security Posture

- **JWT TTL:** 15 minutes. Shrinks the harvest-now-decrypt-later window to near-zero.
- **Refresh tokens:** 7-day, rotated on every use, family-revoked on detected re-use of a revoked token (`system.refresh_token_reuse_detected` event into the learning system).
- **Crypto-agility:** Named-algorithm registry with `ml-dsa-65-hybrid` slot reserved for NIST FIPS 204 (ML-DSA) — quantum migration is a single registry entry, not a refactor.
- **CSP:** `unsafe-eval` removed, `frame-ancestors 'none'`, `report-uri /api/csp-report`.
- **Headers:** HSTS (Vercel edge), X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- **Cookie hardening:** Single `setAuthCookie()` helper enforces `HttpOnly` + `Secure` (prod) + `SameSite` + `Max-Age` matching TTL — flags cannot drift.
- **Public posture page:** `docs/security-posture.md` served at `/security-posture` for client-facing reference.
- **MFA:** TOTP via `otpauth` + QR enrollment (migration 020).

---

## Roles + Capabilities

Role-mapped capability model. Capabilities are snake_case dotted (`mail.read`, `calendar.write`, `people.manage`). Every capability lives once in `src/lib/auth/capabilities.ts` and maps to one or more roles in `src/lib/auth/role-capabilities.ts`. `capability-coverage.test.ts` enforces that every new capability is referenced by at least one route via `requireCapability`.

| Role | Use case |
|---|---|
| **CTO** | Architecture decisions, oversight, full access |
| **Dev** | Implementation, technical Q&A, codebase, features |
| **Sales** | Client-facing docs, proposals, emails, reports |
| **Ops** | Operations, processes, automation suggestions |
| **HR** | Benefits, documents, onboarding (Alicia) |

---

## Build Metrics (as of 9ebf5ba)

| Metric | Value |
|---|---|
| Tests passing | 1796 / 1804 (1 skipped, 7 pre-existing baseline) |
| Test suites | 122 |
| Dashboard pages | 26 |
| API route handlers | 125 |
| Database migrations | 27 |
| Microsoft Graph surfaces | 10 |
| Capabilities defined | (see `capabilities.ts`) |
| Analytics event types | 200+ unioned in `ApexEventType` |
| Verify pipeline stages | 4 (lint → tsc → jest → next build) |
| Type errors on touched files | 0 |

Pre-existing baseline failures (none introduced today): 4 in `audit-coverage.test.ts` (Teams routes need either `recordAudit` or AUDIT_ALLOWLIST entry), 1 in `verify-script.test.ts` (output-format mismatch), 2 in `sites-assets.test.ts` / `teams-channels-api.test.ts` (TS 5.x `Uint8Array<ArrayBufferLike>` regression + Next 16 Promise-shape param drift). All flagged in `demo/handoff-2026-04-16.md` Open Items.

---

## Verification (canonical)

```bash
npm run verify   # Stage 1: eslint --max-warnings 0
                 # Stage 2: tsc --noEmit
                 # Stage 3: jest --silent
                 # Stage 4: next build (added 04-16 — catches mis-ordered "use client",
                 #          server/client component import drift, font/image/MDX misuse)
```

Skip Stage 4 in inner-loop iterations: `VERIFY_SKIP_BUILD=1 npm run verify`. Mandatory pre-push.

Per-release detail: `demo/release-report-<date>.md`. Per-session blockers + conversational context: `demo/handoff-<date>.md`.

---

*Built by Wolfpack Agency Engineering. Powered by AgenticQA.*
