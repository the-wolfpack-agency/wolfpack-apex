# Row-level security cutover

How the workspace RLS policies from migrations 296 and 297 go from written to enforced. Until the steps below are done, they filter nothing, and that is on purpose.

## Where things stand

| Piece | State | Where |
|---|---|---|
| Workspace policies on 78 tenant-scoped tables | Shipped. Not enforced | `src/db/migrations/296_rls_workspace_policies.sql`, `297_rls_workspace_policies_remaining.sql` |
| Per-request `app.workspace_id` | Shipped behind `INSTINCT_RLS_SESSION_CONTEXT`. Default off | `src/lib/db/request-workspace.ts`, `query()` and `withTransaction()` in `src/lib/db.ts`, bound in `requireCapability` |
| Job contexts for crons and sweeps | Shipped: `withSystemScope()` (`app.rls_system = 'on'`) and `runWithRequestWorkspace()`, guarded by a test | `src/lib/db/request-workspace.ts` |
| Owner connection for migrations | Shipped: `MIGRATION_DATABASE_URL`, falls back to `DATABASE_URL` | `scripts/migration-database-url.cjs` |
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

All three are code changes and are done. Each is covered by tests that run in CI.

1. **Done: migrations keep the owner connection.** `scripts/migrate.mjs`, `check:upserts` (`scripts/check-upsert-targets.ts`) and `engineering:seed` (`scripts/seed-engineering-wiki.ts`) connect through `scripts/migration-database-url.cjs`: `MIGRATION_DATABASE_URL` when it is set, otherwise `DATABASE_URL`. Unset, nothing changes. `vercel-build` runs the same three scripts, so it needs no change of its own. The scheduled upsert check passes `MIGRATION_DATABASE_URL` through when the secret exists. The DB contract workflow runs `migrate` with a `DATABASE_URL` that points at a database that does not exist and a working `MIGRATION_DATABASE_URL`, so a regression fails CI. Tests: `src/lib/db/__tests__/migration-database-url.test.ts`.
2. **Done: cron and sweep call sites have a context.** `withSystemScope()` and `runWithRequestWorkspace()` (`src/lib/db/request-workspace.ts`, re-exported from `src/lib/db.ts`) mark the RLS context. While the flag is on, each statement inside them runs in its own short transaction with `app.rls_system = 'on'` or `app.workspace_id` set. While the flag is off they change nothing the database can see. The innermost context wins.
   - The seven sites the tenant-isolation scanner lists wrap only their cross-workspace statement in `withSystemScope()`. Each one was checked, and each genuinely spans workspaces: the due-schedule list (`schedule-store.ts`), the active-agent lists for drift and model evals, the watched-repo list, the two Forcefield network-reputation aggregates (which return counts only), the site-acceptance project lookup and queue claim, and the list of workspaces with unsigned decisions (`checkpoint.ts`).
   - The work each sweep then does for one workspace runs under `runWithRequestWorkspace()` for that workspace, not under system scope.
   - Crons that work a single workspace (`ai-redteam`, `engagement-sweep`, `pentest-sweep`, `ai-code-merge-poll`, `forcefield-learn`, the governance-alert scan) run under that workspace. `integration-health` probes each workspace under its own context. `agent-failover` runs under system scope because, called with no workspace, it reassigns work across the whole fleet. The site deploy webhook writes its queue row under the workspace it resolved.
   - **Guard:** `src/lib/db/__tests__/rls-cron-context.test.ts` walks the import graph of every scheduled route (`src/app/api/cron/*` and every cron in `vercel.json`). A route that can reach a covered table must be listed with the file that sets its context and a reason, and the test checks that file really sets it. Every scanner `system-cross-workspace` site on a covered table must call `withSystemScope()`. A new cron, or a cron that starts touching a covered table, fails until it has a context.
3. **Done: `withTransaction()` sets the context.** It sets the same `app.workspace_id` (or `app.rls_system`) on its own connection that `query()` would. With the flag off and no explicit `withWorkspaceScope`, it still issues only `BEGIN`, the writes, and `COMMIT`.

