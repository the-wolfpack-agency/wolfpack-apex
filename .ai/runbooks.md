# Runbooks — Wolfpack Instinct

Known failure modes and fixes. Add an entry every time a prod issue is diagnosed; future-you will thank present-you.

## Dashboard renders blank + every API call returns 401

Symptom: user logs in, lands on dashboard, every widget is empty, devtools shows a flood of 401s on `/api/*`.

Likely causes, in order:
1. **Access-token TTL expired mid-session** and the client isn't hitting `/api/auth/refresh`. Verify `src/lib/client-auth.ts` wiring — the refresh interceptor must fire before the 401 bubbles to the widget. TTL is 15 minutes by design; anything relying on an 8-hour session is stale code.
2. **`INSTINCT_JWT_SECRET` rotated without a rolling window.** Tokens signed under the old secret all fail verify simultaneously. Mitigation: keep previous secret as `INSTINCT_JWT_SECRET_PREVIOUS` through a rotation window, verify both.
3. **Cookie flags drifted** — direct `cookies().set()` outside `setAuthCookie()`. Grep for `cookies().set('instinct_auth'` — there should be exactly one call site.

## CSP violations in browser console

Check `middleware.ts` first — that's where the CSP header is set. If `unsafe-eval` or `unsafe-inline` reappeared, someone worked around a library requirement; push back and fix the library, don't weaken CSP. Enforce mode writes `system.csp_violation_reported` to analytics via `/api/csp-report` — query that table to see what's breaking.

If CSP is correct locally but broken in prod, check Vercel edge — an edge config override could be winning.

## Microsoft Graph calls return 403 after user consented

The user granted the scope in tenant admin consent, but the user's access token predates the grant. Fix: force a token refresh (user signs out/in once, or hit `/api/microsoft/reconnect` which clears `instinct_ms_tokens` for the user). Integration layer MUST surface this as `scope_missing`, not a generic error — see `.ai/integrations.md`.

## Refresh-token reuse detected — user logged out everywhere

By design. When `system.refresh_token_reuse_detected` fires, the entire token family is revoked. This happens when:
- Network hiccup caused client to retry a refresh; both succeed with the same `refresh_token` → second is flagged as replay.
- Genuine theft.

Mitigation: the refresh flow must treat a refresh as "fire once, trust the response." If the client is retrying, add request de-duplication in `src/lib/client-auth.ts`. If it's a genuine replay signal, look at the audit log hash chain.

## Migration failed mid-deploy on Vercel

`vercel-build` runs `migrate` before `next build`. A partial migration leaves schema in an inconsistent state. Fix path:
1. Vercel deploy fails — new code is NOT live. Old revision still serving.
2. Inspect the migration file. If it's missing `IF NOT EXISTS` or `IF EXISTS` guards, add them and re-deploy.
3. If a migration committed rows, write a new numbered migration that cleans up; never edit a historical migration.

## Neo4j / Qdrant unreachable

`src/lib/triple-write.ts` degrades gracefully — Postgres writes succeed, analytics emits `system.triple_write_degraded`. Check the backing infra; do NOT patch triple-write to throw. If the secondary stores stay down long-term, there's a backfill path once they recover (see `src/lib/triple-write.ts` comments).

## Tests that started flaking

- `assistant-data-flow.test.ts` flaking on Qdrant: the test assumes Qdrant is up. Use `QDRANT_URL=none` to route through the mock, or bring Qdrant up via `docker-compose`.
- `tls-hybrid-posture.test.ts` is skipped unless `PROD_DOMAIN` is set. Not a bug.
- Jest + Next 16 ESM: if a new lib imports an ESM-only dep, add it to `transformIgnorePatterns` in `jest.config.ts` (auto's pattern).

## Vercel deploy succeeded but `/security-posture` 404s

The page is a standalone route under `src/app/security-posture/`. If the deploy succeeded but the route is missing, the build likely pruned it — check `next.config.ts` for any `exportPathMap` or similar. The page is public (no auth), so middleware isn't at fault; it's a build-pruning issue.

## OAuth redirect `?returnTo` not honored

`returnTo` is only honored when it starts with a single `/` (same-origin). Any other shape (external URL, double slash) is dropped silently as an SSRF/open-redirect defense. If a legitimate flow needs external redirect, explicitly whitelist the target in the OAuth callback.

## Setup wizard restarts from Step 0 after OAuth callback

The wizard derives its step from `/api/workspace/status` → `nextStep`. If the status endpoint says the user hasn't completed Step 1 but they clearly have, check:
- `PUT /api/workspace` didn't fire — Step 1 is still client-state-only (regression of the fix shipped 2026-04-15).
- `instinct_setup_events` migration 016 didn't run — server has no memory of events.
