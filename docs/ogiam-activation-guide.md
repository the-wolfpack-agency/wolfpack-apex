# OGIAM Complete Installation and Operations Manual

Status: the authoritative, click-level "how to go live" manual. It lists every
owner/operator action across every tool (Vercel, GitHub, Neon, Qdrant, Neo4j,
Salesforce, your DNS provider, and the OGIAM admin UI) to activate the platform
and deploy it to a real client. External-tool labels can drift over time; the
navigation paths below are the stable anchors. For the detailed verify-as-you-go
operational flow see [ogiam-onboarding-runbook.md](./ogiam-onboarding-runbook.md).

Product: Wolfpack Instinct / OGIAM. Production URL: https://wolfpack-instinct.vercel.app
Admin routes require an account with the `settings.manage_team` capability.

Conventions in this doc: "OGIAM admin" = pages under the production URL (e.g.
`/admin/deployment`). "Vercel", "GitHub", "Neon", etc. = those external consoles.

---

## Quick links (click these)

OGIAM admin (exact pages):
- Deployment readiness: https://wolfpack-instinct.vercel.app/admin/deployment
- Connectors: https://wolfpack-instinct.vercel.app/admin/connectors
- GitHub App status: https://wolfpack-instinct.vercel.app/admin/connectors/github-app
- Onboarding (targets, verify, preflight): https://wolfpack-instinct.vercel.app/admin/onboarding
- Platform Scans (baseline + report): https://wolfpack-instinct.vercel.app/admin/platform-scans
- Pentest console: https://wolfpack-instinct.vercel.app/admin/pentest
- Offboarding: https://wolfpack-instinct.vercel.app/admin/offboarding
- Team (find workspace_id): https://wolfpack-instinct.vercel.app/admin/team

External consoles:
- Vercel project env vars: https://vercel.com/dashboard -> wolfpack-instinct -> Settings -> Environment Variables
- Neon (use the `wolfpack-apex-db` project): https://console.neon.tech ; its SQL Editor is the "SQL Editor" tab inside that project
- GitHub App, create for the org (direct): https://github.com/organizations/the-wolfpack-agency/settings/apps/new
- GitHub Apps list (manage/keys/install): https://github.com/settings/apps
- Qdrant Cloud: https://cloud.qdrant.io
- Neo4j Aura: https://console.neo4j.io

The right Neon project is `wolfpack-apex-db` (it matches the repo, holds the
production data, and is the one the live app uses). Confirm by checking the
`DATABASE_URL` host in Vercel matches this project's endpoint.

---

## Phase 0: Access checklist (gather before you start)

You (or whoever runs this) need:
- [ ] Vercel access to the `wolfpack-instinct` project (env vars + redeploy).
- [ ] GitHub org Owner access (to create + install the GitHub App).
- [ ] Neon access (the Postgres `DATABASE_URL` and the SQL Editor).
- [ ] Qdrant Cloud and Neo4j Aura console access (or the existing connection values).
- [ ] An OGIAM admin login with `settings.manage_team`.
- [ ] A terminal with the repo checked out (to run `npm run verify:prod-env`).
Per client (Phase 3) you also need their cooperation: install the GitHub App,
place a verification token, and provide SaaS (e.g. Salesforce) API credentials.

---

## Phase 1: Platform infrastructure (one time)

