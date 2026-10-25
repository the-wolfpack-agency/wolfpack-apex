# Row-level security cutover

How the workspace RLS policies from migrations 296 and 297 go from written to enforced. Until the steps below are done, they filter nothing, and that is on purpose.

## Where things stand

| Piece | State | Where |
|---|---|---|
| Workspace policies on 78 tenant-scoped tables | Shipped. Not enforced | `src/db/migrations/296_rls_workspace_policies.sql`, `297_rls_workspace_policies_remaining.sql` |
| Per-request `app.workspace_id` | Shipped behind `INSTINCT_RLS_SESSION_CONTEXT`. Default off | `src/lib/db/request-workspace.ts`, `query()` in `src/lib/db.ts`, bound in `requireCapability` |
| System escape for cross-workspace work | Shipped: `withSystemScope()` sets `app.rls_system = 'on'` | `src/lib/db.ts` |
| A role the policies actually apply to | **Not created.** The app connects as `neondb_owner`, which has BYPASSRLS | Operator step 2 |

Each policy admits a row only when `workspace_id = current_setting('app.workspace_id', true)`, or when the transaction set `app.rls_system = 'on'`. If neither setting is present, the role sees zero rows. No table is `FORCE`d.

### Why the deploy is safe

On 2026-10-24 the production database was checked read-only. The app connects as `neondb_owner` (`rolbypassrls = true`). No role without BYPASSRLS exists. Every workspace-scoped table is owned by `neondb_owner`. No `workspace_id` is NULL in any of them.

A role with BYPASSRLS skips every policy. A table owner skips policies that are not `FORCE`d. So the running app reads and writes exactly what it did before. `src/db/__tests__/rls-workspace-policies.db.test.ts` proves the stronger claim on a real Postgres: even an owner *without* BYPASSRLS sees every row.

### What is not covered yet (phase 2)

Some tables are read before a workspace can be known. A workspace policy on them would hide the row that establishes the workspace, so 296 and 297 leave them alone:

| Table | Why it is excluded |
|---|---|
| `instinct_team_members` | Login resolves the user before any workspace is known |
| `instinct_invites` | Invite acceptance runs before the invitee has a session |
| `instinct_gate_api_keys` | Resolved from the presented API key. Keeps its permissive policy |
| `instinct_delegation_issuers`, `instinct_delegation_replay` | Read while a delegation token is being verified |
| `instinct_edge_policy` | Read by the Forcefield edge guard on unauthenticated traffic |
| `instinct_org_entitlements` | Tenancy entitlements, resolved before the request workspace |
| `github_app_installations` | GitHub webhooks arrive with no Instinct session |
| `integration_health`, `instinct_connector_credentials` | Read and written by crons across workspaces |

These need their own design (for example a `SECURITY DEFINER` lookup function for the principal tables) before the app role can be denied BYPASSRLS everywhere.

## Prerequisites before any environment change

All of these are code changes. Each needs its own PR and green CI.

1. **Migrations must keep the owner connection.** `scripts/migrate.mjs`, `check:upserts` and `engineering:seed` all read `DATABASE_URL`. If `DATABASE_URL` becomes the app role, the next deploy fails, because a non-owner cannot `ALTER TABLE`. Make them prefer a `MIGRATION_DATABASE_URL` (the owner) when it is set, and set that variable before step 3.
2. **Wrap system call sites in `withSystemScope()`.** The tenant-isolation scanner lists every cross-workspace query on a covered table as `system-cross-workspace`. Run `npx tsx scripts/scan-tenant-isolation.ts` to get the list. On 2026-10-24 it was: `lib/assistant/routines/schedule-store.ts`, `lib/agents/drift/store.ts`, `lib/agents/evals/store.ts`, `lib/ai-code/watched-repos.ts`, `lib/forcefield/operator-reputation.ts`, `lib/site-acceptance/store.ts`, `lib/ogiam/checkpoint.ts`. A missed site does not leak data. It fails closed, returning zero rows, which in practice means a cron that quietly stops working. That is why step 4 checks crons as well as pages.
3. **`withTransaction()` is not workspace-aware yet** (see `docs/tenant-isolation.md`). Atomic multi-write blocks on covered tables must run inside `withWorkspaceScope()`, or `withTransaction()` must learn to set the setting.

