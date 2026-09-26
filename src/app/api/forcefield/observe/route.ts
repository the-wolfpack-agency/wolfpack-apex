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
 * Auth: x-edge-token (a per-site edge secret). FAIL-OPEN on any error - Forcefield
 * must never break a customer's site, so a bad token / bad body / engine throw all
 * return { action: "allow" }.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { observeRequest } from "@/lib/forcefield-web/observe";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { getBlockedFingerprints } from "@/lib/forcefield/blocked-fingerprints";
import { getDatacenterPrefixes } from "@/lib/forcefield/datacenter-ranges";
import { recordSiteEvent } from "@/lib/site-analytics";

const EDGE_WORKSPACE_ID = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";

function tokenMatches(got: string, expected: string): boolean {
  if (!expected || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.FORCEFIELD_EDGE_TOKEN || "";
  // No token configured, or mismatch -> do nothing, fail open. A site must never
  // be gated by a Forcefield outage.
  if (!expected || !tokenMatches(req.headers.get("x-edge-token") || "", expected)) {
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
  const site = s("site", "unknown");
  const headerNames = Array.isArray(b.headerNames) ? (b.headerNames as unknown[]).map(String) : [];
  const ip = typeof b.ip === "string" ? (b.ip as string) : undefined;
  const rawUrl = typeof b.rawUrl === "string" ? (b.rawUrl as string) : path;
  const accept = typeof b.accept === "string" ? (b.accept as string) : undefined;
  const secFetchDest = typeof b.secFetchDest === "string" ? (b.secFetchDest as string) : undefined;

  // The central ruleset: distributed blocklist (dark unless enabled) + the full
  // datacenter prefix set. Fail-safe to defaults so an error never turns real
  // traffic away or breaks classification.
  let blockedFingerprints: string[] = [];
  if (process.env.FORCEFIELD_DISTRIBUTE_BLOCKS === "on") {
    blockedFingerprints = await getBlockedFingerprints(EDGE_WORKSPACE_ID).catch(() => []);
  }
  const datacenterPrefixes = await getDatacenterPrefixes().catch(() => []);
  const ruleset = { ...DEFAULT_RULESET, blockedFingerprints, datacenterPrefixes };

  let action: "allow" | "block" = "allow";
  let eventType: string | null = null;
  let reasonKind: string | null = null;
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
      action = "block";
      reasonKind = decision.reasonKind ?? null;
    }
  } catch {
    /* fail-open: never break the site on an engine error */
  }

  return NextResponse.json({ action, eventType, reasonKind });
}
