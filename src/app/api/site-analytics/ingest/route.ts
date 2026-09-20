/**
 * POST /api/site-analytics/ingest
 *
 * Server-to-server ingest for the OGIAM marketing site's usage telemetry. The
 * marketing site forwards its closed-vocabulary signal events here (from its own
 * server, not the browser), so site usage lands in our own platform and feeds
 * the admin Site Analytics heatmap. No third-party analytics product.
 *
 * Security posture (this is a PUBLIC endpoint on the app, so it is locked down):
 *   - Shared-secret header `x-ingest-token` must match SITE_ANALYTICS_INGEST_TOKEN
 *     (constant-time compare). No token configured -> 503 (disabled), never open.
 *   - Closed event vocabulary only; unknown types are 400.
 *   - No PII accepted or stored: only event type, path, 2-letter country,
 *     referrer host, and a small bounded props bag. Inputs are length-capped.
 *   - Global rate limit so a leaked token cannot flood the table.
 *   - Never trusts request-derived identity; writes anonymous rows.
 *
 * Responses: 200 { ok }, 400 invalid, 401 bad token, 429 rate limited,
 * 503 not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { isSiteEventType, recordSiteEvent } from "@/lib/site-analytics";
import { verifyPresentedDelegation, getDelegationIssuer, consumeDelegationJti } from "@/lib/forcefield/principal";
import { ingestSigningEnforced, verifyIngestSignature } from "@/lib/forcefield/ingest-signing";

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 600; // generous for a marketing site; bounds abuse.
// The marketing-site event stream is a single global tenant; its trusted
// delegation issuers live under this workspace id.
const SITE_WORKSPACE_ID = process.env.SITE_ANALYTICS_WORKSPACE_ID || "default";
let windowStart = 0;
let windowCount = 0;

export function _resetIngestRateLimit(): void {
  windowStart = 0;
  windowCount = 0;
}

function rateLimited(now: number): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    windowCount = 1;
    return false;
  }
  windowCount += 1;
  return windowCount > MAX_PER_WINDOW;
}

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

export async function POST(req: NextRequest) {
  const expected = process.env.SITE_ANALYTICS_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "ingest_disabled" }, { status: 503 });
  }

  const provided = req.headers.get("x-ingest-token") || "";
  if (!tokenMatches(provided, expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (rateLimited(Date.now())) {
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

  await recordSiteEvent({
    eventType: b.type,
    path: cap(b.path, 256),
    country: cap(b.country, 4),
    referrerHost: cap(b.referrer, 256),
    props,
  });

  return NextResponse.json({ ok: true });
}
