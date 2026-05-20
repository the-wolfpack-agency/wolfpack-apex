# Email via Microsoft Graph (free, M365-backed)

System-initiated email (invite, password reset, future notifications) sends through Microsoft Graph's app-only `/users/{from}/sendMail` endpoint. Free as part of M365, no DNS verification, sends from a real wolfpack mailbox.

## One-time setup

### 1. Add `Mail.Send` (Application) to the Azure app registration

The same app registration that already serves OAuth sign-in.

1. Azure Portal → Microsoft Entra ID → App registrations → **the Wolfpack Instinct app** (whatever holds `MS_CLIENT_ID`).
2. **API permissions** → **Add a permission** → Microsoft Graph → **Application permissions** (NOT delegated) → search `Mail.Send` → check it → **Add permissions**.
3. Click **Grant admin consent for ‹tenant›**. Status flips to a green "Granted for ‹tenant›".

Result: the existing client-credentials token now contains `Mail.Send` and can call `/users/{any-mailbox}/sendMail` in your tenant.

### 2. (Recommended) Lock the app to a single mailbox

Without this, the app can send-as ANY user in the tenant. The Microsoft-recommended fix is an Application Access Policy that limits the principal to one mailbox.

```powershell
# Connect-ExchangeOnline first, then:
New-DistributionGroup -Name "InstinctNoReplyScope" -Type Security `
  -PrimarySmtpAddress noreply-scope@thewolfpack.agency -Members noreply@thewolfpack.agency

New-ApplicationAccessPolicy `
  -AppId <MS_CLIENT_ID> `
  -PolicyScopeGroupId noreply-scope@thewolfpack.agency `
  -AccessRight RestrictAccess `
  -Description "Restrict Wolfpack Instinct app to the noreply mailbox"

# Verify:
Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> `
  -Identity noreply@thewolfpack.agency  # → Granted
Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> `
  -Identity homyk@thewolfpack.agency    # → Denied (expected)
```

### 3. Create the sending mailbox

Pick whichever you want recipients to see. Most-common: `noreply@thewolfpack.agency` or `support@thewolfpack.agency`. The mailbox must exist in M365 (Exchange Online).

### 4. Set the env vars in Vercel

```
MS_MAIL_FROM=noreply@thewolfpack.agency       # required
MS_MAIL_FROM_NAME=Wolfpack Instinct           # optional, default "Wolfpack Instinct"
```

`MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` are already set for OAuth — no changes there.

### 5. Verify

Trigger a password reset for any teammate, watch the Vercel function log:

```
[send-password-reset] graph send failed: scope_missing ...    ← consent step missed
[send-password-reset] graph send failed: no_app_token ...     ← tenant id is "common" or creds bad
                                                              (no log line on success — 202 Accepted is silent)
```

On success the email lands in the recipient's inbox and a copy is in `noreply@thewolfpack.agency`'s Sent Items (audit trail).

## Provider priority

`defaultSendInviteEmail` and `defaultSendResetEmail` try providers in order:

1. **MS Graph** — when `MS_MAIL_FROM` is set AND the app-only token + `Mail.Send` permission resolve.
2. **Resend** — when `RESEND_API_KEY` is set. Existing path, still works.
3. **Skip + return `dev_link`** in the API response so the operator can hand-deliver.

The `provider` field on the response (`graph` | `resend`) tells you which one actually delivered.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `reason: "no_mail_from"` | `MS_MAIL_FROM` env unset | Set it in Vercel |
| `reason: "no_app_token"` | `MS_TENANT_ID` is "common", or creds invalid, or app permissions not consented | Verify tenant GUID; re-grant admin consent; check `MS_CLIENT_SECRET` not expired |
| `reason: "scope_missing"` | `Mail.Send` (Application) not granted, OR Application Access Policy excludes `MS_MAIL_FROM` mailbox | Step 1 above; if policy exists, add the mailbox to its scope group |
| `reason: "provider_error"` with 5xx | Transient Graph outage | Retry; check https://status.office.com |

## Why this over Resend / SendGrid / SES

- **Free** with existing M365 seats (no extra invoice).
- **Zero DNS work** — sends from a mailbox you already own, with M365's own SPF/DKIM.
- **Already integrated** — `getAppOnlyToken`, app registration, tenant secrets all shipped.
- **Auditable** — Sent Items folder is a built-in audit trail; ediscovery + retention policies apply.
- **No vendor lock** — Graph is the same API enterprise customers already trust.