> START HERE FIRST. Is the production app ALREADY RUNNING (you can load
> https://wolfpack-instinct.vercel.app and log in)? If yes, then every env var in
> this phase is ALREADY set in Vercel and working. DO NOT re-collect or
> regenerate anything. Skip straight to 1.5 (open /admin/deployment, confirm the
> Critical checks are green) and then go to Phase 2 (GitHub App), which is the
> first genuinely new step. Only do 1.1 to 1.4 when standing up a brand-new,
> separate deployment.
>
> Note on secrets you cannot re-view: Neon shows DATABASE_URL any time, but
> Qdrant and Neo4j show their API key / password only ONCE at creation. If you
> did not save them, you cannot view them again, BUT you also do not need to:
> they are already in Vercel for a running deployment. Creating a NEW Qdrant key
> does not revoke existing keys (safe), but only do that for a fresh deployment.

### 1.1 Collect the backing-service connection values (NEW deployment only)

- DATABASE_URL (Neon): https://console.neon.tech -> your project -> Dashboard ->
  "Connection string" -> copy the POOLED connection string.
- QDRANT_URL + QDRANT_API_KEY (Qdrant Cloud): https://cloud.qdrant.io -> your
  cluster -> the cluster URL is QDRANT_URL; Data Access / API Keys -> create or
  copy a key for QDRANT_API_KEY.
- NEO4J_URI + NEO4J_USER + NEO4J_PASSWORD (Neo4j Aura):
  https://console.neo4j.io -> your instance -> Connect; the `neo4j+s://...` URI is
  NEO4J_URI, user is usually `neo4j`, password was shown at instance creation
  (reset it there if lost).

### 1.2 Generate the two secrets

In a terminal:
```
openssl rand -base64 48     # use the output as INSTINCT_JWT_SECRET (>=32 chars)
openssl rand -base64 48     # use the output as CRON_SECRET
```

### 1.3 Set the env vars in Vercel

Vercel -> the `wolfpack-instinct` project -> Settings -> Environment Variables.
For each row below: enter the Name, paste the Value, set Environment = Production
(add Preview too if you test there), click Save.

Critical (app crash-loops without these):
- `DATABASE_URL`, `INSTINCT_JWT_SECRET`, `CRON_SECRET`, `GITHUB_TOKEN_WOLFPACK_AGENCY`
Backing stores (advisory; triple-write degrades gracefully if absent):
- `QDRANT_URL`, `QDRANT_API_KEY`, `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
Leave unset in normal operation:
- `PENTEST_KILL_SWITCH` (set its value to `on` only to instantly stop all active probing)

(`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are added in Phase 2.)

### 1.4 Redeploy so the env takes effect

Vercel -> Deployments -> the latest deployment -> "..." menu -> Redeploy (or push
any commit to `main`). Migrations run automatically during the build.

### 1.5 Verify the platform is ready (do NOT skip)

Either:
- Terminal: `npm run verify:prod-env` (exits non-zero if any Critical check fails), OR
- OGIAM admin: open `/admin/deployment`. Each check shows Ready/Not ready, grouped
  into Critical (Postgres + GitHub reachable, required env present) and Advisory
  (Qdrant/Neo4j). Do not onboard a client until every Critical check is green.
  See the Troubleshooting appendix for any red check.

---

## Phase 2: Register the GitHub App (one time, unlocks per-client repo access)

Until this is done, static (source) scanning and remediation PRs use the shared
PAT `GITHUB_TOKEN_WOLFPACK_AGENCY`, which only reaches your own repos. The App is
what lets you scan + open PRs on a client's repos without a broad token.

### 2.1 Create the App
GitHub -> your profile/org -> Settings -> Developer settings (bottom left) ->
GitHub Apps -> New GitHub App.
- GitHub App name: e.g. "OGIAM Security".
- Homepage URL: `https://wolfpack-instinct.vercel.app`
- Setup URL: `https://wolfpack-instinct.vercel.app/api/admin/connectors/github-app/install-callback`
  and tick "Redirect on update". (This is what records each client's installation
  against their workspace automatically right after they install.)
- Webhook: UNTICK "Active" (we poll; no webhook needed).

### 2.2 Permissions (least privilege; request nothing else)
Under "Repository permissions":
- Metadata: Read-only (mandatory, auto-selected).
- Contents: Read and write (Read = static scan; Write = remediation-PR commits).
- Pull requests: Read and write (open the review-gated PRs).

### 2.3 Installability + create
- "Where can this GitHub App be installed?": Any account.
- Click "Create GitHub App".

### 2.4 Get the credentials
- On the App's General page, note the "App ID" (a number).
- Scroll to "Private keys" -> Generate a private key -> a `.pem` file downloads.

### 2.5 Put them in Vercel
Vercel -> project -> Settings -> Environment Variables:
- `GITHUB_APP_ID` = the App ID number.
- `GITHUB_APP_PRIVATE_KEY` = the FULL contents of the .pem (including the
  `-----BEGIN RSA PRIVATE KEY-----` / `-----END...-----` lines). Paste it as-is;
  the app handles Vercel's newline escaping.
Redeploy (Phase 1.4) so the App config is live.

Clients install the App during Phase 3.3.

---

## Phase 3: Onboard a client (repeat per client)

