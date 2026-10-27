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

## Request-body RCE protection (Worker only)

Because the Worker sits in FRONT of your origin, it is the one place Forcefield can
read the request body before your server does. It inspects a bounded, constant-memory
prefix of qualifying POST bodies (at most 256 KB; a trickled or oversized body is
never buffered past the cap) for two actively-exploited, body-borne RCEs and turns
them away before they reach the origin:

- **PHP2Shell** (CVE-2026-109618 / CVE-2026-109619) - PHP's multipart/urlencoded
  parser corrupting memory during request start-up. Blocked on high-confidence
  structural markers (a `PHP_SESSION_UPLOAD_PROGRESS` field with an abnormal part
  count or field-name nesting, an abnormal part count on its own, machine-generated
  deep nesting, a `<?php`/`|O:` marker in an upload filename, or a single oversized
  urlencoded field name full of control bytes). A reverse proxy is the only external
  defense; patching PHP is still the complete fix.
- **React2Shell** (CVE-2025-55182) - a React Server Components Flight deserialization
  payload. Blocked on the never-legitimate body marker (a Flight reference paired
  with a prototype-pollution token), never on the `Next-Action` header alone, which
  every real Server Action sends.

This runs on the Worker regardless of your origin stack. The in-app Next.js
middleware and the WordPress plugin do NOT do body inspection: the WordPress plugin
hooks `init`, which fires after PHP has already parsed the body, so a PHP origin must
be fronted by this Worker to be protected against PHP2Shell. It cannot catch markers
padded past the 256 KB scan cap or chunked variants the proxy reassembles differently
from the origin.

## What runs here

`main` points at `src/lib/forcefield-web/adapters/cloudflare-worker.ts` - the shared,
unit-tested adapter (`observeRequest` / `decideEnforcement` / `fetchRuleset`). The
detection logic is covered by `cloudflare-worker.test.ts` +
`cloudflare-worker-failopen.test.ts`. A deploy itself requires a Cloudflare account,
so the end-to-end `wrangler deploy` is verified in your Cloudflare environment, not
in this repo's CI.
