# Integrations — Wolfpack Instinct

Every external system is wrapped. Call sites never import SDKs directly.

## Microsoft Graph

Per-user OAuth (migration 006 moved tokens from tenant-wide to per-user). One file per Graph surface in `src/lib/integrations/microsoft-*.ts`. Capability gates on the route side map 1:1 to Graph scopes; the capability grant IS the scope grant to the user.

### Scope → integration → capability table

| Graph scope | Integration file | Route dir | Capability | Cache migration |
|---|---|---|---|---|
| `Mail.Read`, `Mail.Send` | `microsoft-mail.ts` | `src/app/api/mail/` | `mail.read`, `mail.send` | 022 |
| `Calendars.ReadWrite` | `microsoft-calendar.ts` | `src/app/api/calendar/` | `calendar.read`, `calendar.write` | 022 |
| `Tasks.ReadWrite` | `microsoft-tasks.ts` | `src/app/api/tasks/` | `tasks.read`, `tasks.write` | 018 |
| `Files.ReadWrite.All` | `microsoft-files.ts` | `src/app/api/files/` | `files.read`, `files.write` | 023 |
| `People.Read` | `microsoft-people.ts` | `src/app/api/people/`, `src/app/api/contacts/` | `people.read` | 023 |
| `User.Read.All`, `Directory.Read.All` | `microsoft-directory.ts` | `src/app/api/directory/` | `directory.read` | 027 |
| `MailboxSettings.Read` | `microsoft-mailbox.ts` | `src/app/api/mailbox/` | `mailbox.read` | 027 |
| `Team.ReadBasic.All`, `Channel.ReadBasic.All` | `microsoft-teams-chat.ts`, `microsoft-channel-messages.ts` | `src/app/api/teams/` | `teams.read` | 026 |
| `ChannelMessage.Read.All` | `microsoft-channel-messages.ts` | `src/app/api/teams/` | `teams.read` | 026 |
| `Notes.ReadWrite.All` | `microsoft-onenote.ts` | `src/app/api/onenote/` | `onenote.read`, `onenote.write` | 024 |
| `OnlineMeetings.ReadWrite` | `microsoft-online-meetings.ts` | `src/app/api/online-meetings/` | `meetings.write` | 026 |
| `Tasks.ReadWrite` (Planner) | `microsoft-planner.ts` | `src/app/api/planner/` | `planner.read`, `planner.write` | 025 |
| `Group.Read.All` | `microsoft-groups.ts` | `src/app/api/groups/` | `groups.read` | 025 |
| `Presence.Read.All` | `microsoft-presence.ts` | `src/app/api/presence/` | `presence.read` | — (no cache) |
| `Contacts.ReadWrite` | `microsoft-contacts.ts` | `src/app/api/contacts/` | `contacts.read`, `contacts.write` | 023 |

### Adding a new Graph-backed module

1. Pick the Graph scope(s) you need from the Microsoft Graph docs.
2. Create `src/lib/integrations/microsoft-<surface>.ts`. Export typed `Result<T, IntegrationError>` functions — never throw.
3. Add a cache migration if the surface needs one: `NNN_ms_<surface>_cache.sql`. Use existing caches (022–027) as templates; cache TTL pattern is per-user rows with `fetched_at` + `expires_at`.
4. Add capability(ies) in `src/lib/auth/capabilities.ts` and map to roles in `src/lib/auth/role-capabilities.ts`.
5. Add routes in `src/app/api/<surface>/`. Every handler starts with `requireCapability`.
6. Add a signal extractor in `src/lib/learning/<surface>-signals.ts` so the data feeds the learning loop.
7. Add the scope to the user's consent flow — the existing consent UI reads from `src/lib/ms-capabilities.ts`.
8. Contract tests: 200, 401, 403, and 403-with-scope-missing (Graph returns 403 → integration returns `{ error: { kind: 'scope_missing' } }` → route returns 403 with clear message).

### Graph-specific known failures

- User granted scope in tenant consent but token not yet refreshed → 403 from Graph. Integration must surface as `scope_missing` and UI must offer "Reconnect Microsoft" link.
- Throttling (429) from Graph → integration retries once with `Retry-After` honored, then surfaces as `rate_limited`.
- 5xx from Graph → `service_unavailable`; UI shows a soft error, not a blank state.

## QuickBooks

`src/lib/quickbooks.ts` + routes under `src/app/api/quickbooks/`. OAuth token refresh handled inside the lib. Triple-write ingested data (customers, invoices) through `lib/triple-write.ts`. Migration 004.

## Plaud (voice recordings)

`src/lib/plaud.ts` + routes under `src/app/api/plaud/` (if present — check). Recording metadata joins the assistant meeting source (migration 008). Migration 007 defines tables.

## Resend (transactional email)

`src/lib/email.ts` (where present) / `src/lib/notifications/*`. All sends go through the notifications layer so we get a DB row per send (migration 020) and can reconstruct a user's notification history. Requires `RESEND_API_KEY` + sender domain.

## Sites (GitHub integration)

`src/lib/sites.ts` + `src/lib/github-client.ts`. Drives the Sites module: commits content to a target repo via GitHub API, webhooks trigger re-ingest. Requires `GITHUB_TOKEN_WOLFPACK_AGENCY` + `WOLFPACK_SITES_WEBHOOK_SECRET` in Vercel.

## Neo4j / Qdrant (internal stores, not third-party)

Accessed through `src/lib/neo4j.ts` and `src/lib/qdrant.ts`. Never write directly — use `src/lib/triple-write.ts`. See `.ai/data-stores.md`.