### 3.1 Create the client's workspace
Each client is a workspace. If this is the primary/only tenant, the workspace id
is `default`. For a separate client tenant, create the workspace via the OGIAM
setup flow (the new-workspace path that the setup wizard drives off
`/api/workspace`), then find the workspace id under OGIAM admin -> Team
(`/admin/team`). You will need this `workspace_id` for the budget step (3.8).

### 3.2 Connect the client's SaaS system (example: Salesforce)
First, in Salesforce, create a Connected App to get OAuth credentials:
- Salesforce -> Setup (gear icon) -> in Quick Find type "App Manager" -> App
  Manager -> New Connected App.
- Enable OAuth Settings; set a callback URL (any https you control is fine for the
  password grant); select scopes (at least "Manage user data via APIs (api)").
- Save; open the new app -> copy the Consumer Key (= clientId) and Consumer Secret
  (= clientSecret). Use an integration user's username + password (+ security token
  appended to the password if required by your org).
Then, in OGIAM admin -> Connectors (`/admin/connectors`), add the connection:
- connectorName: a stable id you will reuse as the target's login connector.
- authType: oauth_password.
- baseUrl: the login URL, e.g. `https://login.salesforce.com` (or
  `https://test.salesforce.com` for a sandbox).
- loginPath: `/services/oauth2/token`.
- clientId, clientSecret, username, password: from above.
- Save, then use the connector's Verify action to confirm it authenticates.
(For form-login platforms use authType `username_password` with username,
password, loginPath, sessionCookieName instead.)

### 3.3 Have the client install the GitHub App on their repos
Send the client your App's public install page (GitHub -> your App -> Public page,
or share the install URL). They click Install, choose "Only select repositories",
pick the in-scope repos, and confirm. GitHub redirects to the install-callback,
which links their installation to the workspace. Confirm in OGIAM admin ->
Connectors -> GitHub App (`/admin/connectors/github-app`): it shows "linked" vs
"PAT fallback". Least privilege: ask them to grant ONLY the repos in scope.

### 3.4 Register the target
OGIAM admin -> Onboarding (`/admin/onboarding`) -> add a target:
- platform: the id you will reference everywhere after this (e.g. `acme-crm`).
- baseUrl: the public URL of the running system.
- (optional) repo owner / repo name / ref (default `main`): to enable source
  scanning via the GitHub App.
- (optional) login connector: the connectorName from 3.2 so scans run authenticated.
Save; the target appears in the Targets table.

### 3.5 Prove the client owns the target (REQUIRED before any scan/pentest)
On the target's row, click "Verify ownership". OGIAM issues a token and shows two
ways to prove control; the client does EITHER one:
- HTTP file: host the token at
  `https://<target-domain>/.well-known/ogiam-site-verification.txt` (a plain text
  file whose only content is the token). How depends on the client's stack (drop a
  static file at that path / add a route returning it).
- DNS TXT: in the domain's DNS provider (e.g. Cloudflare -> the domain -> DNS ->
  Records -> Add record; or GoDaddy/Namecheap -> Manage DNS -> Add), add a TXT
  record. Host/Name: `@` (or the subdomain); Value: `ogiam-site-verification=<token>`.
  Allow a few minutes for propagation.
Back in OGIAM, click "Check" until it reads Verified. Scans and pentests are
fail-closed: an unverified onboarded target is refused.

### 3.6 Preflight (test connection)
On the target's row, click "Test connection". It checks the target resolves, the
URL is public + reachable, the repo is readable (if static), and connector creds
exist (if login). Fix anything that is Not ready (see Troubleshooting) before
proceeding.

### 3.7 Run the baseline and deliver the report (read-only)
OGIAM admin -> Platform Scans (`/admin/platform-scans`) for the target's platform:
1. Run Scan (security + quality). 2. View System Profile (the map). 3. View
Recommendations (automation mapping). 4. View Summary (the report). The report
shows findings by severity + the profile + recommendations + a Coverage banner; a
degraded scan is flagged "NOT a clean result" so a low finding count is never
mistaken for clean. Deliver this as the Security Engagement Report.

### 3.8 Set the client's monthly AI budget (cost safety)
There is no admin UI for this yet; set it with SQL. Neon -> your project -> SQL
Editor -> run (replace the id and amount):
```sql
INSERT INTO workspace_ai_policy (workspace_id, monthly_budget_usd)
VALUES ('<client_workspace_id>', 500)
ON CONFLICT (workspace_id)
DO UPDATE SET monthly_budget_usd = EXCLUDED.monthly_budget_usd, updated_at = now();
```
Over-budget AI calls are then refused at the router; `/api/usage` exposes an
`over_budget` flag the dashboard surfaces. (Optional: also set `max_tier` to
`'cheap' | 'standard' | 'premium'` to cap model tier.)

