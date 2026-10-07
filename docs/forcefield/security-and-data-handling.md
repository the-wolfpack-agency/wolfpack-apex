# Forcefield Security and Data Handling (DRAFT, internal, confidential)

Status: DRAFT, fact-checked against the code on 2026-10-06. This is the factual
basis the Privacy Policy and DPA draw from; keep it true as the code changes. No
em dashes.

## 0. Deterministic core (compliance scope)

Forcefield's detection + enforcement is DETERMINISTIC: behavioral classification,
traps, and rules, not a probabilistic model. The AI-governance frameworks govern
probabilistic AI, so they do not gate the core. Only two optional surfaces touch a
model (agent-intelligence enrichment and the operator signup summary); both route
through the governed model router and are gateable off for a lean launch. See
`launch-readiness.md`.

A per-deployment AI kill-switch is available: setting `FORCEFIELD_AI_DISABLED`
(on/true/1) turns the operator AI summary off and guarantees NO model is ever
called, so a deployment can run with zero AI touchpoints and we can tell a reviewer
so truthfully. The deterministic runtime never calls a model regardless (enforced
by a build-failing guardrail).

## 1. What Forcefield collects (and what it does not)

For each request the edge shim forwards, the engine records request METADATA and a
classification, never request contents:

Collected:
- Request path and HTTP method.
- User-Agent string.
- Header NAMES only (the list of header keys), used for tool/agent fingerprinting.
- Coarse geo: the country from the edge (`x-vercel-ip-country`), when present.
- A derived operator fingerprint (a stable hash over header-name shape + client
  classification), used to group an agent's activity.
- The classification outcome and event type (e.g. `site.agent_welcomed`,
  `site.agent_trap_tripped`, `site.agent_payload_attack`) and counts.

NOT collected by the engine:
- Page content, response bodies, or rendered HTML.
- Header VALUES (only the names), cookies, authorization headers, or tokens.
- Form field values, query-string contents beyond the path, or request bodies.
- Visitor identity, account identifiers, or any field we would treat as PII by
  design. Coarse country is the only location signal; no precise IP is stored in
  the event record.

The guiding rule: Forcefield answers "what kind of automated client hit this path
and what did it try," not "who is this person and what did they read."

## 2. Credentials at rest

- Per-tenant ingest tokens are stored only as a SHA-256 hash (`token_sha256`); the
  raw token is shown once at issue and never recoverable. A database read is not a
  credential leak.
- Resolution is by hash, active-tenant only; a disabled or unknown token resolves
  to nothing and the edge path fails open.

## 3. Tenant isolation

- Every client-facing read is scoped to the tenant the presented token resolves
  to (`forcefield_tenant_id`). A token can only ever read its own tenant's counts.
- The registry of tenant tables is held honest by a build-failing tenant-scoping
  guardrail. DB-level RLS on the attribution column is the defense-in-depth goal
  (tracked; app-side scoping is enforced today). This is stated honestly in the
  readiness board, which grades the product from real facts.

## 4. Where data is processed

- The engine, ingest, dashboard, and tenant/signup records run on our Vercel
  deployment (`wolfpack-instinct`) backed by Neon Postgres. See `subprocessors.md`
  for regions and the full list.
- The optional operator AI triage summary sends only the submitted signup fields
  (name, work email, site, note) to the model router, which may dispatch to Azure
  OpenAI. It is off unless configured, derives no data from the customer's live
  traffic, and never fetches the prospect's site.

## 5. Retention

- `[DECISION]` the raw-event retention window (proposal: rolling 90 days of raw
  `site_analytics_events`, with counts/aggregates kept longer). Must match the
  number stated in the DPA and Privacy Policy once chosen.
- On tenant offboarding: deactivate immediately; purge raw events per the window.

## 6. Transport and tenancy of the edge

- The shim forwards signals to the central engine over HTTPS with the tenant's
  ingest token in a header.
- The edge adapter (Cloudflare Worker or Next.js middleware) typically runs in the
  CUSTOMER's own platform account, so their inbound request data transits their
  infrastructure first. The DPA must state this boundary clearly.

## 7. Known honest gaps (do not paper over)

- `FORCEFIELD_ENFORCE` (active blocking) verification on the live edge is a
  separate, open track from this self-serve layer; watch mode is the safe default.
- DB-level RLS is pending (app-side scoping enforced today), as above.
- A public status endpoint for the SLA is not yet built.
These are stated so the Privacy/DPA/SLA never overclaim.

## 8. Shared threat-intelligence boundary

Forcefield operates a shared network: a proven-hostile agent caught on any site can
be blocked on the others. What crosses the boundary is strictly limited:

- Shared: an OPAQUE attacker fingerprint (a hash over the request-shape + the
  classification) and the reason it was blocked. These identify how a hostile agent
  BEHAVES, not who any visitor is.
- NOT shared: request contents, page data, visitor identity, a customer's traffic,
  or anything from which a person or a page could be reconstructed. Only
  proven-hostile actors enter the shared list; normal visitors and good bots never do.
- Opt-out: a tenant can set `shares_intel = false` (admin toggle) to neither
  contribute to nor consume the shared list, and still get full local protection.
  Default is to participate, because the network is the value.
