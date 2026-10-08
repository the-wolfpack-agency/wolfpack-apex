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
import { observeRequest } from "@/lib/forcefield-web/observe";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { getBlockedFingerprints } from "@/lib/forcefield/blocked-fingerprints";
import { getDatacenterPrefixes } from "@/lib/forcefield/datacenter-ranges";
import { recordSiteEvent } from "@/lib/site-analytics";
import { entitledToBlock, getSiteBlockEntitlement } from "@/lib/forcefield-web/billing";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";
import { trackEvent } from "@/lib/analytics";

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
    b = (await req.json()) as Record<string, unknown>;
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

  // The central ruleset: distributed blocklist (dark unless enabled) + the full
  // datacenter prefix set. Fail-safe to defaults so an error never turns real
  // traffic away or breaks classification.
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
  const ruleset = { ...DEFAULT_RULESET, blockedFingerprints, datacenterPrefixes };

  let action: "allow" | "block" = "allow";
  let eventType: string | null = null;
  let reasonKind: string | null = null;
  // wouldBlock: the engine proved this request hostile. It equals action when the
  // site is entitled to enforce, but stays true even when the paid gate withholds
  // the block - so the free tier can show "we would have blocked this".
  let wouldBlock = false;
  try {
    // The ENGINE: classify + stamp the stable operator fingerprint, then record.
    const obs = observeRequest(
      { site, path, method, userAgent, country, headerNames, accept, secFetchDest, ip, nowMs: Date.now() },
      ruleset,
    );
    if (obs) {
      eventType = obs.type;
      await recordSiteEvent({ eventType: obs.type, path: obs.path, country: country || null, props: obs.props }).catch(() => {});
    }
    // The DECISION (deterministic policy, not a model): decoy / attack tool /
    // payload / an admin-blocked operator fingerprint.
    const decision = decideEnforcement({ path, method, userAgent, headerNames, rawUrl }, ruleset, { blockedFingerprints });
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
  } catch {
    /* fail-open: never break the site on an engine error */
  }

  return NextResponse.json({ action, eventType, reasonKind, wouldBlock });
}
