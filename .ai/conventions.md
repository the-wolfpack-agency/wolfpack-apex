# Conventions — Wolfpack Instinct

Reference material for adding code that fits the existing system. If it isn't written here or in the source-of-truth files listed, default to the closest existing pattern and match it exactly.

## File layout rules

- Route handlers: `src/app/api/<resource>/route.ts`. Nested resources nest: `src/app/api/clients/[clientId]/documents/route.ts`.
- Dashboard pages: `src/app/(dashboard)/<resource>/page.tsx`. The `(dashboard)` route group enforces the authenticated layout.
- Shared domain logic: `src/lib/<domain>.ts`. One file per noun (`clients.ts`, `journal.ts`, `people.ts`). Keep route handlers thin; push logic into lib.
- Microsoft Graph surfaces: `src/lib/integrations/microsoft-<surface>.ts`. One file per Graph resource. Never call `microsoft-graph.ts` directly from a route.
- Signal extractors: `src/lib/learning/<surface>-signals.ts`. Pure functions that read stored data and emit learning rows.
- Tests: co-located under `src/**/__tests__/<name>.test.ts`. See `jest.config.ts` `testMatch`.

## Naming

- Capabilities: snake_case dotted, scoped by domain, e.g. `mail.read`, `calendar.write`, `people.manage`. Every capability is listed once in `src/lib/auth/capabilities.ts` and mapped to one or more roles in `src/lib/auth/role-capabilities.ts`.
- Roles: lowercase singular, e.g. `admin`, `member`, `viewer`.
- Analytics events: `<domain>.<noun>_<verb_past_tense>`, e.g. `knowledge.question_asked`, `setup.step_viewed`, `system.refresh_token_reuse_detected`. Every new event MUST be added to the `InstinctEventType` union in `src/lib/analytics.ts`. The `audit-coverage.test.ts` and `capability-coverage.test.ts` tests enforce registration.
- Audit events: same shape as analytics, but written through `lib/audit-log.ts` (hash-chained) only for security-relevant actions (auth, capability grant, data export, admin impersonation).

## Migrations

- Numbered three-digit prefix, snake_case description: `027_directory_mailbox.sql`.
- Always additive in production. No `DROP COLUMN` without a paired follow-up migration that's been green in CI for a week.
- Every migration is idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guard indexes with `CREATE INDEX IF NOT EXISTS`.
- Views (`_view`, e.g. `instinct_setup_funnel`) created in the same file as the table they read from.
- Run locally with `npm run migrate`; run in Vercel deploy via `npm run vercel-build` (migrate → next build).

## Adding a new route

1. Pick or add a capability in `src/lib/auth/capabilities.ts`.
2. Map the capability to the right role(s) in `src/lib/auth/role-capabilities.ts`.
3. Create `src/app/api/<resource>/route.ts`. First line of every handler: `await requireCapability(req, '<capability>')` from `src/lib/auth/require-capability.ts`.
4. Push business logic into `src/lib/<domain>.ts`. Route handler just parses, delegates, serializes.
5. If the route touches Graph, call `src/lib/integrations/microsoft-<surface>.ts` — never `microsoft-graph.ts` directly.
6. If the route writes a durable entity, use `src/lib/triple-write.ts`, not raw `query()`.
7. Emit `trackEvent({ type: '<domain>.<action>' })` for the action; add the type to `InstinctEventType`.
8. Add a contract test under `src/app/api/<resource>/__tests__/<resource>-route.test.ts` asserting 200 (not just "not 500"), 401, 403.
9. If the route backs a UI, add a Jest + Testing Library test; if it's user-facing flow, an E2E test.

## Adding a capability

1. Add to `capabilities.ts` (list).
2. Map in `role-capabilities.ts` (role→list).
3. `capability-coverage.test.ts` will fail until every new capability is referenced by at least one route via `requireCapability`.

## Adding an analytics event

1. Add to `InstinctEventType` union in `src/lib/analytics.ts`.
2. Call `trackEvent(...)` from the code path that performs the action.
3. If the event should surface in learning, add a row consumer in `src/lib/learning/<surface>-signals.ts`.

## Widget interfaces

