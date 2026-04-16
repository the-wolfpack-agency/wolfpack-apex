# Data Stores — Wolfpack Instinct

Three stores, one writer (`src/lib/triple-write.ts`). Postgres is the source of truth; Qdrant and Neo4j are derived views optimized for search and relationship queries.

## Postgres (Neon)

Schema evolves via numbered migrations in `src/db/migrations/`. Run with `npm run migrate`. `npm run vercel-build` runs them before `next build` so deployed code and schema are always in lockstep.

### Migration map (001 → 027)

| # | File | Purpose |
|---|---|---|
| 001 | `foundation.sql` | Users, workspaces, sessions, knowledge docs, journal entries, core analytics + audit tables |
| 002 | `learning_views.sql` | Materialized / regular views that aggregate analytics for the learning loop |
| 003 | `assistant_memory.sql` | Per-user assistant memory / conversation history |
| 004 | `quickbooks.sql` | QuickBooks OAuth tokens + synced entities (customers, invoices) |
| 005 | `microsoft_graph.sql` | First-cut Graph token storage (tenant-level) |
| 006 | `ms_tokens_per_user.sql` | Migrates Graph tokens from tenant to per-user |
| 007 | `plaud_integration.sql` | Plaud voice-recording metadata + transcripts |
| 008 | `assistant_meeting_source.sql` | Joins meeting recordings → assistant memory |
| 009 | `sites.sql` | Sites module (content-editing surface backed by GitHub) |
| 010 | `people.sql` | Internal people directory (distinct from Graph `directory` cache) |
| 011 | `hr_documents.sql` | HR doc storage + access metadata |
| 012 | `hr_document_metadata.sql` | Extracted fields (benefits carrier, plan ID, etc.) |
| 013 | `onboarding.sql` | Employee onboarding flows |
| 014 | `instinct_table_aliases.sql` | Renames for the Apex→Instinct rebrand |
| 015 | `workspace.sql` | Workspaces + team membership |
| 016 | `setup_events.sql` | Setup wizard analytics + `instinct_setup_funnel` view |
| 017 | `refresh_tokens.sql` | `instinct_refresh_tokens`: family_id, revoked_at, used_at (token-theft detection) |
| 018 | `ms_tasks.sql` | Graph Tasks cache |
| 019 | `audit_log.sql` | Append-only hash-chained audit log |
| 020 | `notifications.sql` | Per-notification DB row; drives the Resend fan-out |
| 021 | `capability_overrides.sql` | Per-user capability grants on top of role defaults |
| 022 | `ms_mail_calendar_cache.sql` | Graph Mail + Calendar caches |
| 023 | `ms_files_people_cache.sql` | Graph Files + People caches |
| 024 | `ms_teams_onenote_cache.sql` | Graph Teams + OneNote caches |
| 025 | `planner_groups_cache.sql` | Graph Planner + Groups caches |
| 026 | `teams_channels_meetings.sql` | Graph Teams channels + online-meetings |
| 027 | `directory_mailbox.sql` | Graph Directory + Mailbox caches |

### Key tables by domain

- **Auth**: `users`, `user_sessions`, `instinct_refresh_tokens`, `capability_overrides`.
- **Audit**: `audit_log_entries` — hash-chained, immutable (enforced by trigger + `audit-log-immutable.test.ts`).
- **Analytics**: `analytics_events` — ApexEventType rows; downstream learning views read from here.
- **Workspace**: `workspaces`, `workspace_members`, `instinct_setup_events`, view `instinct_setup_funnel`.
- **Graph caches**: one table per surface (`ms_mail_cache`, `ms_calendar_cache`, …) with `user_id`, `item_id`, payload, `fetched_at`, `expires_at`.

### RLS

Where enforced, Row-Level Security keys on `workspace_id` and `user_id` from the JWT claim. Check migration source before assuming RLS is on a given table.

## Qdrant (vector)

Collection names mirror the Postgres entity (e.g. `knowledge_docs`, `journal_entries`, `people`). Writes come from `triple-write.ts` after the Postgres insert succeeds. Reads are driven by the assistant (`src/lib/assistant.ts`) via `src/lib/qdrant.ts`. If Qdrant is down, `triple-write` logs `system.triple_write_degraded` and moves on — never blocks the user action.

## Neo4j

Nodes and edges represent:
- `(:User)-[:AUTHORED]->(:Doc)` and `(:User)-[:ATTENDED]->(:Meeting)` — authorship + participation.
- `(:Person)-[:WORKS_WITH]->(:Person)` — org graph, populated from Graph Directory.
- `(:Doc)-[:REFERENCES]->(:Topic)` — topic-index for the assistant.
Populated by `triple-write.ts`, read by learning signal extractors in `src/lib/learning/*` for cross-entity reasoning.

## Learning views

Defined in migration 002 and referenced throughout `src/lib/learning/`. They turn raw `analytics_events` rows into per-user / per-workspace signal rows that the assistant and scoring features consume.
