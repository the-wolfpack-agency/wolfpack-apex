# Architecture — Wolfpack Instinct (wolfpack-apex)

Internal OS for the Wolfpack Agency: briefing, assistant, knowledge base, HR, clients, sites, features, financials, discussions. Next.js App Router on Vercel, Postgres (Neon) as source of truth, Microsoft Graph as the enterprise integration backbone.

## Top-level layout

```
src/
  app/
    (dashboard)/       authenticated UI — mirror of top-level product areas
    api/               route handlers — one dir per resource (mail, calendar, tasks, people, sites, etc.)
    login/             unauthenticated sign-in
    security-posture/  public PQ posture page
    layout.tsx         root layout + providers
  components/          shared React components
  db/
    migrate.ts         migration runner (invoked by scripts/migrate.mjs)
    migrations/        numbered SQL files (001_foundation.sql … 027_directory_mailbox.sql)
    seed-knowledge.ts  seed data for the knowledge base
  lib/
    auth/              capability registry + role→capability map + require-capability guard
    crypto/            named-algorithm registry, JWT sign/verify, cookie helpers, refresh-token rotation
    integrations/      one file per Microsoft Graph surface (mail, calendar, tasks, people, files, …)
    learning/          per-surface signal extractors that feed the learning loop
    notifications/     Resend-backed notification dispatch
    analytics.ts       trackEvent() + InstinctEventType union (single source of truth for event names)
    audit-log.ts       append-only hash-chained audit log
    triple-write.ts    fan-out writer (Postgres + Qdrant + Neo4j)
    db.ts              pg pool + query() helper
    qdrant.ts / neo4j.ts  vector + graph clients
  middleware.ts        auth + CSP + security headers
scripts/
  migrate.mjs          `npm run migrate` — runs src/db/migrate.ts
  handoff-scaffold.mjs `npm run handoff` — writes demo/handoff-<date>.md
  verify-tls-hybrid.sh checks prod X25519MLKEM768 negotiation
```

## Data flow

```
HTTP request
  → middleware.ts           (cookie verify via lib/crypto, CSP, security headers)
  → app/api/.../route.ts    (capability gate via lib/auth/require-capability)
  → lib/<domain>.ts         (business logic)
  → lib/integrations/*      (Graph calls — always typed Result, never throws)
  → lib/db.ts               (Postgres — single writer of record)
  → lib/triple-write.ts     (fan-out: Postgres row + Qdrant vector + Neo4j edge)
  → lib/analytics.ts        (trackEvent — one row per user/system action)
  → lib/audit-log.ts        (append-only hash chain for security-relevant actions)
  → lib/learning/*          (offline consumers of analytics events → signals)
```

## Triple-write pattern

`lib/triple-write.ts` is the single canonical writer. Every durable entity (knowledge doc, journal entry, meeting, person, site, feature request) goes through it:

- Postgres row — source of truth, transactional, RLS-scoped.
- Qdrant vector — embedding for semantic retrieval in the assistant.
- Neo4j edge — relational context (author → doc → topic → team).

No feature writes to only one store. If Qdrant or Neo4j is down, triple-write degrades to Postgres-only and logs `system.triple_write_degraded` — never throws.

## Auth model

Stateless JWT (HS256 today, crypto-agile via `lib/crypto/algorithms.ts`) + rotating refresh tokens. 15-minute access TTL, 7-day refresh TTL with family-revocation theft detection. Capabilities are per-role (see `lib/auth/role-capabilities.ts`) with per-user overrides (migration 021). Every Graph-backed route enforces a capability that maps to a Microsoft Graph scope — see `.ai/integrations.md`.

## Pointers (don't duplicate, reference)

- API surface: `public/openapi.json` is auto-generated; human docs in `docs/` if present.
- Capability registry: `src/lib/auth/capabilities.ts` (list) + `src/lib/auth/role-capabilities.ts` (role→capability map).
- Analytics event names: `src/lib/analytics.ts` — `InstinctEventType` union is the single source of truth.
- Security posture + PQ roadmap: `docs/security-posture.md` (also served publicly at `/security-posture`).
- Per-session context + blockers: `demo/handoff-<date>.md`.

## Deployment target

Vercel (project `wolfpack-instinct`, prod URL `https://wolfpack-instinct.vercel.app`). `npm run vercel-build` runs migrations before `next build` so schema is always in lockstep with shipped code. HSTS is set by Vercel edge — middleware must not duplicate it.