Assistant tools may return a `widget: WidgetSpec` in their `ToolSuccess` result. The widget renders **inline** in the assistant response (no separate route — the widget lives inside the chat message that triggered it).

### Shape

`WidgetSpec` is a discriminated union in `src/lib/assistant/widgets/types.ts`. Every variant looks like `{ kind: string, ...data }` — the `kind` discriminator drives dispatching. Current kinds: `calendar`, `email_thread`, `task_list`, `good_morning`, `dms_inventory`, `search_results`, `weather`, `headlines`, `fx`, `upload_to_brain`. The renderer for each kind lives in `src/components/widgets/<Name>Widget.tsx`.

`upload_to_brain` is the **canonical user-driven Brain ingest surface** — a dedicated drag/drop panel with the data-quality filter (`src/lib/brain/upload-filter.ts`) gating bad uploads at the gate. The chat-input drag/drop in `InstinctChat.tsx` (commit `a6db4f5`) is the **secondary path** for the same pipeline: both flow through `/api/brain/ingest` (legacy chat path) or `/api/brain/upload` (filtered widget path) → `ingest()` → `brain_documents` / `brain_chunks` / Qdrant. Adding a new "upload from somewhere" surface? Reuse one of these two routes; don't fork the persistence layer.

### Dispatcher

`src/components/ChatWidget.tsx` is the renderer dispatcher. It reads `spec.kind` and renders the right widget; unknown kinds render `null` (forward-compatible — backend can ship a new widget kind before a frontend deploy without breaking user-visible behavior).

### Adding a new widget

1. Extend `WidgetSpec` in `src/lib/assistant/widgets/types.ts` with a new variant. The discriminator (`kind`) is snake_case (`search_results`, not `searchResults` or `SEARCH_RESULTS`).
2. Create `src/components/widgets/<Name>Widget.tsx` exporting a default React component that takes a typed `{ spec, workflowId? }` prop. Use the `var(--wp-*)` dark-theme tokens — never hard-code colors. Use `StaggeredItem` + `useStaggeredReveal` for animated list rows (same reveal motion every widget uses).
3. Register the kind in `src/components/ChatWidget.tsx`'s switch — one new `case` returning the component.
4. Have the tool's handler return `widget: { kind: "<kind>", ...data }` on success. The widget rides alongside the text `answer` and any `sources` / `form` the tool also surfaces.
5. Add a Jest + Testing Library test under `src/components/widgets/__tests__/<Name>Widget.test.tsx`. Assert empty-state, render-with-data, and analytics-on-interaction paths.

### Analytics — uniform across every widget

Every widget fires (via `fetchWithRefresh` to `/api/analytics`):

- `assistant.widget_rendered` once on mount, metadata: `{ widget_kind, ...counts, workflow_id? }`.
- `assistant.widget_interaction` on every click / toggle / expand, metadata: `{ widget_kind, action, value?, workflow_id? }`.
- `assistant.widget.items_revealed` once per mount when itemCount > 0 (fired by the `useStaggeredReveal` hook). Metadata: `{ widget_kind, item_count, stagger_ms, workflow_id? }`.

The `workflow_id` correlates the widget's events with the originating chat() turn so the funnel (intent → tool → widget → interaction) joins cleanly in the learning loop.

### Re-prompting the assistant from a widget

There is no programmatic re-prompt API in the chat surface yet — a widget can't directly emit a new chat message that re-invokes its tool. Two fallback patterns until the surface supports it:

1. **Analytics-stub** (preferred for now). Fire a typed event (e.g. `assistant.search_refilter_requested`) carrying the parameters the user wants — query, filter subset, etc. The learning loop sees demand; when the re-prompt API lands, the widget swaps the stub for a real dispatch.
2. **Deep-link out** — render an `<a href="/search?q=...">` so the user can open the page surface with the narrowed filter applied via URL state.

### Coverage guardrail (planned, not yet enforced)

A `widget-coverage.test.ts` mirroring `provider-coverage.test.ts` will walk every tool that returns a widget and assert each `WidgetSpec.kind` has a renderer registered in `ChatWidget.tsx`, or appears in a `WIDGET_EXEMPT_TOOLS` allowlist with a one-phrase reason. Stub: `src/components/widgets/__tests__/widget-coverage.test.ts` (skipped, documents intent). Land the full enforcement when the next new widget gets added — the walk costs nothing, and the explicit allowlist mirrors the existing universal-search / capability / audit coverage tests.

