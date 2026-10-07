# Forcefield rollout: protect a site + join the network

Internal runbook. How to put Forcefield on one of our sites (or a client's), so it
protects that site AND joins the shared blocklist network: a proven-hostile agent
caught on any protected site is turned away on all of them. No em dashes.

## The model: one engine, a thin shim per site

The detection engine lives ONCE on the Instinct control plane
(`wolfpack-instinct.vercel.app`). Each protected site runs a thin SHIM in its own
edge (Next.js middleware or a Cloudflare Worker) that does two things per request:
forward the request SHAPE (path, method, header names, UA, country) to the engine,
and apply the verdict. The site carries no detection logic, so every engine
improvement is one deploy, live on every site at once.

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

### Cloudflare Worker

Use the same request shape and the same two env vars; the apex adapter at
`src/lib/forcefield-web/adapters/cloudflare-worker.ts` is the reference implementation
(observe + apply), vendored per site.

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
- The shim sends only request SHAPE (no bodies, no header values, no PII).
- Enforce blocks ONLY proven-hostile requests (decoy trip, named scanner, injection
  payload, admin-blocked fingerprint). A real visitor is never turned away.