---

## Phase 4: Authorized active pen testing (ONLY after a signed rules-of-engagement)

OGIAM admin -> Pentest (`/admin/pentest`). Never run active probes without a
signed RoE from the client.
1. Issue a scope token: allowed host(s), allowed techniques, request budget, TTL.
   This is the technical form of the signed authorization; the harness is
   fail-closed (no scope = no probing) and the target must already be Verified (3.5).
2. Run individual probes or the full engagement; confirmed findings show in the console.
3. Kill switch: the console button, or set Vercel env `PENTEST_KILL_SWITCH=on`,
   stops all active probing instantly.

---

## Phase 5: Ongoing operations

- Remediation: in Platform Scans / Recommendations, open a review-gated PR from a
  recommendation (never auto-merged). Needs the GitHub App (or PAT) to have
  Contents + Pull requests write on the repo. A merged fix auto-resolves next scan.
- Continuous: the cron sweeps re-run the baseline (and active testing where a valid
  scope exists) on a schedule, authorized by `CRON_SECRET`. A failing sweep now
  alerts the operator and records a run in the sweep-runs ledger (no longer silent).
- Offboarding: OGIAM admin -> Offboarding (`/admin/offboarding`) purges ALL of a
  client's data across Postgres + Qdrant + Neo4j. Destructive: requires
  `settings.manage_team` AND typing the workspace id to confirm; every purge is
  audited and logged with counts.

---

## Go-live checklist

```
PLATFORM (once):
[ ] 1.1 backing-service values collected (Neon/Qdrant/Neo4j)
[ ] 1.2 INSTINCT_JWT_SECRET + CRON_SECRET generated
[ ] 1.3 all env vars set in Vercel
[ ] 1.4 redeployed
[ ] 1.5 verify:prod-env / /admin/deployment all Critical green
[ ] 2.x GitHub App created + GITHUB_APP_ID/PRIVATE_KEY set + redeployed

PER CLIENT:
[ ] 3.1 workspace created + workspace_id noted
[ ] 3.2 SaaS connector connected + Verify passes
[ ] 3.3 client installed the GitHub App on in-scope repos (shows "linked")
[ ] 3.4 target registered
[ ] 3.5 ownership Verified (well-known file or DNS TXT)
[ ] 3.6 preflight Ready
[ ] 3.7 baseline run + report delivered
[ ] 3.8 monthly_budget_usd set
--- only after signed rules of engagement ---
[ ] 4. scope token issued + engagement run
[ ] 5. remediation PRs opened, sweeps + alerting confirmed
```

---

## Troubleshooting (common red checks)

- /admin/deployment Postgres red: DATABASE_URL wrong/paused -> re-copy the pooled
  Neon string; un-pause the Neon branch.
- GitHub red / GitHub App "PAT fallback" unexpectedly: GITHUB_APP_ID or
  GITHUB_APP_PRIVATE_KEY missing/malformed (re-paste the full PEM) OR the client
  has not installed the App on the workspace yet.
- Preflight "base_url_public" fails: the URL resolves to a private/internal
  address (blocked by design) -> use the public URL.
- Preflight "base_url_reachable" fails: the target is down or blocking us -> confirm
  it is live and not firewalling the scanner.
- Preflight "repo_accessible" fails: the App lacks access to that repo, or the
  owner/repo/ref is wrong -> fix the install scope or the target's repo fields.
- Verify ownership stuck on Not verified: token not yet placed, wrong path/record,
  or DNS not propagated -> re-check the exact file path / TXT value and wait.
- Scan refused "unverified_target": complete Phase 3.5 first.
- AI calls refused: the workspace is over `monthly_budget_usd` -> raise it (3.8).

---

## Related

- [ogiam-onboarding-runbook.md](./ogiam-onboarding-runbook.md): the detailed
  verify-as-you-go operational flow.
- [ogiam-client-deployment-plan.md](./ogiam-client-deployment-plan.md): the
  risk-sequenced go-to-market (read-only first; earn active testing).
- `.ai/client-context.md`: the full env var reference.
- [docs/tenant-isolation.md](./tenant-isolation.md): the data-isolation posture.