## Universal search providers

Universal Search (`src/lib/search/runSearch.ts` + the `search` assistant tool + `/api/search`) fans every query out to every registered provider in `src/lib/search/providers/`. Adding a new tool that exposes searchable data? You must do ONE of these:

1. **Expose a provider.** Create `src/lib/search/providers/<surface>.ts` exporting a `SearchProvider` (or re-export one from your tool module as `searchProvider`). Append it to `SEARCH_PROVIDERS` in `src/lib/search/providers/index.ts`. Add the provider's `type` to the `SearchType` union in `runSearch.ts` and bump `SearchResponseCounts` if you're introducing a new `countKey`.
2. **Add to the exempt allowlist.** If the tool truly has nothing searchable (a mutation, a widget, an ID-by-lookup), add an entry to `SEARCH_PROVIDER_EXEMPT_TOOLS` in `src/lib/search/__tests__/provider-coverage.test.ts` with a one-phrase reason.

The `provider-coverage` guardrail test walks every file in `src/lib/assistant/tools/` and fails the build until each is covered by path (1) or (2).

## Error handling for integrations

External integrations (Graph, Plaud, QuickBooks, Resend) return typed `Result<T, IntegrationError>`; they never throw. Route handlers translate `error` into the right HTTP status and a user-facing message ("scope missing", "service unavailable"). This is non-negotiable — throwing from an integration corrupts the UX everywhere.

## Crypto

Every signing / verifying operation goes through `src/lib/crypto/algorithms.ts`. No direct `jsonwebtoken` imports outside that file. Cookies set auth tokens only through `setAuthCookie()` in `src/lib/crypto/cookies.ts` so HttpOnly / Secure / SameSite flags cannot drift.

## Test patterns

- Unit: `*.test.ts` co-located under `__tests__/`.
- Contract: assert 200, 401, 403, 404, 400 — not just "no 500". A blank UI on 401 is a prod bug class we already lived.
- Coverage tests: `capability-coverage.test.ts`, `audit-coverage.test.ts`, `openapi-coverage.test.ts` (when present) guard against orphan surfaces.
- Security-critical code has dedicated tests: `audit-log-immutable.test.ts`, `csp-report.test.ts`, `tls-hybrid-posture.test.ts`.

## Verification

- Canonical pre-push command: `scripts/verify.sh` (runs lint + tsc + jest; add E2E when the repo grows one).
- Handoff at session end: `npm run handoff` scaffolds `demo/handoff-<date>.md`.

## Client-side authenticated fetches

Every fetch to an authenticated endpoint from a `"use client"` component goes through `fetchWithRefresh` (in `src/lib/client-auth.ts`). Raw `fetch("/api/...")` is forbidden for authenticated routes and enforced by `src/__tests__/no-raw-api-fetch.test.ts`.

### Why
JWT access tokens have a 15-minute TTL (crypto hardening Apr 15). Refresh tokens are HttpOnly cookies with 7-day TTL + family-based theft detection. `fetchWithRefresh`:
1. Attaches `Authorization: Bearer <access_token>` from localStorage.
2. On 401, calls `POST /api/auth/refresh` (the HttpOnly refresh cookie is sent automatically), stores the rotated access token, retries the original request once.
3. On refresh failure, clears the session and redirects to `/login?next=<current>`.
4. Dedupes concurrent refreshes via a single in-flight promise.

### Pattern
```ts
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

// GET
const res = await fetchWithRefresh("/api/dashboard");
const data = await res.json();

// POST with JSON body
await fetchWithRefresh("/api/analytics", {
  method: "POST",
  headers: jsonHeaders(),
  body: JSON.stringify({ event: "..." }),
});
```

### The one exception
`src/app/login/...` — no token exists pre-login. Use raw fetch there.

### Regression history
April 16 2026: the dashboard used raw `fetch("/api/dashboard")` without auth headers, other fetches used stale localStorage tokens after the 15-min TTL shortening. Every API call 401'd, the page rendered with zeros. The fix: `fetchWithRefresh` + the guardrail test above.
