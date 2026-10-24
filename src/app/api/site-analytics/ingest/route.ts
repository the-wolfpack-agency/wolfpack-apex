/**
 * POST /api/site-analytics/ingest
 *
 * Server-to-server ingest for the OGIAM marketing site's usage telemetry. The
 * marketing site forwards its closed-vocabulary signal events here (from its own
 * server, not the browser), so site usage lands in our own platform and feeds
 * the admin Site Analytics heatmap. No third-party analytics product.
 *
 * Security posture (this is a PUBLIC endpoint on the app, so it is locked down):
 *   - Header `x-ingest-token` must be EITHER a shared secret
 *     (SITE_ANALYTICS_INGEST_TOKEN / _2, constant-time compare) OR an active
 *     Forcefield tenant's own ingest token (matched by hash). A tenant token pins
 *     the event's site to that tenant's site label, so one tenant can never write
 *     another's site. No shared token and no tenant registry -> 503, never open.
 *   - Closed event vocabulary only; unknown types are 400.
 *   - No PII accepted or stored: only event type, path, 2-letter country,
 *     referrer host, and a small bounded props bag. Inputs are length-capped.
 *   - Global rate limit so a leaked token cannot flood the table.
 *   - Never trusts request-derived identity; writes anonymous rows.
 *
 * Live rate (vendored sites): a vendored site forwards observations without the
 * client IP, so the edge rate window cannot run there. Here, every non-page-view
 * agent observation is counted per (site, session sig) and one
 * site.agent_high_rate is recorded per burst. Page views never count: many real
 * visitors share one hourly sig.
 *
 * Responses: 200 { ok }, 400 invalid, 401 bad token, 429 rate limited,
 * 503 not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { isSiteEventType, recordSiteEvent } from "@/lib/site-analytics";
import { autoBlockFingerprint } from "@/lib/forcefield/blocked-fingerprints";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";
import { verifyPresentedDelegation, getDelegationIssuer, consumeDelegationJti } from "@/lib/forcefield/principal";
import { ingestSigningEnforced, verifyIngestSignature } from "@/lib/forcefield/ingest-signing";
import { noteRequest, rateKey } from "@/lib/forcefield/rate-window";

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 600; // generous for a marketing site; bounds abuse.
// The marketing-site event stream is a single global tenant; its trusted
// delegation issuers live under this workspace id.
const SITE_WORKSPACE_ID = process.env.SITE_ANALYTICS_WORKSPACE_ID || "default";

/** Constant-time string compare that never throws on length mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cap(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** Event types that count toward the ingest live-rate window: agent observations
 *  only. A page view is excluded (many real visitors share one hourly sig) and a
 *  high-rate event is the window's own output, never its input. */
function countsTowardRate(type: string): boolean {
  return type.startsWith("site.agent_") && type !== "site.agent_high_rate";
}

