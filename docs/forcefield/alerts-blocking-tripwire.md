# Forcefield alerts, automatic blocking and the tripwire (operating behavior)

Internal. How these three controls behave in code today, so support, sales and
whoever is on call describe them the same way. No em dashes.

## 1. Alerts

Source: `src/lib/forcefield-web/alerts.ts`, run by the `forcefield-alerts` cron
(`src/app/api/cron/forcefield-alerts/route.ts`, every 10 minutes).

- **What alerts.** Honeytoken (trap) trips and payload attacks seen in the live
  inspection stream, plus canary trips (section 3) and the silence check (below).
- **Incidents, not attack classes.** Events are grouped into incidents
  (`src/lib/forcefield-web/incidents.ts`): one site, one source burst, one fixed
  6-hour window (`ALERT_WINDOW_HOURS`, aligned to 00:00, 06:00, 12:00 and 18:00
  UTC). Two events are the same burst when they share a fingerprint, share a
  session signature, or follow each other within 120 seconds
  (`BURST_GAP_SECONDS`). A scanner that rotates its headers on every request is
  therefore one incident, with every attack class it tried listed in it. Synthetic
  probes (`props.synthetic`, token-attested) are never alerted on or counted.
- **Severity routing.** An incident is emailed IMMEDIATELY only when it needs
  attention: a decoy or honeytoken trip (proven hostile reached hidden content),
  or any request that was recorded but not stopped (watch / report-only). One
  email per incident lists each attack class with its attempts, sources,
  outcome, first and last time and paths. A repeat inside the window does not
  email again; a new burst does. An incident where every request was blocked or
  contained is NOT emailed when it happens; it goes into the daily digest.
- **Daily digest.** The first cron run at or after 08:00 US Eastern each day
  sends one digest (claimed once per Eastern date in the dedupe store, so it
  cannot double-send; a failed send is retried on later runs). It covers every
  blocked incident whose window started between the previous and the current
  08:00 ET cutoff (each floored to a window boundary), per site: attack type,
  attempts, distinct sources (fingerprints), first and last time in UTC and ET,
  top paths and outcome, plus totals and a link to the board filtered to the
  site (`/admin/site-analytics?tab=forcefield&view=operator&days=7&site=<label>`).
  Consecutive periods partition time, so every blocked incident appears in
  exactly one digest. A digest that failed or was never sent rolls its period
  into the next one (at most 7 days back). With nothing to report the digest is
  skipped and recorded as `empty`. Each run records
  `forcefield.alert_digest_built`. On demand: `?job=digest`.
- **Site names.** Emails show the site's hostname, never the internal label:
  `instinct` is the Instinct public URL host, shim labels map through the
  product catalog (`weekendwithporsche` to weekendwithporsche.com), a label that
  is already a hostname is kept, and an unknown label falls back to itself
  (`src/lib/forcefield-web/site-host.ts`).
- **Delivery.** In-app through `fanoutToTeam` and email through Microsoft Graph
  (`sendViaGraph`), to the security owner only (`FORCEFIELD_ALERT_RECIPIENT_EMAIL`,
  comma-separated to widen). Never Resend.
- **Reading an alert email.** One email per incident, from one shared template
  (`src/lib/forcefield-web/alert-email.ts`). It leads with the severity and a
  plain headline ("A hostile agent took a decoy on ogiam.com and was
  contained"), then the response: *Contained* (sent into the decoy maze),
  *Blocked* (turned away at the edge), *Recorded only* (the site is in watch
  mode) or *Partly stopped*, and either "No action needed" or the one
  recommended action. The details table gives the exact first and last event
  times in UTC and US Eastern (the 6-hour window is shown only as context), the
  request count, the paths, the source (country, network type, client type,
  identified agent), the signal and its confidence, and the fingerprint and
  session signature. "Open this incident on the board" lands on
  `/admin/site-analytics?tab=forcefield&view=operator&find=<session signature>`.
- **Signals.** A *decoy* is a link or record hidden from people and never
  offered to them, so only an automated agent can reach it. A *honeytoken* is a
  planted value with no legitimate use. A *payload attack* is a request that
  carried a live attack payload (SQL injection, XSS and similar). All three are
  high-confidence hostile signals.
- **The automatic-block decision rides the same email.** When a trap trip asks
  for an automatic block, the decision (applied, or not applied because the
  fingerprint is shared by legitimate visitors) is recorded and shown in the
  incident email. It is never a second email.
- **Recipients.** Wolfpack only (`FORCEFIELD_ALERT_RECIPIENT_EMAIL`). During the
  build phase no client or tenant receives Forcefield alerts; a client-facing
  version of the template exists for previews only.
- **The outcome is recorded.** Each alert row keeps `delivery_status`
  (`delivered` or `failed`), `delivery_detail` (the reason, such as
  `email:no_mail_from`), `attempts` and `dispatched_at` (migration 291). Every
  dispatch records an awaited `forcefield.web_alert_dispatched` event with the
  outcome. A failed alert is retried on later scans, up to 5 attempts.
- **Silence check.** Once a day (the 15:00 UTC run, after the digest in both EDT
  and EST, or on demand with `?job=silence`), Forcefield raises an alert when
  events needing attention arrived in the last 24 hours but no immediate alert
  was delivered, or when hostile traffic fell in today's digest period but the
  digest was neither delivered nor found empty. It records
  `forcefield.alert_silence_detected` with the reason. At most one per UTC day.
- **Sender.** Mail goes out through `sendViaGraph` as the `MS_MAIL_FROM`
  mailbox (shared with password resets and invites). Exchange shows that
  mailbox's own display name, so the `fromName` the alert passes is not what
  readers see. Sending from a dedicated shared mailbox needs a per-call sender
  in `sendViaGraph` (not supported today) and a mailbox created in Exchange.

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
