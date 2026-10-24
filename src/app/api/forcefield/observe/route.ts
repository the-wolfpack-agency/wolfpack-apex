/**
 * POST /api/forcefield/observe - the CENTRAL Forcefield engine.
 *
 * A connected site forwards RAW request signals (path, method, header names, UA,
 * country, IP); apex classifies, computes the stable operator fingerprint, RECORDS
 * the analytics event, and returns the enforcement decision. The site carries only
 * a thin, stable shim (forward + apply), so every engine change - a new detector,
 * the asset-flag fix, the operator fingerprint - is ONE apex deploy live on ALL
 * sites at once. No per-site re-vendoring, no divergent copies. This is what makes
 * Forcefield uniform and scalable to hundreds of sites from a single source.
 *
 * PUBLIC: unauthenticated by design in the session sense - a site's edge calls
 * this before any user session exists, so it is NOT capability-gated. It is
 * authorized by the `x-edge-token` header, which may be EITHER:
 *   - the shared FORCEFIELD_EDGE_TOKEN secret (our own first-party sites), or
 *   - a self-serve tenant's own ingest token (resolved + hashed via
 *     resolveTenantByToken). A tenant token scopes the request to that tenant's
 *     site: the `site` label is taken from the resolved tenant, NOT the body, so
 *     one tenant can never attribute or decide against another's site.
 * A missing/mismatched/disabled token does nothing. Constant-time compare for the
 * shared secret; the tenant lookup is by sha256 hash.
 *
 * FAIL-OPEN on any error - Forcefield must never break a customer's site, so a bad
 * token / bad body / engine throw all return { action: "allow" }.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { observeRequest, withEnforcement, clientKeys, isStaticAsset, type ObserveInput } from "@/lib/forcefield-web/observe";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { getBlockedFingerprints } from "@/lib/forcefield/blocked-fingerprints";
import { getDatacenterPrefixes } from "@/lib/forcefield/datacenter-ranges";
import { getCrawlerRanges } from "@/lib/forcefield/crawler-ranges";
import { noteRequest, rateKey } from "@/lib/forcefield/rate-window";
import { recordSiteEvent } from "@/lib/site-analytics";
import { entitledToBlock, getSiteBlockEntitlement } from "@/lib/forcefield-web/billing";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";
import { trackEvent } from "@/lib/analytics";
import { checkInboundForCanaries } from "@/lib/forcefield/canary-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDGE_WORKSPACE_ID = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";

function tokenMatches(got: string, expected: string): boolean {
  if (!expected || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// PUBLIC: unauthenticated (no user session); authorized by the x-edge-token
// header - either the shared secret OR a valid tenant token. See the file header.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const presented = req.headers.get("x-edge-token") || "";
  const expected = process.env.FORCEFIELD_EDGE_TOKEN || "";
  // Authorize by EITHER the shared first-party secret (constant-time) OR a
  // self-serve tenant's own token. A tenant token pins the site to that tenant
  // (tenant.siteLabel below), so the body `site` cannot be spoofed across tenants,
  // and carries the tenant's intel + enforce settings consulted later.
  let tenant: Awaited<ReturnType<typeof resolveTenantByToken>> = null;
  let authed = expected.length > 0 && tokenMatches(presented, expected);
  if (!authed && presented) {
    tenant = await resolveTenantByToken(presented).catch(() => null);
    if (tenant) authed = true;
  }
  // No valid token -> do nothing, fail open. A site must never be gated by a
  // Forcefield outage or a misconfigured token.
  if (!authed) {
    return NextResponse.json({ action: "allow" }, { status: 401 });
  }

  let b: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    b = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ action: "allow" }, { status: 400 });
  }

  const s = (k: string, d = ""): string => (typeof b[k] === "string" ? (b[k] as string) : d);
  const path = s("path");
  const method = s("method", "GET");
  const userAgent = s("userAgent");
  const country = s("country");
  // A tenant token pins the site to that tenant; only a first-party (shared-secret)
  // caller may name its own site in the body.
  const site = tenant?.siteLabel ?? s("site", "unknown");
  const headerNames = Array.isArray(b.headerNames) ? (b.headerNames as unknown[]).map(String) : [];
  const ip = typeof b.ip === "string" ? (b.ip as string) : undefined;
  const rawUrl = typeof b.rawUrl === "string" ? (b.rawUrl as string) : path;
  const accept = typeof b.accept === "string" ? (b.accept as string) : undefined;
  const secFetchDest = typeof b.secFetchDest === "string" ? (b.secFetchDest as string) : undefined;
  // SITE-ATTESTED by the shim (it verified a session / service credential / a
  // synthetic-monitor token locally; no credential crosses the wire). Boolean
  // only: anything else is anonymous.
  const authenticated = b.authenticated === true;
  // The site's platform ("wordpress"), so its native paths are not recon. A
  // short id only; anything else is ignored.
  const platformRaw = s("platform").toLowerCase();
  const platform = /^[a-z0-9_-]{1,32}$/.test(platformRaw) ? platformRaw : undefined;
  // Edge-supplied network attribution (Cloudflare request.cf.asn / asOrganization).
  // Stamped as-is for the board; never used to block.
  const asn = typeof b.asn === "number" && Number.isInteger(b.asn) && b.asn >= 0 && b.asn <= 4_294_967_295 ? (b.asn as number) : undefined;
  const asOrg = typeof b.asOrg === "string" && b.asOrg.trim() ? (b.asOrg as string).trim().slice(0, 80) : undefined;

  // The central ruleset: distributed blocklist (dark unless enabled) + the full
  // datacenter prefix set + the crawler ranges for verified-agent identity.
  // Fail-safe to defaults so an error never turns real traffic away or breaks
  // classification.
  // shares_intel opt-out: a tenant that opted OUT does not CONSUME the shared
  // network blocklist (it still gets full local detection: scanners, payloads,
  // decoys). Only suppressed when we positively resolved the opt-out, so a lookup
  // error never silently drops protection.
  let blockedFingerprints: string[] = [];
  const consumesSharedIntel = !(tenant && tenant.sharesIntel === false);
  if (process.env.FORCEFIELD_DISTRIBUTE_BLOCKS === "on" && consumesSharedIntel) {
    blockedFingerprints = await getBlockedFingerprints(EDGE_WORKSPACE_ID).catch(() => []);
  }
  const datacenterPrefixes = await getDatacenterPrefixes().catch(() => []);
  // Per-request path: never waits on the vendors (a cold instance answers
  // "unverifiable" while one background refresh warms the cache).
  const verifiedAgentRanges = await getCrawlerRanges({ waitMs: 0 }).catch(() => ({}));
  const ruleset = { ...DEFAULT_RULESET, blockedFingerprints, datacenterPrefixes, verifiedAgentRanges };

  let action: "allow" | "block" = "allow";
  let eventType: string | null = null;
  let reasonKind: string | null = null;
  // wouldBlock: the engine proved this request hostile. It equals action when the
  // site is entitled to enforce, but stays true even when the paid gate withholds
  // the block - so the free tier can show "we would have blocked this".
  let wouldBlock = false;
  try {
    const nowMs = Date.now();
    const input: ObserveInput = {
      site, path, method, userAgent, country, headerNames, accept, secFetchDest, ip, rawUrl, authenticated, platform, nowMs,
    };
    // 1. The DECISION first (deterministic policy, not a model): decoy / payload
    //    / header attack / attack tool / an admin-blocked operator fingerprint.
    //    Decided BEFORE recording so the stored row says what actually happened.
    const decision = decideEnforcement(
      { path, method, userAgent, headerNames, rawUrl, authenticated, ip },
      ruleset,
      { blockedFingerprints },
    );
    if (decision.block) {
      wouldBlock = true;
      reasonKind = decision.reasonKind ?? null;
      // ENFORCE-TO-PAID: watching is free, blocking is paid. Resolve the site's
      // license centrally (never from a client-controlled signal) ONLY now that a
      // block is pending, so the common path adds no DB read. An unmanaged site
      // (null: our own/first-party, not a SaaS tenant) enforces as configured.
      const licensed = await getSiteBlockEntitlement(site).catch(() => null);
      // Managed tenants gate blocking on the console enforce toggle (watch-first);
      // a first-party site (no tenant) enforces as configured by its shim env.
      const tenantAllowsEnforce = !tenant || tenant.enforceEnabled === true;
      if (entitledToBlock(licensed) && tenantAllowsEnforce) {
        action = "block";
      } else if (entitledToBlock(licensed) && !tenantAllowsEnforce) {
        // Console enforce toggle OFF: withhold the block, keep the recorded event.
        void trackEvent("forcefield.block_withheld_watch", `site:${site}`, "forcefield", {
          site, reasonKind: reasonKind ?? "unknown",
        });
      } else {
        // Free tier: withhold the block, keep the recorded event, surface the upsell.
        void trackEvent("forcefield.block_withheld_unlicensed", `site:${site}`, "forcefield", {
          site, reasonKind: reasonKind ?? "unknown",
        });
      }
    }

    // 2. The ENGINE: classify + stamp the stable operator fingerprint, then the
    //    enforcement outcome (blocked, or would_block when a gate withheld it).
    //    A blocked request with no other tell is still recorded.
    const obs = withEnforcement(observeRequest(input, ruleset), input, ruleset, {
      wouldBlock,
      blocked: action === "block",
      reasonKind: decision.reasonKind,
      attack: decision.attack,
    });
    if (obs) {
      eventType = obs.type;
      const props = { ...obs.props };
      if (asn !== undefined && obs.type !== "site.page_viewed") props.asn = asn;
      if (asOrg && obs.type !== "site.page_viewed") props.as_org = asOrg;
      await recordSiteEvent({ eventType: obs.type, path: obs.path, country: country || null, props }).catch(() => {});
    }

    // 3. LIVE RATE: a client making requests faster than a person can (an
    //    autonomous agent, a path sweep) reports once per 10s window. Static page
    //    sub-resources are not counted; authenticated traffic (our own monitors,
    //    signed-in app XHR) is skipped. Report-only, keyed in memory (IP never
    //    stored). Needs the client IP: without it every visitor sharing a browser
    //    UA would collapse into one key and add up to a false burst.
    if (ip && !authenticated && !isStaticAsset(path)) {
      const hit = noteRequest(rateKey(site, ip, userAgent), nowMs);
      if (hit) {
        const k = clientKeys(input, ruleset);
        await recordSiteEvent({
          eventType: "site.agent_high_rate",
          path,
          country: country || null,
          props: { site, sig: k.sig, fp: k.fp, client_type: k.client.clientType, rate: hit.count, window_s: Math.round(hit.windowMs / 1000) },
        }).catch(() => {});
      }
    }
  } catch {
    /* fail-open: never break the site on an engine error */
  }

  // 4. TRIPWIRE: a decoy route, decoy credential, honey-row value or honeypot
  //    tool name in the request (path / raw URL) is a canary trip. Recorded as
  //    an event + audit entry and alerted (deduped per decoy + 6h window).
  //    Cached decoy list, so no DB read per request; never throws.
  const trip = await checkInboundForCanaries({
    workspaceId: EDGE_WORKSPACE_ID,
    clientLabel: `site:${site}`,
    url: rawUrl || path,
    site,
  }).catch(() => null);

  return NextResponse.json({ action, eventType, reasonKind, wouldBlock, ...(trip?.tripped ? { canaryTripped: true } : {}) });
}
