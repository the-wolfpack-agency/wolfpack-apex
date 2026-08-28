# Wolfpack Instinct — repo context

Internal OS for Wolfpack Agency: briefing, assistant, knowledge, HR, clients, sites, financials. Next.js App Router on Vercel with Postgres (Neon) as source of truth, Microsoft Graph as the enterprise integration backbone, and a fan-out writer for durable entities. In production that fan-out reaches Postgres and Qdrant: Neo4j has never been configured there, so the deployment is a double write. Writing about it as a triple write is how the gap stayed invisible for the life of the product.

@AGENTS.md

@.ai/architecture.md
@.ai/conventions.md
@.ai/integrations.md
@.ai/runbooks.md
@.ai/client-context.md
@.ai/data-stores.md

## Already-live sources of truth — don't duplicate, reference

- **API surface**: OpenAPI auto-generated at `public/openapi.json` (when generator exists). Security posture page: `docs/security-posture.md` → served publicly at `/security-posture`.
- **Capabilities**: `src/lib/auth/capabilities.ts` (list) + `src/lib/auth/role-capabilities.ts` (role map).
- **Analytics events**: `src/lib/analytics.ts` — `InstinctEventType` union is the single source of truth.
- **Per-session context + blockers**: `demo/handoff-<date>.md`. Always read the latest before starting work; always write one at session end via `npm run handoff`.

## Production deployment blockers

All must be set in Vercel or the app crash-loops:

- `DATABASE_URL` — Neon Postgres connection string.
- `INSTINCT_JWT_SECRET` — ≥32 chars; code throws without it.
- `RESEND_API_KEY` + sender domain.
- `GITHUB_TOKEN_WOLFPACK_AGENCY` + `WOLFPACK_SITES_WEBHOOK_SECRET` — Sites module.
- `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` — Graph OAuth.
- `QDRANT_URL` / `QDRANT_API_KEY` — vector store for triple-write.
- `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` — graph store. OPTIONAL, and unset in production today: the app runs without it and writes degrade to Postgres + Qdrant, which is now reported as `system.triple_write_degraded` rather than swallowed. Listing it as a crash-loop blocker was wrong.
- `PROD_DOMAIN` — activates the TLS hybrid posture CI assertion.

Full list in `.ai/client-context.md`.

## Verification

Canonical pre-push command: `scripts/verify.sh` (lint + tsc + jest). Run locally, green = green; no ad-hoc command sequences.

Handoff at session end: `npm run handoff` → scaffolds `demo/handoff-<date>.md`. Fill in the conversational context section — that's what git can't see.

## Product identity

Public name: **Wolfpack Instinct**. Previous code name: Apex (do not use in UI, docs, or client copy — 2026-04-06 rename). Repo is still `wolfpack-apex` for historical reasons.
