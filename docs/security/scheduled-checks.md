# Scheduled security checks

Four checks that used to be done by hand now run on a schedule and on demand. Each one is a script you can run on your own machine, writes a JSON file and a readable markdown file, and exits non-zero when it finds something. All four only read: nothing here opens issues, changes settings, or writes to any site.

| Check | Command | Schedule | Workflow | Needs |
| --- | --- | --- | --- | --- |
| Supply chain | `npm run security:supply-chain` | daily | `security-supply-chain.yml` | `SECURITY_AUDIT_GH_TOKEN` |
| Entra app audit | `npm run security:entra-audit` | monthly (1st) | `security-entra-audit.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` |
| AI spend tripwire | `npm run security:ai-spend` | daily | `security-ai-spend.yml` | same Azure identity, plus Cost Management Reader |
| Deployed surface | `npm run security:surface` | weekly, every release, after deploys | `security-surface.yml` | nothing |

A workflow whose credentials are not configured yet does not fail. It writes **SKIPPED** at the top of the run summary with the name of the secret to add, and exits green. Skipped is not the same as passed; the summary says which.

## What each check looks at

**Supply chain** (every repository in the the-wolfpack-agency organization, private ones included):

1. Open Dependabot alerts. Malware advisories, critical and high are listed; the rest are counted. A repository with Dependabot alerts switched off is itself a finding.
2. Every lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `uv.lock`) on the default branch, every exact package version checked against [OSV](https://osv.dev). OSV includes `MAL-` records for packages that exist only to attack, which are not CVEs and which a normal vulnerability scan can miss.
3. The curated list in `security/known-compromised.json`: releases we have read about from a primary source, plus the container images OSV does not cover (Dockerfiles and compose files are read too).
4. GhostAction: any change to `.github/workflows/` in the last 14 days, on any branch, that is not part of a merged pull request. A direct push to the default branch is high; a branch with no pull request is medium; a branch with an open pull request is listed as low.

**Entra app audit** (every app registration holding a secret or certificate): a live credential on an app with no sign-in for 90 days; tenant-wide Microsoft Graph application permissions on `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Files.Read.All`, `Files.ReadWrite.All`, `Sites.Read.All`, `Sites.ReadWrite.All`, `User.Read.All`, `Directory.ReadWrite.All`; credentials valid longer than 12 months; credentials expiring within 30 days.

Two limits are printed in every report:

- The sign-in rule needs the sign-in activity report, which needs an Entra ID P1 or P2 license. On 2026-10-24 our tenant had neither, and the report's newest entry for any app was 2026-03-03. The check detects a stale report and says the rule was not evaluated rather than calling every app unused.
- Mail scoping in Exchange cannot be read through Graph. See the Exchange step in [monthly-review.md](monthly-review.md).

**AI spend**: daily cost per Azure AI resource (Cognitive Services, Azure OpenAI, AI Foundry, Machine Learning, Copilot Studio) for the last nine days. Flags a resource whose latest day is more than 3 times its 7-day average and more than $5, and any AI resource that has just appeared. Cost data lags by up to a day, so this catches a stolen key the morning after, not the minute after.

**Deployed surface**: for each site in `scripts/security/surface-sites.json`, the security headers (CSP, HSTS, `X-Content-Type-Options`, frame protection, `Referrer-Policy`), no version banner in `X-Powered-By` or `Server`, `/.env` and `/.git/config` not served, `/_next/image` refusing to fetch an outside URL, and a protected path that stays refused when the request carries `x-middleware-subrequest` (the Next.js middleware bypass, CVE-2025-29927).

## Running locally

```bash
gh auth login                      # for supply-chain
az login                           # for entra-audit and ai-spend
npm run security:supply-chain
npm run security:supply-chain -- --repo wolfpack-apex        # one repository
npm run security:entra-audit
npm run security:ai-spend
npm run security:surface
npm run security:surface -- --site instinct,fdos
npm run security:surface -- --url https://preview.example.com --protected-path /admin
```

Every command takes `--out <dir>` (default `scripts/security/out/`, which git ignores) and `--fail-on <critical|high|medium|low>` (default `medium`). Exit code 0 means clean or skipped, 1 means findings at or above `--fail-on`, 2 means the check could not run.

## One-time setup for CI

### 1. GitHub token for the supply-chain sweep

`github.token` can only see this repository, so the org-wide sweep needs its own read-only token.

1. Open https://github.com/settings/personal-access-tokens/new
2. Token name `security-audit-readonly`. Resource owner: **the-wolfpack-agency**. Expiration: 1 year (put the renewal date in the calendar).
3. Repository access: **All repositories**.
4. Repository permissions, all **Read-only**: Contents, Metadata, Pull requests, Dependabot alerts.
5. Generate. If the organization requires approval for fine-grained tokens, approve it at https://github.com/organizations/the-wolfpack-agency/settings/personal-access-token-requests
6. Store it (paste when prompted):

   ```bash
   gh secret set SECURITY_AUDIT_GH_TOKEN -R the-wolfpack-agency/wolfpack-apex
   ```

7. Run it once: https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-supply-chain.yml, **Run workflow**.

A GitHub App with the same read permissions is the longer-lived alternative (no yearly renewal); swap the secret for an app token step when that exists.

### 2. Azure identity for the Entra audit and AI spend (OIDC, no stored secret)

GitHub proves to Azure which workflow is asking (OpenID Connect), so no password or secret is stored anywhere. The identity is read-only.

Docs: https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust and https://github.com/Azure/login#login-with-openid-connect-oidc-recommended

Run as a Global Administrator (or Privileged Role Administrator for step 4) with `az login`:

```bash
# 1. The app and its service principal
APP_ID=$(az ad app create --display-name "wolfpack-security-readonly" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# 2. Trust GitHub Actions runs on main of this repository (schedules and manual runs use main)
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-wolfpack-apex-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:the-wolfpack-agency/wolfpack-apex:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# 3. Read-only Graph application permissions:
#    Application.Read.All (9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30)
#    AuditLog.Read.All    (b0afded3-3588-46d8-8b3d-9842eff778da)
az ad app permission add --id "$APP_ID" --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30=Role b0afded3-3588-46d8-8b3d-9842eff778da=Role

# 4. Admin consent for those two permissions
az ad app permission admin-consent --id "$APP_ID"

# 5. Cost data, read-only, on the subscription
az role assignment create --assignee "$APP_ID" --role "Cost Management Reader" \
  --scope "/subscriptions/<subscription-id>"

# 6. Tell the workflows who to sign in as
gh secret set AZURE_CLIENT_ID       -R the-wolfpack-agency/wolfpack-apex --body "$APP_ID"
gh secret set AZURE_TENANT_ID       -R the-wolfpack-agency/wolfpack-apex --body "<tenant-id>"
gh secret set AZURE_SUBSCRIPTION_ID -R the-wolfpack-agency/wolfpack-apex --body "<subscription-id>"
```

Then run each once:

- https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-entra-audit.yml
- https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-ai-spend.yml

This new app will itself appear in the Entra audit. It has no secret or certificate (federated credentials only), so the credential rules do not apply to it, and its two permissions are read-only and not on the sensitive list.

## Calling the surface check from another repository after a deploy

`security-surface.yml` is a reusable workflow, and this repository is public, so any repository can call it. Add a job after the deploy job:

```yaml
jobs:
  deploy:
    # ... your existing deploy job
  surface:
    needs: deploy
    uses: the-wolfpack-agency/wolfpack-apex/.github/workflows/security-surface.yml@main
    with:
      url: https://www.weekendwithporsche.com   # the URL you just deployed
      protected_path: /admin                    # a path that refuses anonymous requests
      fail_on: high                             # optional, default medium
```

Leave `url` blank to probe every site in `surface-sites.json`. The called workflow always checks out this repository's `main`, so every caller runs the same, current probes. To add a site permanently, add it to `scripts/security/surface-sites.json` (confirm the URL resolves first) and the weekly run picks it up.

## Where the results go

This repository is public, and anyone can read the logs and run summary of a public repository's Actions runs (artifacts are downloadable by any signed-in GitHub user). A findings table there would publish our unpatched packages, private repository names and over-privileged apps to exactly the people looking for them. So inside Actions the checks fail closed: they print and summarize only the count of findings by severity, write no report files, and the upload step runs only when `github.event.repository.private` is true. The exit code is unchanged, so a red run still means something to fix. For the full report, run the same `npm run security:<check>` locally; it writes JSON and markdown to `scripts/security/out/` (git-ignored). The monthly review saves the local Entra audit report with its notes. The guardrail in `src/__tests__/security-checks/report.test.ts` fails if a security workflow uploads reports without the private-repository gate.