Evidence on a real Postgres, as a non-owner role without BYPASSRLS: `src/db/__tests__/rls-cutover-prereqs.db.test.ts`. With the flag on, a wrapped cron work list sees every workspace while the same statement unwrapped sees none, a sweep's write lands only in its own workspace, a request sees only its own workspace (also right after a nested system read), and `withTransaction` sees only its context, refuses a row for another workspace, and rolls the whole block back. With the flag off, no setting reaches the database, and as the owner the wrapped stores read exactly what unwrapped queries read.

### Known gaps outside crons

These are request paths with no session. Under the app role they fail closed: they degrade, and they do not leak.

- `POST /api/forcefield/edge/decide` reads the edge workspace's reputation opt-in (`instinct_reputation_optin`) with no context, so network reputation reads as empty until it is given the edge workspace's context.
- The phase 2 tables listed above.

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

1. Set `MIGRATION_DATABASE_URL` to the owner (`neondb_owner`) connection string for the Neon preview branch. Redeploy once and confirm the build log still shows `[migrate] done` and `[upsert]` passing. Nothing else has changed yet.
2. Set `DATABASE_URL` to the `instinct_app` connection string for the same branch.
3. Set `INSTINCT_RLS_SESSION_CONTEXT=on`.
4. Redeploy the preview.

### 4. Verify on the preview URL

Every item must pass.

- Sign in as an admin and as a non-admin. Dashboard, Settings, Routines, Agents, Compliance and the LMS course all render non-zero content (or their explicit empty state), with no 500s.
- Run the E2E reality-check specs against the preview (`PROD_URL=<preview url>`).
- **Cross-tenant check.** With two workspaces seeded on the branch, a user in workspace A sees none of workspace B's rows on the pages above.
- **The binding works on the deployed runtime.** `requireCapability` binds the workspace on Next.js's per-request store (`request-workspace.ts`). If that ever fails to reach `query()`, every covered page reads empty. That is a fail-closed outcome, and this step is where it would show.
- **Crons.** Trigger each cron listed in `src/lib/db/__tests__/rls-cron-context.test.ts` (at least `routine-schedules`, `agent-drift`, `ogiam-checkpoint`, `site-acceptance`, `ai-code-watch` and `integration-health`), plus `ms-sync` and `tenant-isolation-scan`, with the cron secret. Each returns 200 and does real work (rows processed > 0 where there is data). Zero rows where there should be some means a missed context, not an empty system.
- `security.rls_context_failed` count is 0 in `instinct_events`.

### 5. Production

Repeat step 2 on the production branch, then step 3 in the Production scope with the production values, setting `MIGRATION_DATABASE_URL` and redeploying before changing `DATABASE_URL`. **Keep the old owner `DATABASE_URL` value saved** until production is verified with the step 4 checklist on `https://wolfpack-instinct.vercel.app`. Only then remove any remaining use of the owner credential from the app's runtime variables. `MIGRATION_DATABASE_URL` stays.

### Rollback

Set `DATABASE_URL` back to the owner value and redeploy. The app bypasses RLS again immediately. `INSTINCT_RLS_SESSION_CONTEXT=off` alone also disables the per-request setting, but under the app role that leaves every covered table reading empty. Roll back `DATABASE_URL` first.

The migrations themselves never need rolling back to undo a cutover. If they must be reverted for another reason, `297_*.down.sql` and then `296_*.down.sql` restore the exact prior state (the permissive tripwire on the 296 tables, RLS off on the 297 tables). The DB test checks that round trip.

## Tests

- `src/db/__tests__/rls-workspace-policies.db.test.ts` runs against a real Postgres in the DB contract workflow. It covers non-owner isolation, cross-tenant reads returning 0, fail-closed with no context, WITH CHECK, the system escape, the owner being unaffected, idempotency, reversibility, and the real `query()` path under the flag.
- `src/lib/__tests__/db-rls-session-context.test.ts` covers the flag, the per-request binding (including no leakage across concurrent requests), the refusal when the setting fails, `withSystemScope`, `runWithRequestWorkspace` and the `withTransaction` context.
- `src/db/__tests__/rls-cutover-prereqs.db.test.ts` runs the prerequisites against a real Postgres as a non-owner role, with the flag on and off.
- `src/lib/db/__tests__/rls-cron-context.test.ts` is the cron and sweep guard.
- `src/lib/db/__tests__/migration-database-url.test.ts` covers the migration connection.
