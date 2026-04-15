# Notifications — category + source conventions

The notifications library is the **only** module that inserts rows into
`instinct_notifications`. Every other stream calls `notify(...)` from
`src/lib/notifications/in-app.ts`. Do not write to the table directly —
preferences, dedup, analytics, and learning hooks all live in the lib.

## Category naming

Format: `<domain>.<event>` — lowercase, dot-separated, present tense.

The `source` field identifies the emitting module in one token (e.g. `hr`,
`tasks`, `security`). The `source_id` field is the id in the source system
and is the key used for dedup.

### Canonical categories (owner → category)

| Owner module   | `source`       | Category                        | Example use                                                    |
|----------------|----------------|---------------------------------|----------------------------------------------------------------|
| HR             | `hr`           | `hr.onboarding_stalled`         | New hire has not completed step N for >48h                     |
| HR             | `hr`           | `hr.benefit_enrollment_due`     | Employee enrollment window closes in 3 days                    |
| HR             | `hr`           | `hr.document_expiring`          | I-9 / license / policy within 30 days of expiry                |
| Tasks          | `tasks`        | `tasks.due_soon`                | MS To Do task due within 24h                                   |
| Tasks          | `tasks`        | `tasks.overdue`                 | MS To Do task past due, not completed                          |
| Tasks          | `tasks`        | `tasks.assigned_to_you`         | Shared list task just assigned                                 |
| Finance        | `finance`      | `finance.budget_warning`        | Category spend > 80% of budget                                 |
| Finance        | `finance`      | `finance.invoice_overdue`       | QB invoice past due                                            |
| Finance        | `finance`      | `finance.cashflow_alert`        | Projected balance below floor                                  |
| Security       | `security`     | `security.login_unusual`        | New device / geo login detected                                |
| Security       | `security`     | `security.token_reuse_detected` | Refresh-token reuse family revocation                          |
| Security       | `security`     | `security.mfa_challenge_failed` | Repeated failures on a single account                          |
| Integrations   | `integrations` | `integrations.token_expired`    | QB / MS Graph refresh failed                                   |
| Integrations   | `integrations` | `integrations.sync_failed`      | Graph / Plaud / QB sync errored > N times                      |
| Team           | `team`         | `team.invite_accepted`          | New teammate accepted invite                                   |
| Team           | `team`         | `team.role_changed`             | Role promotion/demotion (also mirrored in audit)               |
| Audit          | `audit`        | `audit.unusual_access_pattern`  | Audit stream flagged activity worth a human glance             |

## Priorities

- `low` — informational, batched in digest, de-emphasized in UI.
- `normal` — default. Digest-eligible, shown in bell.
- `high` — shown at top of bell; included in daily digest.
- `critical` — **bypasses quiet hours and the batched digest**. If email is
  enabled, sent immediately rather than waiting for the window.

## Dedup convention

Pass `dedup: true` + a stable `sourceId` when the same underlying event
can fire repeatedly (e.g. a sync retry loop, a task-due-soon tick). The
lib will skip insert if a non-read, non-dismissed notification with the
same `(source, source_id, user_id)` already exists.

Pick a deterministic `sourceId` per domain:
- `hr.onboarding_stalled` → `onboarding:<onboarding_id>:step:<step_key>`
- `tasks.due_soon` → `task:<ms_task_id>`
- `finance.budget_warning` → `budget:<budget_id>:period:<yyyy-mm>`
- `security.login_unusual` → `login:<session_id>`
- `integrations.token_expired` → `integration:<provider>`

## Expiry

Use `expiresInHours` for anything that becomes stale (e.g. "task due in 24h"
should auto-hide after the deadline passes). Expired rows remain in the
table for audit but are excluded from bell / inbox / digest queries.

## Learning signals

Every notification feeds `src/lib/learning/notification-signals.ts`:
- `system.notification_created` → input to per-category volume + noise.
- `system.notification_read` → engagement, with `seconds_to_read`.
- `system.notification_clicked` → strongest engagement signal.
- `system.notification_dismissed` → negative signal; teaches the ranker
  to auto-downgrade or suppress noisy categories.

A ranker is not wired yet — the extractor functions return raw rates so
the ranker can be added later without back-filling events.

## Do NOT

- **Do not** INSERT into `instinct_notifications` from anywhere but
  `in-app.ts`.
- **Do not** bypass preferences. The lib decides whether to auto-dismiss
  or batch — callers just describe the event.
- **Do not** invent new categories ad-hoc. Add rows to the table above as
  part of the same PR that introduces the emission.
