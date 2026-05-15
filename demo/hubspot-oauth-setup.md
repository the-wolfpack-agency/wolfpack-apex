# HubSpot OAuth — Developer Account Verification

This is the HubSpot counterpart to [salesforce-oauth-setup.md](salesforce-oauth-setup.md).
The engineering half (OAuth handshake, refresh-on-401, encrypted token
storage, route plumbing) is provider-agnostic — the same routes,
orchestrator, and admin UI Quick Connect button that worked for
Salesforce work for HubSpot. Only the per-vendor pieces (client_id /
client_secret env vars + the Developer account setup) change.

When you finish, you'll have Instinct connected to a HubSpot Developer
test portal and the assistant answering CRM queries the same way it
does for Salesforce.

## 1. Create a HubSpot Developer account

Free, takes ~5 minutes. Gives you a sandbox portal + the ability to
register OAuth apps.

1. Sign up at https://app.hubspot.com/signup/developers
2. Verify your email
3. Once in, click **Test Accounts** → **Create app test account** to
   spin up a sandbox portal with sample contacts/deals. (Not strictly
   required — you can also test against your real HubSpot if you have
   one — but the sandbox lets you experiment without polluting prod.)

## 2. Create an OAuth app

In the Developer Account, go to **Apps** → **Create app**.

| Field | Value |
|---|---|
| Public app name | `Wolfpack Instinct` |
| Description | (anything) |
| Logo | (optional) |

Then click **Auth** in the left sidebar of the app settings.

| Field | Value |
|---|---|
| Redirect URL | `https://wolfpack-instinct.vercel.app/api/admin/connectors/oauth/hubspot/callback` |
| Required Scopes | `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.companies.read`, `oauth` |
| Optional Scopes | (leave empty for read-only verification; add write scopes when we wire the write actions for HubSpot) |

Save. The app's **Client ID** and **Client Secret** appear at the top
of the Auth page.

## 3. Set env vars on Vercel

Open https://vercel.com/the-wolfpack-agency/wolfpack-instinct/settings/environment-variables
and add:

| Name | Value | Environment |
|---|---|---|
| `HUBSPOT_CLIENT_ID` | (from HubSpot Auth page) | Production |
| `HUBSPOT_CLIENT_SECRET` | (from HubSpot Auth page) | Production |

Then redeploy the latest production deploy (or push any commit to
trigger auto-redeploy).

## 4. Connect from the admin UI

1. Sign in to https://wolfpack-instinct.vercel.app as a CTO / CEO user.
2. Visit `/admin/connectors`.
3. Click the **Connect HubSpot** button at the top.
4. You'll redirect to `app.hubspot.com/oauth/authorize`, sign in with
   your HubSpot developer credentials, choose the test portal, click
   **Choose Account** then **Connect app**.
5. HubSpot redirects back to our callback. You should land at
   `/admin/connectors?oauth_connected=hubspot` with a green success
   toast.

If anything fails, the URL carries `?oauth_error=<code>&oauth_message=...`
— same failure-mode cheat sheet as Salesforce.

## 5. Verify the assistant round-trip

In the assistant chat:

```
look up Grimace Fromcdonalds
```

(or the name of a contact that exists in your HubSpot test portal).

The connector auto-routes to `hubspot` (because the workspace's HubSpot
row is now configured), executes a GET against
`https://api.hubapi.com/crm/v3/objects/contacts?q=Grimace`, and renders
the matching contact.

Then try the other supported queries from
[salesforce-search-validation-2026-05-15.md](salesforce-search-validation-2026-05-15.md)
— most should work identically.

## What stays unknown until you actually test

HubSpot's API has a few divergences from Salesforce that may surface
in the live test:

| Concern | Likely outcome |
|---|---|
| HubSpot `q=` search ranks by recency, not relevance | Top match may not be the closest name — disambiguation may fire more often |
| Properties are lowercase (`firstname` vs `FirstName`) | Renderer falls back through key-case variants; surfaces should still work |
| HubSpot has no `Opportunity` SObject — uses `Deal` directly | Already mapped in the vendor preset's objectMap |
| HubSpot rotates refresh tokens on every refresh | Already handled by the orchestrator's COALESCE on refresh_token_enc |
| HubSpot has no `Account` — uses `Company` | Map alias already in the preset |

If any of these break in practice, the fix is a per-preset tweak
(NOT a connector or tool change). The framework holds.

## What this proves end-to-end

When this works, you've validated that the multi-CRM claim isn't
theoretical:

- The same Quick Connect button works for two providers
- The same OAuth orchestrator persists tokens for both
- The same assistant tools (search / look-up / create / update /
  related / filter) route to the configured connector and serve real
  data
- Refresh-on-401 logic handles HubSpot's refresh-token rotation
  (which Salesforce doesn't do)

Once both Salesforce + HubSpot connect cleanly, every additional
vendor (QuickBooks, Jira, GitHub, Zendesk, …) is a single-file add
in `oauth/providers/` + a vendor-presets.ts entry.

## What we'd still need to ship for HubSpot write actions

The current `create_external_record` + `update_external_record` tools
work on Salesforce. For HubSpot writes, the vendor preset's
`writes.create` block (already shipped in vendor-presets.ts) wraps
fields in HubSpot's `{ properties: {...} }` envelope correctly. So
once HubSpot is connected, `create a contact named Jane Doe email
jane@acme.com` should work the same way it does for Salesforce —
worth verifying live once read works.

Update actions need a per-vendor field-name alias layer (HubSpot uses
`firstname`/`lastname`/`email` lowercase; SF uses `FirstName`/`LastName`/
`Email`). That's a small addition to the update tool's normalizer if
it doesn't already handle both shapes.
