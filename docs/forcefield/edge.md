# Forcefield Edge

Forcefield Edge is the full-protection option for a client site. The owner points
one hostname at Edge with one DNS record. Every request to that hostname then
passes through the Forcefield engine, including the bounded request-body checks
that stop PHP2Shell and React2Shell, and allowed traffic is forwarded to the
owner's own server. Edge runs on Vercel, which we already use.

Code: `edge/` (its own Next.js app and Vercel project, root directory `edge/`),
the shared proxy core `src/lib/forcefield-web/gateway.ts`, and the apex side in
`src/lib/forcefield-web/edge-sites.ts`, `edge-provision.ts`,
`src/app/api/forcefield/edge/site/` and `src/app/api/admin/forcefield/tenants/edge/`.

## How a request flows

1. A visitor requests `https://www.client.example/...`. DNS for that hostname is
   a CNAME to the Edge Vercel project, so the request lands on Edge.
2. `edge/proxy.ts` (Next.js 16 proxy, no matcher: every path) hands the request
   to `edge/lib/handle.ts`.
3. Edge looks up the hostname: `GET /api/forcefield/edge/site?host=` on apex,
   authorized by `FORCEFIELD_EDGE_SERVICE_TOKEN`. The answer is cached per
   instance (60 s for a known hostname, 30 s for an unknown one, and the last
   known record for up to an hour if apex cannot be reached).
   - Unknown hostname: `421 Misdirected Request`. Nothing is forwarded.
   - Lookup unavailable and nothing cached: `502`. Edge is never an open proxy.
4. Edge refuses what it cannot forward safely: a declared body over 4 MB gets
   `413` (Vercel Routing Middleware accepts at most 4 MB of request body), and an
   origin equal to the public hostname gets `508`.
5. The vendored engine decides (`decideEdgeRequest`): bounded body inspection
   (at most 256 KB read from a clone, never buffering the rest), then the same
   payload, header-attack, decoy, attack-tool and blocked-fingerprint rules every
   Forcefield site runs, then the session intent score.
6. The observation is reported to `POST /api/site-analytics/ingest` with the
   service token and `x-forcefield-edge-tenant`. Apex pins it to the tenant's
   site label, so Edge events land on the same board, alerts, operator
   fingerprints and shared threat network as every other Forcefield site.
7. The action:
   - `block`: `403` with `x-forcefield: blocked:<reason>`.
   - `decoy` (a trap path): `404`, recorded as blocked.
   - `tarpit` (intent, only with `FORCEFIELD_INTENT_ENFORCE=on`): delayed, then forwarded.
   - `allow`: an external rewrite to the origin. Method, path, query, headers
     and body are kept; `x-forcefield-edge`, `x-forwarded-host` and
     `x-forwarded-proto` are set; any copy of the Edge headers or the synthetic
     monitor header the visitor sent is removed first.

Blocking is watch-first. A request is turned away only when the Edge project has
`FORCEFIELD_ENFORCE=on` AND the tenant's own `enforce` flag is true, which apex
computes as the console enforce toggle AND a live license (the same two gates the
central engine applies). Otherwise the decision is still computed and recorded as
`would_block`. Once the tenant is known, any engine error forwards the request.

## The origin contract (`x-forcefield-edge`)

Every request Edge forwards carries `x-forcefield-edge: <tenant secret>`. The
secret is per tenant, issued by apex when the origin is first set (or rotated),
sealed at rest with `src/lib/crypto/secret-storage.ts`, and shown to the admin
once. A visitor cannot forge it through Edge (Edge strips any incoming copy),
and a request that goes straight to the origin never has it.

What the owner's server does, once it is ready to accept only Edge traffic:

1. Compare `x-forcefield-edge` with the secret in constant time.
2. Reject a request whose header is missing or different with `403`.
3. When the header matched, the visitor's hostname is in `x-forwarded-host` and
   the scheme in `x-forwarded-proto`. The origin receives its own hostname in
   `Host` (the forward goes to the origin URL), so an application that builds
   absolute URLs or redirects (WordPress `siteurl`, for example) must take the
   public hostname from `x-forwarded-host`, and must trust that header ONLY when
   `x-forcefield-edge` matched. Without this, a canonical-host redirect on the
   origin sends the visitor in a loop.