## Operator steps

Do preview first, then production. When replacing a credential, put the new value live and verify it before removing the old one.

### 1. Read the current state (read-only)

```sql
SET default_transaction_read_only = on;
SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;
SELECT count(*) FROM pg_policy WHERE polname LIKE '%\_ws\_isolation';   -- expect 78
SELECT count(*) FROM pg_class WHERE relforcerowsecurity;                 -- expect 0
```

### 2. Create the app role (Neon console, SQL editor, as `neondb_owner`)

Use a Neon **branch** for preview, so production is untouched until step 5.

```sql
CREATE ROLE instinct_app LOGIN PASSWORD '<generate 32+ random chars>' NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
GRANT USAGE ON SCHEMA public TO instinct_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO instinct_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO instinct_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO instinct_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO instinct_app;
```

The audit log's append-only trigger still applies to this role. Do not grant `TRUNCATE`, and do not make the role the owner of anything.

### 3. Preview environment (Vercel, Preview scope only)

1. Set `MIGRATION_DATABASE_URL` to the current owner connection string (prerequisite 1).
2. Set `DATABASE_URL` to the `instinct_app` connection string for the Neon preview branch.
3. Set `INSTINCT_RLS_SESSION_CONTEXT=on`.
4. Redeploy the preview.

### 4. Verify on the preview URL

Every item must pass.

- Sign in as an admin and as a non-admin. Dashboard, Settings, Routines, Agents, Compliance and the LMS course all render non-zero content (or their explicit empty state), with no 500s.
- Run the E2E reality-check specs against the preview (`PROD_URL=<preview url>`).
- **Cross-tenant check.** With two workspaces seeded on the branch, a user in workspace A sees none of workspace B's rows on the pages above.
- **The binding works on the deployed runtime.** `requireCapability` binds the workspace on Next.js's per-request store (`request-workspace.ts`). If that ever fails to reach `query()`, every covered page reads empty. That is a fail-closed outcome, and this step is where it would show.
- **Crons.** Trigger `routine-schedules`, `ms-sync` and `tenant-isolation-scan` with the cron secret. Each returns 200 and does real work (rows processed > 0 where there is data).
- `security.rls_context_failed` count is 0 in `instinct_events`.

### 5. Production

Repeat step 2 on the production branch, then step 3 in the Production scope with the production values. **Keep the old owner `DATABASE_URL` value saved** until production is verified with the step 4 checklist on `https://wolfpack-instinct.vercel.app`. Only then remove any remaining use of the owner credential from the app's runtime variables. `MIGRATION_DATABASE_URL` stays.

### Rollback

Set `DATABASE_URL` back to the owner value and redeploy. The app bypasses RLS again immediately. `INSTINCT_RLS_SESSION_CONTEXT=off` alone also disables the per-request setting, but under the app role that leaves every covered table reading empty. Roll back `DATABASE_URL` first.

The migrations themselves never need rolling back to undo a cutover. If they must be reverted for another reason, `297_*.down.sql` and then `296_*.down.sql` restore the exact prior state (the permissive tripwire on the 296 tables, RLS off on the 297 tables). The DB test checks that round trip.

## Tests

- `src/db/__tests__/rls-workspace-policies.db.test.ts` runs against a real Postgres in the DB contract workflow. It covers non-owner isolation, cross-tenant reads returning 0, fail-closed with no context, WITH CHECK, the system escape, the owner being unaffected, idempotency, reversibility, and the real `query()` path under the flag.
- `src/lib/__tests__/db-rls-session-context.test.ts` covers the flag, the per-request binding (including no leakage across concurrent requests), the refusal when the setting fails, and `withSystemScope`.
