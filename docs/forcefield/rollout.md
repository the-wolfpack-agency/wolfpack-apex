# Forcefield rollout: protect a site + join the network

Internal runbook. How to put Forcefield on one of our sites (or a client's), so it
protects that site AND joins the shared blocklist network: a proven-hostile agent
caught on any protected site is turned away on all of them. No em dashes.

## The model: one engine, a thin shim per site

The detection engine lives ONCE on the Instinct control plane
(`wolfpack-instinct.vercel.app`). Each protected site runs a thin SHIM in its own
edge (Next.js middleware, a Cloudflare Worker, or the WordPress plugin) that does
two things per request: forward the request SHAPE to the engine, and apply the
verdict. The site carries no detection logic, so every engine improvement is one
deploy, live on every site at once.

### What a connector sends (POST /api/forcefield/observe)

| Field | Meaning |
|---|---|
| `site`, `path`, `rawUrl`, `method` | Which site, and the request target (path plus query, so a payload in the query is seen) |
| `userAgent`, `headerNames`, `country` | The user-agent, the NAMES of the request headers (never values), the edge country |
| `accept`, `secFetchDest` | The two headers that tell a real page view from a script |
| `ip` | The client IP. Classified by the engine (hosting network or not, verified crawler range or not) and then discarded, never stored |
| `asn`, `asOrg` | The client network number and operator name, only when the edge knows them (Cloudflare does) |
| `platform` | What the site runs on, e.g. `"wordpress"`. The engine then treats that platform's own paths (`/wp-login.php`, `/wp-admin`, `/xmlrpc.php`, `/wp-json`, ...) as the site's, not as recon |
| `authenticated` | `true` ONLY when the site itself verified a real signed-in session. Never set from a cookie or Authorization header merely being present, since anyone can send those |

The engine suppresses weak bot tells for an authenticated request but still
records payloads, decoy trips, named scanners and probes.

### The signed-in user guarantee

No connector ever blocks a request the site attested as signed in, in any mode.
The request is still reported (marked authenticated) so the engine sees what a
compromised or misused account does, but it is always served. Sign-in is attested
by the site's own session check:

- WordPress plugin: `is_user_logged_in()`, which validates the signed WordPress
  auth cookie.
- Generic shim (`src/lib/forcefield-web/shim.ts`): the `isAuthenticated(req)`
  option you pass to `forcefieldCheck`.
- Cloudflare Worker: the `isAuthenticated(request, env)` option of
  `createForcefieldWorker`.

A hook that throws or returns anything other than `true` means anonymous.

Watch-first by design: the shim is dark until `FORCEFIELD_WEB=on`, and it only ever
returns a block when `FORCEFIELD_ENFORCE=on`. A site watches first (records what it
WOULD block), then graduates to enforce. A benign visitor is never turned away.

Honest note: ogiam.com currently runs an older VENDORED copy (self-contained
middleware), which proved live enforcement but does NOT use this shim and so is not
a network node yet. New sites should use the shim below; moving ogiam.com onto it is
a follow-up.

## Step 1: onboard the site (get its token)

In `/admin/forcefield` -> Signups/Tenants, provision the site. You get a per-tenant
ingest token (shown ONCE; stored only as a sha256 hash) and a copy-paste quickstart.
The token is the site's credential; it only ever reads/writes that tenant's data.

## Step 2: drop in the shim

### Next.js (`src/middleware.ts`)

```ts
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

const ENGINE = process.env.FORCEFIELD_INGEST_URL;      // e.g. https://wolfpack-instinct.vercel.app/api/forcefield/observe
const TOKEN = process.env.FORCEFIELD_EDGE_TOKEN;        // issued at onboarding
const SITE = process.env.FORCEFIELD_SITE || "site";
const ON = process.env.FORCEFIELD_WEB === "on";
const ENFORCE = process.env.FORCEFIELD_ENFORCE === "on";

export async function middleware(req: NextRequest, ev: NextFetchEvent): Promise<NextResponse> {
  // Fail-open and dark-by-default: any misconfig or error serves the request.
  if (!ON || !ENGINE || !TOKEN) return NextResponse.next();
  const u = new URL(req.url);
  const body = JSON.stringify({
    site: SITE,
    path: u.pathname,
    rawUrl: u.pathname + u.search,
    method: req.method,
    userAgent: req.headers.get("user-agent") ?? "",
    country: req.headers.get("x-vercel-ip-country") ?? "",
    headerNames: Array.from(req.headers.keys()),
  });

  if (!ENFORCE) {
    // Watch mode: forward for recording, never block, never delay the response.
    ev.waitUntil(fetch(ENGINE, { method: "POST", headers: { "content-type": "application/json", "x-edge-token": TOKEN }, body }).then(() => {}).catch(() => {}));
    return NextResponse.next();
  }

  // Enforce mode: ask the engine, apply the verdict. Fail-open on any error.
  try {
    const res = await fetch(ENGINE, { method: "POST", headers: { "content-type": "application/json", "x-edge-token": TOKEN }, body });
    const verdict = (await res.json().catch(() => ({}))) as { action?: string; reasonKind?: string };
    if (verdict.action === "block") {
      return new NextResponse("Forbidden: flagged as a hostile automated action.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "x-forcefield": `blocked:${verdict.reasonKind ?? "policy"}` },
      });
    }
  } catch { /* fail-open: Forcefield must never take the site down */ }
  return NextResponse.next();
}

// Scope to real requests; skip static assets.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

### Generic shim (any JS edge)

`src/lib/forcefield-web/shim.ts` is the same flow as a library. `forcefieldCheck`
extracts the signals, runs your sign-in check, asks the engine, and returns
whether to block. It fails open and never blocks a signed-in request.

```ts
import { forcefieldCheck } from "./shim";

const block = await forcefieldCheck(req, {
  endpoint: process.env.FORCEFIELD_INGEST_URL!,
  token: process.env.FORCEFIELD_EDGE_TOKEN!,
  site: process.env.FORCEFIELD_SITE || "site",
  platform: "wordpress",                         // optional: what the origin runs
  isAuthenticated: (r) => verifySession(r),      // optional: YOUR session check
}, { ip: trustedClientIp });                     // pass the IP from your platform when you have one
```

Pass `ip` from your platform's trusted source. The fallback reads the first
X-Forwarded-For hop, which is only safe on an edge that overwrites that header
itself (Vercel does).

### Cloudflare Worker

The apex adapter at `src/lib/forcefield-web/adapters/cloudflare-worker.ts` is the
reference implementation (observe + apply), vendored per site. It reads the client
IP ONLY from `CF-Connecting-IP` (set by Cloudflare, not forgeable by the client),
and the network number and operator from `request.cf.asn` and
`request.cf.asOrganization`. The default export needs no code. To declare the
origin's platform and attest signed-in users, export a configured Worker instead:

```ts
import { createForcefieldWorker } from "./cloudflare-worker";

export default createForcefieldWorker({
  platform: "wordpress",
  isAuthenticated: (request, env) => verifySessionCookie(request, env), // your own check
});
```

The Worker is also the way to cover the two WordPress installer screens the plugin
cannot see (below).

### WordPress plugin

`integrations/wordpress/ogiam-forcefield/` (version 0.2.0). Install, paste the
site label and key under Settings -> Forcefield, save. It declares
`platform: "wordpress"` and sends every field in the table above except
`asn`/`asOrg`.

What it covers: the guard runs on the WordPress `init` hook at priority 0, so it
sees every request WordPress handles: pages, `wp-login.php`, `xmlrpc.php`,
`wp-admin/admin-ajax.php`, the REST API (`/wp-json/` and `?rest_route=`) and
`wp-admin`. Version 0.1.0 used `template_redirect` and skipped `is_admin()`, so it
was blind to exactly those paths. `init` is the earliest hook where
`is_user_logged_in()` is reliable: WordPress sets up the current user right before
firing it.

What it does not cover: `wp-admin/install.php` and `wp-admin/setup-config.php`
load WordPress in installing mode, where no regular plugin runs. Put the
Cloudflare Worker in front of the site to cover them.

What it skips on purpose: WP-CLI, cron runs (`wp-cron.php`), and an administrator
saving the plugin's own settings (so a wrong key can always be fixed).

Client IP: `REMOTE_ADDR` by default. A proxy header (CF-Connecting-IP, X-Real-IP,
or the last X-Forwarded-For hop) is used only when the site owner picks it under
Client IP source, because on a server reachable directly any visitor can forge
those headers.

Block response, enforce mode only, anonymous requests only: a JSON 403 for the REST
API and admin-ajax, an XML-RPC fault with a 403 for `xmlrpc.php`, a plain 403 page
elsewhere. The text is fixed; no rule or engine detail is shown. Watch mode posts
fire-and-forget (non-blocking, 0.3 second timeout). Enforce mode waits up to 2
seconds and serves the request on any error, timeout, non-200 or unreadable
answer.

## Step 3: watch, then enforce

1. Set `FORCEFIELD_WEB=on`, `FORCEFIELD_INGEST_URL`, `FORCEFIELD_EDGE_TOKEN`,
   `FORCEFIELD_SITE`. Deploy. Confirm traffic appears in the site's dashboard.
2. After a clean watch window, set `FORCEFIELD_ENFORCE=on`. Verify with a read-only
   red-team (`npm run forcefield:redteam` against the site): a scanner UA / an
   injection payload / the honeypot path must return 403; benign must return 200.

## Step 4: turn the network on

Set `FORCEFIELD_DISTRIBUTE_BLOCKS=on` on the engine. Now a proven-hostile fingerprint
auto-blocked on any protected site is served in every site's ruleset, so the whole
fleet turns that actor away on sight. A tenant can opt out (`shares_intel=false`) and
still get full local protection. The network is the value: each site added makes
every site stronger.

## Safety recap

- Dark by default; watch-first; fail-open at every step. Forcefield can never take a
  site down.
- The shim sends only request SHAPE (no bodies, no cookies, no header values other
  than user-agent, accept and sec-fetch-dest). The client IP is classified and
  discarded, never stored.
- A request the site attests as signed in is never blocked by any connector.
- Enforce blocks ONLY proven-hostile requests (decoy trip, named scanner, injection
  payload, admin-blocked fingerprint). A real visitor is never turned away.
