# Secure Agent: GitHub App setup and go-live checklist

This is the one ops step that unblocks the entire Secure Agent product: the
factory's per-tenant PR flow AND the PR-gate that governs any PR (GitHub Copilot
included). All the code is already merged; this registers the App and turns it
on. Do it once. Nothing here is a code change.

## 1. Register the GitHub App

GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.

- **Name:** Secure Agent (or a client-neutral name of your choice).
- **Homepage URL:** https://wolfpack-instinct.vercel.app
- **Setup URL** (where GitHub sends the user after they install):
  `https://wolfpack-instinct.vercel.app/api/admin/connectors/github-app/install-callback`
  Check "Redirect on update" so re-installs re-link cleanly.
- **Webhook URL:** `https://wolfpack-instinct.vercel.app/api/github-app/webhook`
- **Webhook secret:** generate a strong random string. This is the value you set
  as `GITHUB_APP_WEBHOOK_SECRET` in step 3. It lives only on the App and in our
  env, never on a client.

### Permissions (Repository)

- **Contents: Read and write** (commit factory changes / open PRs)
- **Pull requests: Read and write** (open PRs, post the block comment)
- **Checks: Read and write** (post the gate verdict as a Check Run)
- **Metadata: Read-only** (mandatory baseline)

### Subscribe to events

- **Pull request** (drives the gate: opened / synchronize / reopened / ready_for_review)

### Who can install

- "Any account" if clients will install it themselves; "Only this account" while
  piloting on our own org.

After creating: note the **App ID**, generate a **private key** (downloads a
.pem), and note the App's public slug (the `app/<slug>` in its install URL).

## 2. Get the install URL

The App's install page is `https://github.com/apps/<slug>/installations/new`.
That is the value for `NEXT_PUBLIC_GITHUB_APP_INSTALL_URL` in step 3. It is what
the "Install GitHub App" button on `/admin/connectors/github-app` links to.

## 3. Set env in Vercel (project wolfpack-instinct)

| Env var | Value |
|---|---|
| `GITHUB_APP_ID` | the numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | the full PEM contents (multi-line; paste as-is or base64 per your convention) |
| `GITHUB_APP_WEBHOOK_SECRET` | the webhook secret from step 1 |
| `NEXT_PUBLIC_GITHUB_APP_INSTALL_URL` | `https://github.com/apps/<slug>/installations/new` |

Redeploy so the values take effect. Until these are set, the code falls back to
the org PAT for our own repos with zero behavior change (per migration 195), and
the webhook fails closed (401) because there is no secret to verify against.

## 4. Verify (deployed URL, fail-closed)

Runnable now, before any client installs:

```
scripts/verify-secure-agent-webhook.sh https://wolfpack-instinct.vercel.app
```

It asserts the webhook endpoint is deployed and rejects unsigned / wrong-secret
deliveries with 401. A green run proves the endpoint is live and fail-closed.

## 5. Prove the live path (one pilot)

1. Grant the pilot tenant the `secure_agent` entitlement (admin entitlements UI).
2. Install the App on a test repo via the button on `/admin/connectors/github-app`
   (or the install URL). Confirm the install-callback links the installation to
   the workspace (toast: "Installed and linked").
3. Open a PR on that repo that introduces a hardcoded secret. Within seconds the
   "Secure Agent / gate" check appears as action_required and a comment explains
   the block.
4. Open a clean PR. The check appears as success.
5. (Optional) In the repo's branch protection, mark "Secure Agent / gate" as a
   required status check so a blocked PR cannot be merged.

That sequence, verified live, is the definition of done for Secure Agent's
gating half. Step 5 is the only client-side option; steps 1 to 4 need nothing on
the client beyond the install click.
