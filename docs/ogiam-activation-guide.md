# OGIAM Activation and Client Deployment Guide

Status: authoritative "how to go live" guide. This is the single place that lists
every OWNER/OPERATOR action needed to activate the platform and deploy it to a
real client. It covers the one-time platform setup (env + GitHub App), the
per-client onboarding, and the per-client config (budgets). For the detailed
per-step operational flow with verify-as-you-go gates, this guide references
[ogiam-onboarding-runbook.md](./ogiam-onboarding-runbook.md).

Public product name is Wolfpack Instinct / OGIAM. Deployed at
https://wolfpack-instinct.vercel.app . Admin routes require an account with the
`settings.manage_team` capability.

---

## Part A: One-time platform activation (do once)

### A1. Required environment variables (Vercel)

These are deployment blockers. A missing critical value crash-loops the app.
Full table: `.ai/client-context.md`. The critical set:

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres (source of truth) |
| `INSTINCT_JWT_SECRET` | Auth (>=32 chars) |
| `CRON_SECRET` | Authorizes the continuous sweeps |
| `GITHUB_TOKEN_WOLFPACK_AGENCY` | Fallback GitHub PAT (our own repos) |
| `QDRANT_URL` / `QDRANT_API_KEY` | Vector store (advisory) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Graph store (advisory) |
| `PENTEST_KILL_SWITCH` | Leave unset; set to `on` to instantly halt all active probing |

GitHub App (Part A2) adds two more:

| Env var | Purpose |
|---|---|
| `GITHUB_APP_ID` | The numeric App ID from the GitHub App registration |
| `GITHUB_APP_PRIVATE_KEY` | The App private key PEM (Vercel-escaped `\n` is handled) |

### A2. Verify the deployment is ready (BEFORE serving any client)

Two equivalent ways:

- CLI / CI: `npm run verify:prod-env` (exits non-zero if a critical check fails).
- UI: open `/admin/deployment`. Every check shows Ready / Not ready, split into
  Critical (Postgres + GitHub reachable, required env present) and Advisory
  (Qdrant/Neo4j). Do not onboard a client until Critical is all green.

### A3. Register the GitHub App (unlocks per-client repo access)

Until this is done, static scanning and remediation PRs fall back to the shared
PAT (`GITHUB_TOKEN_WOLFPACK_AGENCY`), which only reaches OUR repos. The App is
what gives per-client repo access without a blast-radius token.

1. GitHub -> Settings -> Developer settings -> GitHub Apps -> New GitHub App.
2. Name (e.g. "OGIAM Security"), Homepage URL = https://wolfpack-instinct.vercel.app .
3. Setup URL (post-install redirect):
   `https://wolfpack-instinct.vercel.app/api/admin/connectors/github-app/install-callback`
   and check "Redirect on update". This is what records each client's
   installation against their workspace automatically after they install.
4. Webhook: uncheck Active (we poll; no webhook needed).
5. Repository permissions (least privilege for what we use):
   - Metadata: Read-only (mandatory).
   - Contents: Read and write (Read powers static scanning; Write powers the
     remediation-PR branch + file commit).
   - Pull requests: Read and write (open the review-gated remediation PRs).
   Request NOTHING else.
6. "Where can this GitHub App be installed?": Any account (so clients can install
   on their own org).
7. Create the App. Note the App ID. Generate a private key and download the .pem.
8. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (paste the full PEM) in Vercel,
   then redeploy so the env is live.

Per-client install happens in Part B (step B1b).

---

## Part B: Onboard a client (repeat per client)

The detailed, verify-as-you-go version of B2-B6 is in the onboarding runbook;
this is the checklist with the exact surfaces.

### B1. Connect the client's systems

- B1a. SaaS platform (e.g. Salesforce): `/admin/connectors` -> connect via OAuth
  or store the OAuth username-password credentials. Verify with the connector's
  Verify action.
- B1b. GitHub (their repos): have the client install the OGIAM GitHub App on the
  repos in scope. GitHub redirects to the install-callback, which links their
  `installation_id` to the workspace. Confirm on `/admin/connectors/github-app`
  (it shows linked vs PAT-fallback). Least privilege: ask them to grant only the
  repos in scope.

### B2. Register the target

`/admin/onboarding` -> add the target: `platform` id, public `baseUrl`, optional
`static` (owner/repo/ref/paths) for source scanning, optional `login` (links to
the connector). Stored in the target registry.

### B3. Prove ownership (REQUIRED before any scan or pentest)

