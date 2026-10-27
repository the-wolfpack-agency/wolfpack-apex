# Self-serve onboarding: add a site, get its alerts

Status: built, in the build phase. Only Wolfpack addresses can complete it and
receive email (see "Opening it to clients" below).

## The two-step journey (current)

1. **Website and email** at `/forcefield/signup`. The server takes one
   read-only look at the site's home page (`platform-detect.ts`: a single GET
   through the platform-scan SSRF guard, re-checked on every redirect, 5 s
   timeout, 512 KB cap; a failure is "other") and the page shows the one
   install option that fits: WordPress, Vercel / Next.js, or "Connect it for
   me" (the concierge request). The DNS / file path below stays one click away.
2. **One install button.** For WordPress: install the plugin (the zip from
   `GET /api/forcefield/wordpress/plugin` until the WordPress.org listing is
   live; then flip `WORDPRESS_DIRECTORY_LISTED` in `onboarding-client.ts` and
   the button installs from the site's own wp-admin), then Settings ->
   Forcefield -> Connect. No key, no DNS record, no file:
   - `POST /api/forcefield/wordpress/connect` { site, email, secret }: the
     plugin's random secret (`ffp_...`) is stored only as a SHA-256
     (`forcefield_signup_requests.plugin_secret_sha256`, migration 299) and a
     server-issued challenge comes back, which the plugin stores.
   - `POST .../connect/prove` { secret }: the server fetches the challenge from
     the site itself (`/?rest_route=/ogiam-forcefield/v1/challenge`, SSRF guard
     on every hop, redirects only within the site, constant-time compare).
     The plugin running on the site and answering is the ownership proof
     (`ownership_method = 'wordpress_plugin'`, also stamped on the challenge
     row). It provisions the tenant (platform `wordpress`) and sends the
     existing confirmation email.
   - The email's link is the **sign-in link**: clicking Confirm confirms the
     address and returns a signed dashboard session (`dashboard-session.ts`,
     purpose `ff_dashboard`, 30 days, tenant id only), so that browser lands
     on its dashboard without ever handling a key.
   - `POST .../connect/claim` { secret }: answers 202 until the link is clicked,
     then returns a fresh site key exactly once (`rotateTenantToken`;
     `plugin_linked_at`). The plugin checks on its settings page and once a
     minute through WP-Cron, saves the key and starts in watch mode.
3. **First hour.** Within minutes of the first real visitor (synthetic monitor
   traffic excluded; at least 5 minutes after the first event, then the next
   10-minute cron run) the confirmed address gets "Your first hour with
   Forcefield on <site>": agents seen, welcomed, slowed and blocked, the top
   three by activity, and the dashboard link (`renderFirstHourEmail`, sent
   once through the guarded sender, claimed by `first_evidence_at`).
4. **Live dashboard.** `/forcefield/dashboard` "Who visited" lists each agent,
   what it did and how Forcefield handled it (blocked, slowed, welcomed,
   caught in watch mode, watched), from `tenant-activity.ts`.

The ingest (`/api/forcefield/observe`) now tags every row it records with the
tenant whose key sent it (`site_analytics_events.forcefield_tenant_id`); before
this, events arriving on a tenant key through the WordPress plugin or the
Next.js middleware never reached that tenant's dashboard or alerts.

Analytics for the new steps: `forcefield.onboarding_platform_detected`,
`forcefield.wordpress_connect_started`, `forcefield.wordpress_ownership_verified`
/ `_failed`, `forcefield.wordpress_linked`, `forcefield.dashboard_signed_in`,
`forcefield.wordpress_plugin_downloaded`. Audit (hash-chained): connect started,
ownership verified (never the secret or challenge), plugin linked (never the key).

### Local WordPress proof

`scripts/forcefield-wp-local-proof.sh up|run|down` starts a throwaway WordPress
and MySQL (official images), runs `tests/e2e/forcefield-wordpress-live.spec.ts`
(signup, plugin install, Connect, sign-in link, dashboard populated) and removes
them. It needs a local dev server on a throwaway Postgres started with
`FORCEFIELD_DEV_SITE_ORIGINS=http://wp.localtest.me:8080` (lets the server reach
the local site) and `FORCEFIELD_MAIL_OUTBOX_DIR=<dir>` (mail is written there,
never sent). Both settings are ignored whenever `NODE_ENV` is `production`.
The first-hour email is rendered without sending by
`npm run forcefield:email-preview -- --first-hour --tenant <id> --out <dir>`
(read-only: `PGOPTIONS="-c default_transaction_read_only=on"`).

### WordPress.org submission

`npm run forcefield:wp-plugin-zip` writes `dist/wordpress/ogiam-forcefield-<version>.zip`
(the same writer as the in-app download; it checks the readme's Stable tag and
changelog). The readme carries the "External services" disclosure the
directory requires. Open item before submitting: the directory only accepts
GPL-compatible plugins, and the plugin is marked `License: Proprietary`.

## What a person does (the DNS / file path)

1. **Add the site** at `/forcefield/signup`: the website and the email that
   should receive its alerts (name optional). Behind it:
   `POST /api/forcefield/onboarding` (public, per-IP rate limited, honeypot,
   validated). The browser gets a one-time setup key, stored server-side only as
   a SHA-256 (`forcefield_signup_requests.setup_key_sha256`, kind `self_serve`).
2. **Prove ownership** at `/forcefield/setup`: one DNS TXT record
   (`ogiam-site-verification=<token>`) or one text file at
   `/.well-known/ogiam-site-verification.txt`, then one click on "Verify
   ownership". This is the platform-scan ownership check
   (`src/lib/platform-scan/authorization`, `issueVerificationToken` /
   `checkVerification`, SSRF-guarded, constant-time), run in its own workspace
   (`forcefield-self-serve`). Proven ownership replaces the operator review for
   this path: it provisions the tenant (`createForcefieldTenant`), returns the
   ingest token once (kept in the browser as the dashboard token) and sends the
   confirmation email.
3. **Connect** (same page): the existing quick-start for the site's stack
   (Cloudflare Worker env or Next.js middleware, `buildTenantQuickstart`), or
   "Connect it for me", which records a concierge request the operator sees on
   `/admin/forcefield/signups`.
4. **Confirm the alert email**: the email links to `/forcefield/confirm?token=`.
   The token is a signed JWT (crypto registry, purpose `ff_notify_confirm`,
   48 hours); only its SHA-256 is stored and it works once. The page confirms
   on a click, never on load, so a mail scanner confirms nothing.
5. **First evidence**: the `forcefield-tenant-notify` cron (every 10 minutes)
   sends "Forcefield is watching <site>" once, on the first run after the
   tenant's first event arrives. After that the confirmed address gets one email
   per incident on its own site (immediate alerts, shared alert template with
   audience `tenant`) and a daily summary at 13:00 UTC when the site saw traffic.
   Every tenant email links to `/forcefield/dashboard` (never `/admin`) and has
   one unsubscribe link (`/forcefield/unsubscribe?token=`).

On `/forcefield/dashboard` the "Alert email" panel shows where alerts go and
lets the tenant change the address (a new confirmation is sent), resend the
confirmation, or remove it.

The operator alert path is unchanged: Wolfpack (`FORCEFIELD_ALERT_RECIPIENT_EMAIL`)
still gets every incident.

## The build-phase rule and the one switch

Every tenant email goes through `sendForcefieldTenantMail`
(`src/lib/forcefield-web/tenant-mail.ts`), which refuses any address whose
domain is not on the recipient allowlist before the mail provider is called.
The allowlist is one setting:

| `FORCEFIELD_RECIPIENT_DOMAINS` | Effect |
|---|---|
| unset (default) | `thewolfpack.agency` only. Build phase. |
| `thewolfpack.agency,pilot-client.com` | Exactly those domains (a pilot). |
| `*` | Any domain. Out of the build phase. |

While the build phase is on, a signup with a non-allowlisted address is filed in
the operator-reviewed request queue (the existing `/admin/forcefield/signups`
flow) and nothing is emailed to it; setting such an address on a tenant is
refused (HTTP 403).

**Opening it to clients** is the operator changing that one setting: in the
Wolfpack Instinct project's environment variables (Production), set
`FORCEFIELD_RECIPIENT_DOMAINS` to `*` (or the pilot domains), then redeploy. No
code change. The guard test
`src/__tests__/forcefield-alert-delivery-guardrail.test.ts` fails the build if
any delivery path can send to an address the allowlist refuses.

## Not built yet: no-code connect

The mandate is a Cloudflare-style connect: the customer changes one DNS record
and Forcefield runs at our edge (Cloudflare for SaaS custom hostnames, with a
Worker running `src/lib/forcefield-web/adapters/cloudflare-worker.ts`). That is
inline infrastructure in front of customer traffic and needs approval first. It
plugs in at `NO_CODE_CONNECT` in `src/lib/forcefield-web/onboarding.ts` (today
`status: "planned"`), and the setup page already shows it as "Coming soon" above
the current options.

## Data and audit

- Analytics: `forcefield.onboarding_started`, `forcefield.onboarding_ownership_verified`,
  `forcefield.onboarding_ownership_failed`, `forcefield.onboarding_concierge_requested`,
  `forcefield.alert_email_set` / `_confirmed` / `_removed` / `_unsubscribed`,
  `forcefield.tenant_mail_sent` / `forcefield.tenant_mail_blocked`,
  `forcefield.tenant_first_evidence_sent`, `forcefield.tenant_digest_sent`, and
  `forcefield.web_alert_dispatched` (metadata `audience: tenant`) per tenant alert.
- Audit (hash-chained): onboarding started, ownership verified (never the
  token), concierge requested, alert email set / confirmed / removed /
  unsubscribed.
- Tenant alert rows share `instinct_forcefield_web_alerts` under `tenant_<kind>`
  with status `tenant_delivered`, so they never count as an operator delivery in
  the daily silence check.
- Schema: migration 298 (additive columns on `forcefield_signup_requests` and
  `forcefield_tenants`).
