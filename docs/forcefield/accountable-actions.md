# Actions need a person (accountable actions)

Anyone, human or AI agent, may read a page on a Forcefield-protected site. A
state-changing action (a form submission, login, sign-up, checkout, account
change or data export) should come from an accountable party: a real browser
session, or an AI agent that presents a verified signature naming the person or
organization it acts for and what it may do.

This phase is **watch mode only**. Forcefield records a verdict for every action
and counts it. It never blocks, slows or alters the request.

## Which requests are actions

The rules are ruleset data (`stateChange` in `src/lib/forcefield-web/ruleset.ts`,
defaults in `src/lib/forcefield-web/accountability.ts`), served by
`/api/forcefield/ruleset`, so a change reaches every connected site without a
re-vendor.

- Any `POST`, `PUT`, `PATCH` or `DELETE` on a path that is not a static asset.
- Named action routes give the action a kind: login (`/login`, `/wp-login.php`,
  ...), signup, checkout, account, export, contact, comment. A route can list
  its own methods: the export routes count a `GET` too.
- `siteRoutes` adds routes for one site label, checked before the shared list.
- `ignorePaths` are never actions (telemetry beacons, the Forcefield control
  plane).
- A `GET` of a named route that does not list `GET` (loading the login page) is
  a read, not an action.

## The verdict

For each action, `accountabilityVerdict` returns one class and one reason,
strongest proof first:

| Class | Reason | Would hold |
|---|---|---|
| `signed_principal` | `verified_principal`: a delegation verified against a registered issuer; `mandate` is `within` when a presented scope covers the path | only when `mandate` is `outside` |
| `browser_session` | `site_attested_session`: the site itself verified a signed-in session or service credential | no |
| `unaccountable` | `principal_unverified`: a delegation was presented but did not verify (bad signature, unknown issuer, expired, replayed jti) | yes |
| `unaccountable` | `agent_without_principal`: an allowlisted agent or a Web Bot Auth signature, which names the software but not the person | yes |
| `unaccountable` | `headless_browser`, `header_mismatch`, `browser_from_datacenter`, `no_fetch_metadata`, `script_client` | yes |
| `browser_session` | `browser_signals`: browser UA, browser header shape, Fetch Metadata (`Sec-Fetch-Site` / `Sec-Fetch-Mode`), not a datacenter network | no |

The edge cannot verify a principal: it holds no issuer keys. An agent presents
its credential in the `x-forcefield-delegation` header. The vendored monitor
forwards it to the ingest for a state-changing request only; the central
observe route accepts it in the request body as `delegation`. That boundary
verifies it fail-closed (10-minute signing window, single-use jti) through
`src/lib/forcefield/action-accountability.ts`, stores only the verdict, and
refines the action. A body that claims `signed_principal` without a credential
that verifies is downgraded to `unaccountable / principal_unverified`.

## What watch mode records

On the event the request already produces, or on a new `site.action_observed`
event when the request had no other tell:

- `accountability`, `acct_reason`, `action_kind`, `method`, `would_hold`, and
  `mandate` (verified principals only). Closed vocabularies, validated again at
  the ingest.
- The principal itself rides on the existing Know the Principal props
  (`principal_status`, `principal`, `principal_issuer`, `principal_scopes`). The
  raw credential is never stored.
- `site.action_observed` for a browser action carries no session key or
  fingerprint. An unaccountable action carries `sig` and `fp`, so it links to
  its operator on the board.

Not recorded on their own: a write from a session the site attested
(`recordAttested: false` by default, because a signed-in app makes many API
writes per page and each one is accountable by definition), and our own
verified synthetic probes. The board tile excludes synthetic rows.

The board tile ("Actions need a person", Agent defense tab of
`/admin/site-analytics`) shows per site the count for each class and the
would-hold count, with the reasons that would trip a hold.

## Turning on "hold for review" later

Holding stays off until every one of these is true, measured on the board and
with `npm run forcefield:accountability-replay` (read-only, counts only):

1. At least 14 consecutive days of watch-mode data on the site, with the site
   forwarding actions (a non-zero `browser_session` count).
2. Zero real customers in the would-hold set over those 14 days: every
   would-hold reason is reviewed and none of the held actions is a real person's
   submission (support tickets, orders and sign-ups reconciled against the
   site's own records).
3. `no_fetch_metadata` and `browser_from_datacenter` are reviewed by name. They
   are the reasons most likely to catch a real person (an old browser, a
   corporate VPN); if either holds a real customer, it stays report-only.
4. Every agent the site wants to keep working has a registered delegation
   issuer, and its mandates cover the routes it uses (`mandate: within`).
5. The site owner opts in for that site, and the hold applies per action kind
   (start with `export` and `account`, not `login` or `checkout`).

## What the history shows

`npm run forcefield:accountability-replay` (read-only, counts only) re-classifies
recorded events. Older rows never stored the HTTP method, and a plain browser
POST was never forwarded at all, so history only shows action-route hits from
automation that was already recorded for another reason: an upper bound on
automation that says nothing about real browser volume. The 14-day window above
starts when sites run the new core. Results stay out of this repository (it is
public); they go in the private review notes.
