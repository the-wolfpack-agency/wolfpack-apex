# Forcefield connectors: publishing + go-live runbook

The connector code is built, merged, and tested. The remaining steps are external
(they need an account or a live secret) and are listed here so each is turnkey. None
of these can be verified in this repo's CI; each is verified in the target system.

## 1. Hosting-platform one-click integration (the OAuth app)

The callback (`/api/forcefield/integrations/vercel/callback`) is built and dark until
registered.

1. Register the integration in the platform's dashboard (Integrations -> create).
2. Set the **Redirect URL** to:
   `https://wolfpack-instinct.vercel.app/api/forcefield/integrations/vercel/callback`
3. Request the scopes the provisioning needs: read the project, and create project
   environment variables.
4. Copy the integration's client id + secret into the engine's env:
   - `MARKETPLACE_VERCEL_CLIENT_ID`
   - `MARKETPLACE_VERCEL_CLIENT_SECRET`
5. Install it on a test project and authorize. Confirm the project gains the
   `FORCEFIELD_*` env (watch-first: `FORCEFIELD_ENFORCE=off`, token written sensitive).
   This live handshake is the verification step.

## 2. WordPress plugin (WordPress.org listing)

The plugin + its `readme.txt` are submission-ready in `wordpress/ogiam-forcefield/`.

1. Validate the `readme.txt` against the official WordPress readme validator.
2. Submit the plugin for review via the WordPress.org account.
3. On approval, push the `ogiam-forcefield/` folder to the assigned SVN repo and tag
   the stable version (`0.1.0`).
4. Until listed, clients can install it by uploading the zip (Plugins -> Add New ->
   Upload) - no account needed for that path.

## 3. Cloudflare Worker (deploy)

Config + README are in `cloudflare/`.

1. From `cloudflare/`, set `FORCEFIELD_SITE` + `FORCEFIELD_ORIGIN` in `wrangler.toml`.
2. `npx wrangler secret put SITE_ANALYTICS_INGEST_TOKEN` (the site key).
3. `npx wrangler deploy`. Flip `FORCEFIELD_ENFORCE=on` when ready to block.
   The deploy needs a Cloudflare account; that is the verification step.

## 4. Full dogfood (our own live sites)

The engine is already proven live on ogiam.com (benign 200; scanners / payloads /
traversal / SQLi -> 403). To bring our other sites onto the network:

1. For each site, set `FORCEFIELD_WEB=on`, `FORCEFIELD_SITE`, `FORCEFIELD_INGEST_URL`
   (the observe endpoint), and `FORCEFIELD_EDGE_TOKEN` (its site key from
   `/admin/forcefield`). Deploy. Keep `FORCEFIELD_ENFORCE=off` for a watch window.
2. After a clean watch window, set `FORCEFIELD_ENFORCE=on`.
3. Verify with a read-only red-team: a scanner UA / an injection payload / the decoy
   path must return 403; a benign request must return 200.
4. To turn the shared-blocklist network on, set `FORCEFIELD_DISTRIBUTE_BLOCKS=on` on
   the engine. A tenant can opt out (`shares_intel=false`) and still get full local
   protection.
