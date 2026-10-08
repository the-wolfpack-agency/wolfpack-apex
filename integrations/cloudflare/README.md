# Forcefield on Cloudflare (no code in your app)

Put Forcefield in front of any site by running it as a Cloudflare Worker. No change
to your application, works on any stack. It runs the same engine the Next.js
middleware runs; the only per-runtime code is the thin adapter this config points at.

Monitor-first and fail-open by design: it watches before it blocks, and any error
(or a ruleset that will not load) serves the request. Forcefield can never take your
site down.

## Deploy

1. Route your domain through Cloudflare.
2. In this folder, set your values in `wrangler.toml` (`FORCEFIELD_SITE`,
   `FORCEFIELD_ORIGIN`), and set your site key as a secret:
   ```
   npx wrangler secret put SITE_ANALYTICS_INGEST_TOKEN
   ```
   (Your site label + key come from `/admin/forcefield` onboarding.)
3. Deploy:
   ```
   npx wrangler deploy
   ```
4. Watch for a clean window, then flip to blocking by setting `FORCEFIELD_ENFORCE`
   to `on` and redeploying (or set it as a var).

The engine updates centrally via `FORCEFIELD_RULESET_URL`, so new scanner
signatures and trap paths go live without a Worker redeploy.

## What runs here

`main` points at `src/lib/forcefield-web/adapters/cloudflare-worker.ts` - the shared,
unit-tested adapter (`observeRequest` / `decideEnforcement` / `fetchRuleset`). The
detection logic is covered by `cloudflare-worker.test.ts` +
`cloudflare-worker-failopen.test.ts`. A deploy itself requires a Cloudflare account,
so the end-to-end `wrangler deploy` is verified in your Cloudflare environment, not
in this repo's CI.