4. The visitor IP is in `x-forwarded-for` / `x-real-ip` as set by Vercel.

Rotation: `rotate_secret` issues a new value; Edge picks it up within the 60 s
cache. Accept both the old and new value on the origin during the switch.

The WordPress plugin side of this contract is a separate change.

## Apex side

Migration `301_forcefield_edge.sql`: `forcefield_tenants.edge_origin_url`,
`edge_origin_secret_sealed`, `edge_secret_rotated_at`, and the table
`forcefield_edge_hostnames` (hostname is the primary key, so one hostname can
never route to two tenants; stored normalized; removed with its tenant).

`POST /api/admin/forcefield/tenants/edge` (capability `settings.manage_team`,
every change audited, the secret never in the audit or analytics):

| action | does |
|---|---|
| `status` | origin, whether a secret exists, each hostname with its DNS record and state |
| `set_origin` `{ origin }` | https origin, public host only (the platform-scan SSRF guard); first set returns the secret once |
| `rotate_secret` | new secret, returned once |
| `add_hostname` `{ hostname }` | claims the hostname, adds it to the Edge Vercel project, returns the DNS record to create and whether it is live |
| `check_hostname` `{ hostname }` | re-reads the platform's verification and DNS state |

The Vercel calls reuse `src/lib/sites-domain.ts` with the existing team-scoped
`VERCEL_TOKEN_WOLFPACK_AGENCY` + `VERCEL_ORG_ID`, plus
`FORCEFIELD_EDGE_VERCEL_PROJECT_ID`. Unset, the action answers `503
edge_project_not_configured` and changes nothing on Vercel. The DNS record is
the platform's recommended value: a CNAME for a subdomain, an A record for an
apex domain, plus any ownership TXT record the platform asks for.

## Environment

Edge Vercel project:

| var | value |
|---|---|
| `FORCEFIELD_EDGE_SITE_URL` | `https://wolfpack-instinct.vercel.app/api/forcefield/edge/site` |
| `FORCEFIELD_EDGE_SERVICE_TOKEN` | same value as on apex (>= 32 chars), sensitive |
| `FORCEFIELD_INGEST_URL` | `https://wolfpack-instinct.vercel.app/api/site-analytics/ingest` |
| `FORCEFIELD_RULESET_URL` | `https://wolfpack-instinct.vercel.app/api/forcefield/ruleset` (optional) |
| `FORCEFIELD_ENFORCE` | `on` to allow blocking (still per tenant) |
| `FORCEFIELD_INTENT_ENFORCE` | optional, `on` to apply intent tarpit / block |
| `FORCEFIELD_SYNTHETIC_TOKEN` | optional, our verified monitors |

Apex: `FORCEFIELD_EDGE_SERVICE_TOKEN` and `FORCEFIELD_EDGE_VERCEL_PROJECT_ID`.

`edge/vercel.json` sets `x-vercel-enable-rewrite-caching: 0` so Edge does not
start caching origin responses the owner's server did not cache before.

## Limits

- Request bodies over 4 MB are refused (platform limit for Routing Middleware).
  A site that takes larger uploads needs those upload paths served another way.
- Body inspection reads the first 256 KB of a qualifying body (see
  `body-inspect.ts` for what that means for padded payloads).
- Ingest is rate-limited per tenant (600 events a minute); a busier site loses
  events past that, never requests.
- Edge cannot see a tenant's own signed-in sessions, so it treats every visitor
  as anonymous except our verified synthetic monitors.

## Proving it

Locally: `npm run edge:proof` builds the edge, starts it in front of a stub
origin and a stub apex, and runs every case (pass-through GET and POST, a 3.5 MB
upload, the 4 MB refusal, PHP2Shell and React2Shell shapes from the #1266
fixtures, watch mode, unknown hostname, events reaching the ingest). Run it under
the machine's heavy-check lock on a small machine.

Live, on `edge-test.ogiam.com`: see the steps in the PR that introduced Edge.
They add one CNAME for that one name; ogiam.com's other records and email are
not touched.

## One-click DNS (Domain Connect)

See `edge-domain-connect.md` and the template in
`edge/domain-connect/ogiam.com.forcefield-edge.json`.
