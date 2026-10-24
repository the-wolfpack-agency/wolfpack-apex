# Forcefield alerts, automatic blocking and the tripwire (operating behavior)

Internal. How these three controls behave in code today, so support, sales and
whoever is on call describe them the same way. No em dashes.

## 1. Alerts

Source: `src/lib/forcefield-web/alerts.ts`, run by the `forcefield-alerts` cron
(`src/app/api/cron/forcefield-alerts/route.ts`, every 10 minutes).

- **What alerts.** Honeytoken (trap) trips and payload attacks seen in the live
  inspection stream, plus canary trips (section 3) and the silence check (below).
- **One alert per incident and window.** An incident is one site plus one attack
  class (for example `sql_injection`, or `honeytoken_trip`) inside a fixed
  6-hour window (`ALERT_WINDOW_HOURS`, aligned to 00:00, 06:00, 12:00 and 18:00
  UTC). A repeat inside the window does not alert again. The same attack in the
  next window does. A different attack class in the same window is its own
  incident. The old key was the site and kind with no window, so the first alert
  per site silenced every later one; that is what stopped alerts after 09-28.
- **Delivery.** In-app through `fanoutToTeam` and email through Microsoft Graph
  (`sendViaGraph`), to the security owner only (`FORCEFIELD_ALERT_RECIPIENT_EMAIL`,
  comma-separated to widen). Never Resend.
- **The outcome is recorded.** Each alert row keeps `delivery_status`
  (`delivered` or `failed`), `delivery_detail` (the reason, such as
  `email:no_mail_from`), `attempts` and `dispatched_at` (migration 291). Every
  dispatch records an awaited `forcefield.web_alert_dispatched` event with the
  outcome. A failed alert is retried on later scans, up to 5 attempts.
- **Silence check.** Once a day (the 12:00 UTC run, or on demand with
  `?job=silence`), if there were hostile events in the last 24 hours but no alert
  was delivered to anyone, Forcefield records `forcefield.alert_silence_detected`
  and sends an alert saying the alert path is broken. At most one per UTC day.

## 2. Automatic blocking

Source: `src/lib/forcefield/blocked-fingerprints.ts`,
`src/lib/forcefield/edge-enforcement.ts`, `src/lib/agent-operators.ts`.

- **Every automatic block passes one gate** (`gateAutoBlock`): the edge policy
  must be in `enforce` mode with `auto_block` on, and `qualifiesForAutoBlock`
  must say yes, which means proven hostile (pinned by proof such as a trap trip),
  never an inferred grouping, never an `elevated` operator. A refusal records
  `forcefield.autoblock_skipped`. This covers honeytoken auto-blocks,
  learned-signature auto-blocks and `/edge/decide` auto-blocks.
- **Automatic blocks expire.** Each automatic fingerprint row expires 14 days
  (`AUTO_BLOCK_TTL_DAYS`) after that fingerprint was last seen; a fresh sighting
  re-arms it. Automatic operator blocks from `/edge/decide` expire 14 days after
  they are written. An expired row no longer enforces: the ruleset, the observe
  route and the blocked-operator list all filter on `expires_at`.
- **Human blocks do not expire.** An admin block has `expires_at` NULL, and an
  admin re-block clears any expiry an automatic write left.
- **Turning auto-block off withdraws every automatic block at once,** because
  automatic rows are served only while the policy still allows auto-blocking.
- **Fan-out cap.** One operator key is a coarse behavioral bucket. If an
  automatic operator block resolves to more than 20 fingerprints
  (`AUTO_BLOCK_MAX_FINGERPRINTS`), only fingerprints that themselves carried proof
  (a trap trip, a payload attack, a honeypot form field) are blocked, and
  `forcefield.autoblock_capped` is recorded. 20 was chosen from production data:
  admin-reviewed blocks resolved to 17 and 4 fingerprints; the one learned
  auto-block resolved to 101 from 40 countries, which is a bucket, not an actor.
- **Counts are honest.** An automatic block returns the rows it actually
  inserted, so an hourly re-run that adds nothing reports 0, and
  `forcefield.signature_promoted` is awaited so it is not lost when the
  serverless function returns.
- **Existing rows.** Migration 290 gave every automatic row already in the table
  an expiry of its creation time plus 14 days, so old unbounded automatic blocks
  lapse on the same schedule. Admin rows were left permanent.

## 3. The tripwire (canaries)

Source: `src/lib/forcefield/tripwire.ts`, `src/lib/forcefield/canary-store.ts`,
`src/lib/forcefield/contain.ts`.

- **Every canary kind is detectable where it would be used.** A decoy value is a
  long random string nothing legitimate contains, so it trips when it appears as
  a whole token in a request URL or query, header values, a message or tool
  arguments, or a tool's output. Structural matches also trip: the exact decoy
  route path, the honeypot tool name, a honey-row id. Values shorter than 8
  characters only match structurally, so they cannot collide with ordinary text.
- **Where it is checked.**
  - Inbound requests to a connected site, through `/api/forcefield/observe`
    (the raw URL, query included).
  - The inbound message to `/api/agents/act`. A trip returns 403
    `agent_quarantined` before any tool runs.
  - Every agent tool call, including a call to a tool name that is not
    registered (a honeypot tool has no handler).
  - Every agent tool's output. A trip withholds the output from the agent.
- **What a trip does.** For an agent: its scope is revoked and the trip is
  written to the OGIAM ledger. For every trip: one awaited
  `forcefield.canary_tripped` event per hit, one hash-chained audit entry
  (`forcefield.canary_tripped`), and an alert through the path in section 1,
  deduped per decoy, client and 6-hour window. Only hit metadata is recorded
  (canary id, kind, where it was seeded, which surface carried it), never the
  decoy value or the request payload.
- **Failure mode.** The tripwire degrades open on an unexpected error (it is a
  secondary control behind the OGIAM gate) and logs a warning; it never breaks a
  site's request.