On the target's row in `/admin/onboarding`, use "Verify ownership". The platform
issues a token; the client proves control by EITHER:
- placing it at `https://<target>/.well-known/ogiam-site-verification.txt`, OR
- adding a DNS TXT record `ogiam-site-verification=<token>`.

Click Check until it reads Verified. The scan and pentest paths are fail-closed:
an unverified onboarded target is refused (curated internal targets are exempt).

### B4. Preflight

The "Test connection" button on the target row (`/admin/onboarding`). It confirms
the target resolves, the URL is public and reachable, the repo is readable (if
static), and connector credentials exist (if login). Do not proceed until Ready.

### B5. Run the baseline (read-only) and deliver the report

`/admin/platform-scans` for the target's platform id:
1. Scan (security + quality). 2. System profile (the map). 3. Recommendations
(automation mapping). 4. Summary (the report view). The report renders findings
by severity + profile + recommendations + a coverage banner. A degraded scan is
flagged "NOT a clean result" so a low finding count is never mistaken for clean.
Deliver the Security Engagement Report; every finding traces to a stored id and
the audit trail covers the engagement.

### B6. Set the client's AI budget (cost safety)

No admin UI yet; set it via SQL against the workspace (replace values):

```sql
INSERT INTO workspace_ai_policy (workspace_id, monthly_budget_usd)
VALUES ('<client_workspace_id>', 500)
ON CONFLICT (workspace_id)
DO UPDATE SET monthly_budget_usd = EXCLUDED.monthly_budget_usd, updated_at = now();
```

Over-budget AI calls are then refused at the router (the dashboard shows
`over_budget` via `/api/usage`). Optionally also set `max_tier` to cap model tier.

---

## Part C: Authorized active pen testing (only after a signed RoE)

`/admin/pentest`. Do NOT run active probes without a signed rules-of-engagement.

1. Issue a scope token: allowed host(s), allowed techniques, request budget, TTL.
   This is the technical form of the signed authorization; the harness is
   fail-closed (no scope = no probing) and also requires the target be verified
   (Part B3).
2. Run individual probes or the full engagement. Confirmed findings appear in the
   console. 3. Kill switch: the console button, or `PENTEST_KILL_SWITCH=on`,
   halts all active probing instantly.

---

## Part D: Remediation, continuous, offboarding

- Remediation: from a recommendation, open a review-gated PR (never auto-merged).
  Requires the GitHub App (or PAT) to have Contents + Pull requests write on the
  repo. A merged fix auto-resolves on the next scan.
- Continuous: the cron sweeps re-run the baseline (and, where a valid scope
  exists, active testing) on a schedule, authorized by `CRON_SECRET`. A failing
  sweep now alerts the operator (it is no longer silent) and records a run in the
  sweep-runs ledger.
- Offboarding: `/admin/offboarding` purges ALL of a client's data across Postgres
  + Qdrant + Neo4j. Destructive: requires `settings.manage_team` AND typing the
  workspace id to confirm. Every purge is audited and logged with counts.

---

## Go-live checklist

```
PLATFORM (once):
[ ] Critical env vars set in Vercel                         (A1)
[ ] npm run verify:prod-env green / /admin/deployment Ready (A2)
[ ] GitHub App registered + GITHUB_APP_ID/PRIVATE_KEY set   (A3)

PER CLIENT:
[ ] SaaS connector connected + verified                     (B1a)
[ ] Client installed the GitHub App on in-scope repos       (B1b)
[ ] Target registered                                       (B2)
[ ] Ownership Verified (well-known or DNS TXT)              (B3)
[ ] Preflight Ready                                         (B4)
[ ] Baseline run + report delivered                         (B5)
[ ] monthly_budget_usd set                                  (B6)
--- only after signed rules of engagement ---
[ ] Scope token issued + active engagement run              (C)
[ ] Remediation PRs opened (review-gated)                   (D)
[ ] Continuous sweeps confirmed + alerting verified         (D)
```

---

## Related

- [ogiam-onboarding-runbook.md](./ogiam-onboarding-runbook.md): the detailed
  verify-as-you-go operational flow (the source of truth for B2-B6 + C).
- [ogiam-client-deployment-plan.md](./ogiam-client-deployment-plan.md): the
  risk-sequenced go-to-market (read-only first, earn active testing).
- `.ai/client-context.md`: full env var list and deployment blockers.
- [docs/tenant-isolation.md](./tenant-isolation.md): the isolation posture.
