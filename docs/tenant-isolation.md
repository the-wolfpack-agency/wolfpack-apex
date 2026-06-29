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
is a silent cross-tenant leak: the query runs, just over the wrong rows. Three
guardrails keep that from regressing:

- `src/lib/db/__tests__/tenant-isolation-global.test.ts` - the REPO-WIDE gate.
  Walks EVERY workspace-scoped table (discovered from the migrations) across ALL
  of `src/` via the shared scanner `src/lib/db/tenant-scope-scan.ts`, and fails
  the build if any filtering query lacks a `workspace_id` predicate AND does not
  fall into a documented benign class (principal-resolve, pk-pinned-upstream,
  resolves-from-credential, system-cross-workspace, dynamic-where,
  not-a-table-access). Anything else is "unclassified" - the alarm. This is what
  caught (and now guards against) the job-codes-dossier leak class: a tenant-owned
  table filtered by a non-tenant business key. Run ad-hoc with
  `npm run scan:tenant-isolation`. Coverage is recorded as a time series by
  `/api/cron/tenant-isolation-scan` (migration 208 + `system.tenant_isolation_scanned`).
- `src/lib/platform-scan/__tests__/tenant-isolation.test.ts` - the original,
  narrower guardrail over the 7 platform-scan store files. It additionally asserts
  migration 196 is well-formed (RLS on exactly the platform-scan workspace-scoped
  table set, no columns, no data, no `current_setting`).
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

## Session-var RLS retrofit (in progress)

The retrofit graduates a table from "tripwire" (permissive `USING (true)`) to
real, enforced isolation where Postgres itself filters every row. It is rolled
out per table group, never big-bang, with the app-side predicate staying in
place throughout (defense in depth - predicate AND policy both holding).

### Step 1 - the mechanism (DONE)

`withWorkspaceScope(workspaceId, fn)` in `src/lib/db.ts` checks out one pooled
client, opens a transaction, runs `SELECT set_config('app.workspace_id', $1,
true)` (the `true` = transaction-local, reset on release), and runs `fn` inside
an **AsyncLocalStorage** context that pins that client. While inside, `query` /
`safeQuery` / `writeQuery` transparently run on that client, so a policy keyed on
`current_setting('app.workspace_id')` filters every row with ZERO call-site
churn. Outside a scope, `query` uses the pool exactly as before. Unit-tested in
`src/lib/__tests__/db-workspace-scope.test.ts` (routing, commit/rollback/release,
nesting, shadow-mode). The retrofit progress (how many scoped tables are enforced
vs tripwire-only) is tracked by the scanner + `/api/cron/tenant-isolation-scan`
(`system.tenant_isolation_scanned` carries `rls_enforced_tables`).

### Step 2 - per-table flip (gated on a real-DB verify)

For each table group:

1. **Wrap the call sites.** Every route/cron/job that reads or writes the table
   runs its handler body inside `withWorkspaceScope(callerWorkspaceId, ...)`. A
   missed path, once the policy is FORCED, returns zero rows (fail-closed) - so
   the conversion must be complete and proven before the flip.
2. **Flip the policy.** Replace the permissive policy with
   `USING (workspace_id = current_setting('app.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`
   AND add `ALTER TABLE x FORCE ROW LEVEL SECURITY`. **FORCE is mandatory**: the
   app connects as the table owner, and an owner BYPASSES RLS without FORCE, so a
   policy alone is fake enforcement.
3. **Verify on a real database FIRST.** The exact policy shape is validated by
   `src/lib/db/__tests__/workspace-scope-rls-enforcement.test.ts` - a proof
   harness that, against a real Postgres (it SKIPS without `DATABASE_URL`), shows
   a scoped read returns only the caller's rows, an unscoped read is fail-closed,
   a cross-workspace UPDATE affects zero rows, and `WITH CHECK` blocks a
   mis-tagged insert. Run it (`DATABASE_URL=... npx jest
   workspace-scope-rls-enforcement`) before shipping any FORCE migration. This
   step is why the flip is NOT done blind: swapping policies before the call
   sites are wrapped + verified would deny live traffic.

`withTransaction()` opens its own connection and is not yet scope-aware, so keep
FORCE-RLS tables on the `writeQuery` path (which IS scope-aware) until the two are
unified.

### Step 3 - keep the guardrails

The predicate-presence guardrails
(`src/lib/db/__tests__/tenant-isolation-global.test.ts` repo-wide;
`src/lib/platform-scan/__tests__/tenant-isolation.test.ts` for platform-scan)
stay valuable as defense in depth even after a table is FORCE-enforced.

Until every scoped table is enforced, the app-side predicate is the boundary and
the permissive RLS policy is the tripwire that makes each flip a contained,
verified change rather than a schema-wide scramble.
