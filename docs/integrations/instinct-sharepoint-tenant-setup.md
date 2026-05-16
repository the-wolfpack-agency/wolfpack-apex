# Wolfpack tenant: SharePoint connector setup for Instinct

> One-time setup. Hands this doc to whoever has Global Admin or Application Admin on Wolfpack's Microsoft 365 tenant (`netorg9503444`). After the steps below, Wolfpack Instinct can read just two SharePoint sites (PCNAINTERNAL and WolfpackxPCNA) and nothing else. Last revised: 2026-05-16.

## What you are doing and why

You are registering an Azure AD application in Wolfpack's M365 tenant, then granting it read-only access to exactly two SharePoint sites. Instinct uses that application to ingest documents and event materials for the PCNA pilot. The app cannot read any other SharePoint site, any user's OneDrive, any mailbox, or any calendar. The scope is intentionally narrow so the security review is short.

If you ever want to revoke this access, deleting the app registration in Entra ID immediately cuts off all Instinct access to SharePoint. No data is held outside the configured ingest target.

## What I need back from you when the steps are done

Three values, one paragraph, send them to Nick:

```
Tenant ID:          (GUID from step 1)
Application ID:     (GUID from step 1)
Client secret:      (the value you copied in step 3, NOT the secret ID)
```

The client secret is sensitive. Send it through 1Password, Bitwarden, or another secrets manager. Do not paste it in chat or email.

## Setup steps

### Step 1: Register the application

1. Sign in to **https://entra.microsoft.com** as Global Admin or Application Admin
2. Left nav: **Applications > App registrations**
3. Click **New registration** at the top
4. Fill in:
   - **Name:** `Wolfpack Instinct (SharePoint connector)`
   - **Supported account types:** Accounts in this organizational directory only
   - **Redirect URI:** leave blank
5. Click **Register**
6. On the resulting overview page, copy these two values into the email you'll send Nick:
   - **Application (client) ID**
   - **Directory (tenant) ID**

### Step 2: Add API permissions

1. In the same app's left nav, click **API permissions**
2. Click **Add a permission > Microsoft Graph > Application permissions**
3. Search for and check **Sites.Selected**
4. Click **Add permissions**
5. Back on the API permissions page, click **Grant admin consent for [tenant name]** at the top
6. Confirm. The status column for `Sites.Selected` should now show a green check

> Why `Sites.Selected` and not `Sites.Read.All`: `Sites.Selected` is the minimum-privilege variant. Even though admin consent is granted, the app still cannot read any site until step 4 explicitly assigns it to specific sites.

### Step 3: Create a client secret

1. Left nav: **Certificates & secrets**
2. **Client secrets > New client secret**
3. Description: `Instinct ingest, 2026-05`
4. Expires: **24 months** (or your org's policy)
5. Click **Add**
6. **Copy the Value column immediately.** You cannot view it again after leaving this page. Paste it into the secrets-manager note for Nick.

### Step 4: Grant the app access to the two specific sites

This is the step that actually scopes the app to PCNAINTERNAL and WolfpackxPCNA only. It must happen via Microsoft Graph (no UI for this in the Entra portal).

Easiest path: use the Graph Explorer at **https://developer.microsoft.com/graph/graph-explorer**, signed in as you.

For each of the two sites, you'll run two requests. Replace `{APP_CLIENT_ID}` with the Application ID from step 1.

**Site 1: PCNAINTERNAL**

First, look up the site's GUID:
```
GET https://graph.microsoft.com/v1.0/sites/netorg9503444.sharepoint.com:/sites/PCNAINTERNAL
```
Copy the `id` field from the response. It looks like `netorg9503444.sharepoint.com,<guid>,<guid>`.

Then grant the app read access to that site:
```
POST https://graph.microsoft.com/v1.0/sites/{site-id-from-above}/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "{APP_CLIENT_ID}",
        "displayName": "Wolfpack Instinct (SharePoint connector)"
      }
    }
  ]
}
```
You should see a `201 Created` response. The app now has read access to PCNAINTERNAL.

**Site 2: WolfpackxPCNA**

Same two requests, with site name changed:
```
GET https://graph.microsoft.com/v1.0/sites/netorg9503444.sharepoint.com:/sites/WolfpackxPCNA
```
Then:
```
POST https://graph.microsoft.com/v1.0/sites/{site-id-from-above}/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "{APP_CLIENT_ID}",
        "displayName": "Wolfpack Instinct (SharePoint connector)"
      }
    }
  ]
}
```

### Step 5: Confirm and hand off

Once all four requests in step 4 have succeeded, send Nick the three values listed at the top of this doc (Tenant ID, Application ID, Client secret) through a secrets manager.

## Optional: enable Stream transcripts

If Microsoft Stream auto-captions are not already on for the tenant, the training videos in WolfpackxPCNA will be indexed by filename only, not by content. Quick switch:

1. **Microsoft 365 admin center > Stream settings**
2. Find **Live transcription** and **Automatic transcription**, set both to **On**

Already-uploaded videos will start generating transcripts in the background. New uploads transcribe within an hour of upload.

## Rollback

To revoke Instinct's SharePoint access at any time, do one of the following:

- **Soft revoke (preferred):** In each site's permission list, remove the application's grant. Reversible. Run a `DELETE https://graph.microsoft.com/v1.0/sites/{site-id}/permissions/{permission-id}`.
- **Hard revoke:** Delete the app registration in Entra ID. Immediate and total. The app cannot read anything in the tenant. Re-enabling requires repeating steps 1 to 4.

The client secret can also be rotated independently. Generate a new secret in step 3, send it to Nick, then delete the old one. No service interruption if the rotation order is "new secret created, new secret deployed to Instinct, old secret deleted" in that sequence.

## Common pitfalls

- **"Sites.Selected" not appearing in the permission list.** It's under **Application permissions**, not **Delegated permissions**. Switch tabs.
- **403 on the POST in step 4.** The signed-in user needs to be a SharePoint Administrator on the tenant, not just Global Admin. If you hit this, add yourself to the SharePoint Admin role for 24 hours, run the calls, remove yourself.
- **404 on the GET in step 4.** Check the site URL slug. `PCNAINTERNAL` is all caps; `WolfpackxPCNA` is mixed case. SharePoint is case-insensitive on the URL but Graph isn't always.
- **Client secret value already gone.** You missed the one-time-view window in step 3. Generate a fresh secret, no harm done.

## If you outsource M365 administration

If Wolfpack's M365 tenant is managed by an external IT partner (the `netorg9503444` tenant name suggests partner provisioning), forward this entire doc to them. The whole sequence is approximately a 30-minute task for an admin who has done it before. There is no proprietary Wolfpack code involved in this doc; nothing here is sensitive to share.