export async function POST(req: NextRequest) {
  // Accept ANY configured shared ingest token, so each internal property can
  // carry its own secret without sharing one value or rotating the others. The
  // primary SITE_ANALYTICS_INGEST_TOKEN stays for existing forwarders (e.g.
  // ogiam.com); SITE_ANALYTICS_INGEST_TOKEN_2 lets new sites onboard without
  // touching it. Each candidate is compared in constant time.
  const expected = [
    process.env.SITE_ANALYTICS_INGEST_TOKEN,
    process.env.SITE_ANALYTICS_INGEST_TOKEN_2,
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
  // With no shared token AND no tenant registry there is nothing a caller could
  // authenticate against: disabled, never open.
  if (expected.length === 0 && !process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "ingest_disabled" }, { status: 503 });
  }

  const provided = req.headers.get("x-ingest-token") || "";
  const sharedOk = expected.some((t) => tokenMatches(provided, t));
  // A tenant's OWN token is the self-serve path. It used to be dead: the shared
  // secret check above returned 401 for any other value, so the tenant lookup
  // further down was never reached with a tenant token. Resolve it here, before
  // anything else, only when the shared secret did not match.
  const tenant = sharedOk || !provided ? null : await resolveTenantByToken(provided);
  if (!sharedOk && !tenant) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // DURABLE rate limit: a DB fixed-window counter (shared across all lambdas,
  // survives cold starts), not per-instance in-memory state that a leaked token
  // could flood past by hitting many instances. Fail-closed on a DB error. Each
  // tenant gets its own bucket, so one noisy tenant cannot starve the others.
  const rl = await checkRateLimit(tenant ? `site-analytics:ingest:tenant:${tenant.id}` : "site-analytics:ingest", { limit: MAX_PER_WINDOW, windowMs: WINDOW_MS });
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const rawBody = await req.text();

  // Signed ingest (gap #1): when enforced, a valid shared token is NOT enough -
  // the batch must be signed by a registered source. Fail-closed.
  if (ingestSigningEnforced()) {
    const check = await verifyIngestSignature({
      sourceId: req.headers.get("x-ingest-source") || "",
      timestamp: Number(req.headers.get("x-ingest-timestamp")),
      signature: req.headers.get("x-ingest-signature") || "",
      rawBody,
      nowMs: Date.now(),
    });
    if (!check.ok) {
      return NextResponse.json({ ok: false, error: "unsigned_or_bad_signature" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (!isSiteEventType(b.type)) {
    return NextResponse.json({ ok: false, error: "unknown_event_type" }, { status: 400 });
  }

  // Coarse, non-identifying props only; bounded to avoid an oversized row.
  const props: Record<string, string | number | boolean> = {};
  if (b.props && typeof b.props === "object" && !Array.isArray(b.props)) {
    for (const [k, v] of Object.entries(b.props as Record<string, unknown>).slice(0, 12)) {
      if (typeof v === "string") props[k] = v.slice(0, 120);
      else if (typeof v === "number" || typeof v === "boolean") props[k] = v;
    }
  }

  // Know the Principal: if the agent presented a signed delegation credential,
  // verify it HERE, fail-closed, and store only the non-sensitive VERDICT - never
  // the raw credential. "verified" means the signature checked out against a
  // registered issuer and it has not expired; anything else is "claimed". This is
  // the honesty rail: the marketing site cannot hold our issuer secrets, so it
  // cannot self-certify a principal - only this boundary can.
  // Always run the verifier: it returns "absent" for a missing/empty credential,
  // so the decision to verify is NOT gated on a user-controlled value, and a
  // missing credential can never bypass anything - absent is the untrusted
  // default. Only a non-absent verdict writes principal props.
  const presented = typeof b.delegation === "string" && b.delegation.length > 0 ? b.delegation : null;
  const verdict = await verifyPresentedDelegation(presented, {
    resolveIssuer: (iss) => getDelegationIssuer(SITE_WORKSPACE_ID, iss),
    nowSeconds: Math.floor(Date.now() / 1000),
    audience: process.env.SITE_ANALYTICS_AUDIENCE,
    // Reject a credential signed more than 10 minutes ago, and accept each jti
    // only once - a captured credential cannot be replayed.
    maxAgeSeconds: 600,
    consumeJti: (jti, exp) => consumeDelegationJti(SITE_WORKSPACE_ID, jti, exp),
  });
  if (verdict.status !== "absent") {
    props.principal_status = verdict.status;
    if (verdict.principal) props.principal = verdict.principal.slice(0, 120);
    if (verdict.issuer) props.principal_issuer = verdict.issuer.slice(0, 120);
    if (verdict.scopes.length > 0) props.principal_scopes = JSON.stringify(verdict.scopes).slice(0, 400);
  }
  // The raw credential is never persisted.
  delete (props as Record<string, unknown>).delegation;

  // Per-tenant attribution: when the presented ingest token belongs to an onboarded
  // Forcefield tenant, attribute the event to it and stamp its site label as the
  // authoritative `site` (so a tenant cannot spoof another's site via props). The
  // shared-token internal sites resolve to no tenant and keep their own props.site.
  if (tenant) props.site = tenant.siteLabel;

  const path = cap(b.path, 256);
  const country = cap(b.country, 4);
  await recordSiteEvent({
    eventType: b.type,
    path,
    country,
    referrerHost: cap(b.referrer, 256),
    props,
    tenantId: tenant?.id ?? null,
  });

  // Live rate for vendored sites (no IP reaches us): count agent observations
  // per (site, session sig); one high-rate event per burst, report-only.
  if (countsTowardRate(b.type) && typeof props.sig === "string" && props.sig) {
    const site = typeof props.site === "string" && props.site ? props.site : "ogiam.com";
    const hit = noteRequest(rateKey(site, props.sig, "obs"), Date.now());
    if (hit) {
      const burst: Record<string, string | number | boolean> = {
        site,
        sig: props.sig,
        rate: hit.count,
        window_s: Math.round(hit.windowMs / 1000),
        source: "ingest",
      };
      if (typeof props.fp === "string" && props.fp) burst.fp = props.fp;
      await recordSiteEvent({ eventType: "site.agent_high_rate", path, country, props: burst, tenantId: tenant?.id ?? null });
    }
  }

  // Flywheel: a honeytoken trip is the highest-confidence hostile signal, so
  // auto-block that client fingerprint. The central ruleset then turns it away on
  // its next hit across every connected site (enforced when FORCEFIELD_ENFORCE=on).
  if (b.type === "site.agent_trap_tripped" && typeof props.fp === "string" && props.fp) {
    await autoBlockFingerprint(props.fp, "honeytoken").catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
