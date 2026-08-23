# Client Context — Wolfpack Instinct

Internal-only. Do not copy verbatim into client-facing artifacts.

## Product identity

- **Public name**: Wolfpack Instinct.
- **Previous name**: Wolfpack Apex. Renamed 2026-04-06. Never use "Apex" in client-facing copy, UI strings, docs, or emails.
- **Repo**: `the-wolfpack-agency/wolfpack-apex` (repo name still reflects the old code name; do not rename the repo).
- **Deployed URL**: `https://wolfpack-instinct.vercel.app`.
- **Positioning**: Internal OS for agencies — briefing, assistant, HR, sites, clients, financials. Crypto-agile and quantum-migration-ready (see `docs/security-posture.md`).

## Audience

Wolfpack Agency team members first; then client-agency users onboarded via the setup wizard. The product is multi-tenant (workspace-scoped) but currently deployed with a single primary tenant.

## Stakeholders / decision-makers

- CTO owns engineering decisions end-to-end.
- Product decisions tied to agency operations live with the founding team.
- No client name should appear as a default placeholder in UI or code. Generic examples only.

## Feature flags / posture in flight

- **MFA on admin**: not shipped. Pre-release checklist item. Do not announce MFA coverage externally.
- **ML-DSA signing**: reserved slot, throws `NotImplementedError`. Messaging: "quantum-migration-ready," not "quantum-safe today."
- **Hybrid TLS**: asserted via `scripts/verify-tls-hybrid.sh`; CI test activates when `PROD_DOMAIN` env var is set.
- **HSTS preload**: plan to submit domains after HSTS has been live on Vercel for >1 week.

## Required Vercel env vars (deployment blockers)

Any missing value = production crash loop. Flag at the top of a handoff, not the bottom.

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `INSTINCT_JWT_SECRET` | ≥32 chars. Code throws in prod without it. |
| `NEXTAUTH_SECRET` | Where next-auth is used (check current auth stack — Instinct uses a custom JWT, but any next-auth surface still needs this) |
| `RESEND_API_KEY` | Plus sender domain configured in Resend |
| `GITHUB_TOKEN_WOLFPACK_AGENCY` | For Sites module |
| `WOLFPACK_SITES_WEBHOOK_SECRET` | Signs Sites webhooks |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` | Graph OAuth |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | QuickBooks OAuth |
| `QDRANT_URL` / `QDRANT_API_KEY` | Vector store for triple-write |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Graph store. Optional, and unset in production today. Absence degrades the triple write to Postgres + Qdrant and is reported, not silent |
| `PROD_DOMAIN` | Enables the TLS hybrid posture CI assertion |

## Messaging guardrails

- Never reference competitors by name in client materials.
- Public security-posture messaging lives in `docs/security-posture.md` and `/security-posture` — use that wording verbatim externally.
- Mobile + desktop responsive is non-negotiable for any UI that clients see.

## Session handoffs

Per-session context that isn't in git lives in `demo/handoff-<date>.md`. That's where "we agreed to do X next," "blocker Y is waiting on partner Z," and "don't ship feature A before meeting B" go. Read the latest handoff on session start.
