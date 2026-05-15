# Salesforce OAuth — Developer Edition Verification

This doc is the manual half of validating the Salesforce connector
against a real Salesforce org. The engineering half (OAuth handshake,
refresh-on-401, encrypted token storage, route plumbing) shipped in
migration 138 + `src/lib/assistant/connectors/oauth/`.

When you finish the steps below, you'll have a Wolfpack Instinct
session connected to a real Salesforce Developer Edition org with
sample data, and you can ask the assistant questions like:

- "look up contact id 003xxxxx" → returns a real Contact record
- "show me account ACME-001" → returns a real Account
- The connector silently refreshes its access token when it expires
  (verifiable in the analytics stream via `assistant.oauth_token_refreshed`)

## 1. Create the Salesforce Developer Edition org

Free, includes sample Contact / Account / Opportunity data, lasts as
long as you log in at least every 6 months.

1. Sign up at https://developer.salesforce.com/signup
2. Pick a username — by convention, use `wolfpack-instinct-demo@<your-email-domain>`
3. Verify the email Salesforce sends
4. Note your **My Domain** URL (Setup → My Domain) — looks like
   `https://wolfpack-instinct-demo-dev-ed.my.salesforce.com`

## 2. Create a Connected App (this is the OAuth client)

Setup → Apps → App Manager → **New Connected App** (legacy form,
not "New Connected App (Lightning Experience)").

| Field | Value |
|---|---|
| Connected App Name | `Wolfpack Instinct` |
| API Name | `Wolfpack_Instinct` |
| Contact Email | (yours) |
| Enable OAuth Settings | ✓ |
| Callback URL | `https://wolfpack-instinct.vercel.app/api/admin/connectors/oauth/salesforce/callback` (plus `http://localhost:3000/api/admin/connectors/oauth/salesforce/callback` for local dev — Salesforce accepts multiple callbacks, one per line) |
| Selected OAuth Scopes | `Manage user data via APIs (api)`, `Perform requests at any time (refresh_token, offline_access)` |
| Require Secret for Web Server Flow | ✓ |
| Require Secret for Refresh Token Flow | ✓ |

Save. Wait 2–10 minutes for the Connected App to propagate (Salesforce
quirk — the credentials don't work immediately).

In the app's detail page, click **Manage Consumer Details** to see:

- **Consumer Key** → this is your `client_id`
- **Consumer Secret** → this is your `client_secret`

## 3. Set the env vars (locally + on Vercel)

Locally:

```bash
echo 'SALESFORCE_CLIENT_ID="<consumer-key>"' >> .env.local
echo 'SALESFORCE_CLIENT_SECRET="<consumer-secret>"' >> .env.local
# Optional sandbox override (default is login.salesforce.com).
# For a Developer Edition org, leave unset — DE orgs use login.salesforce.com.
# For a Salesforce SANDBOX, set: SALESFORCE_AUTH_HOST="https://test.salesforce.com"
```

On Vercel (production):

```bash
# In the wolfpack-apex root:
vercel env add SALESFORCE_CLIENT_ID
vercel env add SALESFORCE_CLIENT_SECRET
# Then redeploy so the runtime picks them up.
```

## 4. Connect from the admin UI

1. Sign in to https://wolfpack-instinct.vercel.app as a CTO / CEO user
   (the OAuth start route requires `settings.manage_team`).
2. Visit `/admin/connectors` (or the equivalent UI surface where the
   "Connect Salesforce" button lives).
3. Click **Connect Salesforce**. You'll be redirected to
   `login.salesforce.com`, sign in with your DE credentials, and
   approve the Wolfpack Instinct app.
4. Salesforce redirects back to
   `/api/admin/connectors/oauth/salesforce/callback?code=...&state=...`.
   The callback verifies the state, exchanges the code, encrypts the
   refresh token, persists to `instinct_connector_credentials`, and
   redirects you to `/admin/connectors?oauth_connected=salesforce`.

If anything fails, the redirect carries `?oauth_error=<code>&oauth_message=<detail>`
so the UI can surface what went wrong. Common errors and fixes:

| oauth_error | What to do |
|---|---|
| `oauth_app_not_configured` | `SALESFORCE_CLIENT_ID/SECRET` env vars unset on the server |
| `invalid_grant` | Authorization code was reused or expired — start the flow again |
| `invalid_client` | Wrong Consumer Key/Secret — re-copy them from Salesforce |
| `invalid_state` | State token expired (>10 minutes) or tampered — start again |
| `persist_failed` | DB write failed — check Vercel logs |

## 5. Verify the round-trip in the assistant

After "oauth_connected=salesforce" lands on `/admin/connectors`:

1. Open the assistant chat.
2. Pick a real Contact ID from your Salesforce DE org (Setup → Object
   Manager → Contact → records — IDs look like `003xxxxxxxxxxxx`).
3. Ask: `look up contact id <that-id>`.
4. The assistant dispatches `get_external_record`, which calls
   `buildRestConnectorForWorkspace` → REST connector calls Salesforce
   with the fresh `Bearer <access-token>` against your instance_url.
5. You should see the Contact record rendered as a Markdown summary.

## 6. Force a refresh to validate the refresh-on-401 path

Salesforce access tokens default to 2 hours, so you'd be waiting a
while to organically observe a refresh. To force one:

1. In Salesforce: Setup → Connected Apps → Wolfpack Instinct → **Edit Policies**.
2. Find the row for your current session (Manage Connected Apps).
3. Click **Revoke** to invalidate the access token. The refresh token
   stays valid.
4. Back in the assistant, ask the same `look up contact id ...`
   question.
5. The REST connector hits a 401, the refresh orchestrator calls
   Salesforce with the refresh token, gets a new access token, retries
   the request, and the user sees the answer.
6. In analytics, look for `assistant.oauth_token_refreshed` with
   `{ connector: "salesforce", refresh_token_rotated: false }`.

## What this proves

- OAuth handshake works against real Salesforce (`exchangeCode`)
- Refresh-on-401 works against real Salesforce (`refresh` returns
  a fresh access token without a re-auth)
- The encrypted refresh token round-trips through AES-256-GCM
- The REST connector's `instance_url`-aware base URL composition is
  correct (we hit the right org, not the global API)
- The state-token HMAC prevents callback replay/tampering

## What stays unknown until the first paying client

- Whether the client's Connected App has restrictive IP allowlists
  (the OAuth flow will succeed, the API call may 403 from an IP
  outside their allowlist — no fix on our side, the client must add
  Vercel's egress range)
- Whether the client's user has CRUD permissions on the objects we
  read (sharing rules vary by org)
- Custom-object names (we read standard Contact/Account/Opportunity;
  client may need different object types in vendor-presets.ts)

## Adding HubSpot / QBO / Jira / GitHub

Same plumbing, new provider file:

1. Implement `OAuthProvider` in `src/lib/assistant/connectors/oauth/providers/<vendor>.ts`.
2. Register it in `src/lib/assistant/connectors/oauth/registry.ts`.
3. Add the vendor's preset to `src/lib/assistant/connectors/vendor-presets.ts`
   (baseUrl + objectMap).
4. Document the setup in `demo/<vendor>-oauth-setup.md` mirroring this file.

The routes, refresh orchestrator, encrypted token storage, eval cases,
and refresh-on-401 logic are vendor-agnostic. No further code changes.

HubSpot is already wired up (provider + tests); add a Public OAuth App
at https://developers.hubspot.com/ and follow steps 3–6 above with
`HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` env vars.
