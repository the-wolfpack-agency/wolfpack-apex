# Tenant isolation - how it actually works here

Wolfpack Instinct is multi-tenant (workspace-scoped) but currently deployed with
a single primary tenant. This doc records HOW tenant isolation is enforced in
this codebase, why we chose that model, and the one place a future engineer is
most likely to assume the wrong thing.

## The decision: app-side predicate is the enforced isolation; RLS is a tripwire

There are two common ways to keep workspace A from reading or mutating workspace
B's rows:

1. **App-side predicate (what we use).** Every read/write carries an explicit
   `WHERE workspace_id = $N` (or `AND workspace_id = $N`) predicate. The
   workspace id comes from the authenticated caller's context, never from the
   row being touched. This is the REAL, enforced isolation boundary.
2. **Session-var RLS (what we do NOT use).** The app opens a transaction, runs
   `SET LOCAL app.workspace_id = '<id>'`, and Postgres row-level-security
   policies keyed on `current_setting('app.workspace_id')` filter every row
   automatically, even if a query forgets its predicate.

This codebase uses option 1. Postgres RLS IS enabled on the workspace-scoped
tables, but only as a **permissive, deny-by-default tripwire**: the policy is
`FOR ALL USING (true) WITH CHECK (true)`. It does not filter anything today.
Its job is forward-looking: RLS is already ON, so the day someone writes a real
tenant policy (or a direct-DB caller such as a PostgREST proxy or a BI tool
connects outside the app layer) the table defaults to deny rather than leaking,
without anyone having to remember a separate "enable RLS" step.

Why not session-var RLS today:

- There is **no `set_config` / `current_setting` plumbing** in `src/lib/db.ts`.
  `query()` runs against a pooled connection with no per-request transaction that
  sets a session var.
- A policy like `USING (workspace_id = current_setting('app.workspace_id'))`
  would therefore evaluate `current_setting('app.workspace_id')` as unset and
  **deny every query** - a full production outage.
- Retrofitting the session var for ONLY the platform-scan tables would be
  architecturally inconsistent with every sibling table in the schema
  (`082_automations_porsche.sql`, `083_meeting_insights.sql`,
  `166_ai_gateway_governance.sql` all carry the same permissive policy).

So the platform-scan tables follow the established repo bar exactly:
migration `196_platform_scan_rls.sql` enables RLS + the permissive policy; the
isolation that actually matters is the predicate in the store code.

## What enforces the predicate

A query that touches a workspace-scoped table without a `workspace_id` predicate
is a silent cross-tenant leak: the query runs, just over the wrong rows. Two
guardrails keep that from regressing:

- `src/lib/platform-scan/__tests__/tenant-isolation.test.ts` - statically reads
  every platform-scan store source file, extracts the SQL string literals, and
  asserts each `SELECT` / `UPDATE` / `DELETE` against a workspace-scoped table has
  a `workspace_id = ...` predicate (and each `INSERT` supplies `workspace_id` as
  a column). It also asserts migration 196 is well-formed (RLS on exactly the
  workspace-scoped table set, no columns, no data, no `current_setting`). Adding
  a query that forgets the filter fails the build.
- `src/lib/platform-scan/__tests__/workspace-scoping.test.ts` - the prior
  guardrail in the same spirit, focused on the store read paths.

### The one principled exception

A query may pin a row by its **primary key** (`WHERE id = $1`) without a
`workspace_id` predicate ONLY when that id was already resolved through a
workspace-scoped query upstream. The canonical case is `consumeBudget(scopeId)`
in `src/lib/platform-scan/pentest/scope.ts`: its `scopeId` comes from
`getActiveScope()`, which is itself `WHERE workspace_id = $1 AND platform = $2`.
This exception is recorded explicitly in `QUERY_ALLOWLIST` in the test, with a
one-phrase reason, so it can never be silently widened into a workspace-blind
`WHERE` that merely happens to mention `id`.

## Workspace-scoped platform-scan / onboarding tables

| Table | Migration | Store module |
|---|---|---|
| `instinct_platform_scans` | 180 | `store.ts` |
| `instinct_platform_scan_findings` | 180 | `store.ts` |
| `instinct_system_profiles` | 187 | `profile/store.ts` |
| `instinct_automation_recommendations` | 188 | `recommend/store.ts` |
| `instinct_pentest_authorizations` | 190 | `pentest/scope.ts` |
| `instinct_scan_targets` | 191 | `targets-store.ts` |
| `instinct_target_verifications` | 193 | `authorization/index.ts` |

All seven get the RLS tripwire in migration 196. `workspace_id` is `TEXT` (opaque
string slugs like `default`, `demo-cto`, `tm_<rand>`), never a UUID - see the
note in migration 193 and the user-id / workspace-id schema-guard tests.

## Recommended future initiative: codebase-wide session-var RLS

Out of scope here because it is cross-cutting - it touches `src/lib/db.ts` and
every table in the schema, not just platform-scan. Doing it piecemeal would be
inconsistent and risky. Tracked here as a concrete design sketch so the next
engineer doesn't have to rediscover it:

1. **Transaction helper.** Add `withWorkspaceScope(workspaceId, fn)` to
   `src/lib/db.ts`. It checks out one pooled client, opens a transaction, runs
   `SELECT set_config('app.workspace_id', $1, true)` (the `true` = `SET LOCAL`,
   so it is scoped to the transaction and reset on release), runs `fn` against
   that client, then commits/rolls back and releases. Every workspace-scoped
   read/write moves inside a `withWorkspaceScope` block.
2. **Real policies.** Replace the permissive `USING (true)` policies with
   `USING (workspace_id = current_setting('app.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`.
   The `true` second arg to `current_setting` returns NULL instead of erroring
   when unset, which lets the migration land before the helper is wired
   everywhere (NULL never equals a real workspace_id, so it fails closed).
3. **Migration order.** Land the helper + convert all call sites FIRST, verify
   green against a real DB, THEN swap the policies in a later migration. Swapping
   policies before the helper exists would deny live traffic.
4. **Roll out per table group**, not big-bang: convert one domain's call sites,
   flip that domain's policies, verify, repeat. The app-side predicate stays in
   place throughout (defense in depth - the predicate and the policy both holding
   is strictly safer than either alone).
5. **Keep the guardrail tests.** Even after session-var RLS lands, the
   predicate-presence tests stay valuable as defense in depth: belt and braces.

Until that initiative ships, the app-side predicate (enforced by the guardrail
tests) is the boundary, and the permissive RLS policy is the tripwire that makes
the eventual switch a one-migration change rather than a schema-wide scramble.
