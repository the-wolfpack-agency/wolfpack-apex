/**
 * Next.js Middleware — Security headers on every response.
 *
 * CSP is enforced (not report-only). All inline scripts in this codebase
 * are server-rendered JSON-LD structured data, which is acceptable under
 * 'unsafe-inline' in script-src until nonce support is standardized in
 * Next.js App Router (tracked: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy).
 *
 * HSTS: enabled in production only. Once the domain has been live for >1 week
 * with HSTS, submit to https://hstspreload.org (follow-up action).
 */

import { NextResponse } from "next/server";
import type { NextRequest, NextFetchEvent } from "next/server";
import { getObsClient } from "@/lib/obs";
import { forcefieldMonitor, forcefieldGuard, isSyntheticMonitor, constantTimeEqual } from "@/lib/forcefield-web/monitor";
import { CURRENT_SIGN_ALGORITHM, assertCallable } from "@/lib/crypto/algorithms";
import { ACCESS_TOKEN_COOKIE } from "@/lib/crypto/cookies";
import { imgSrcDirective } from "@/lib/csp-image-hosts";

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Paths we deliberately skip from observability spans to keep the
 * trace stream signal-rich. Health checks fire constantly and would
 * drown out real spans.
 */
const OBS_SKIP_PREFIXES = [
  "/api/health",
  "/api/healthz",
  "/api/csp-report", // self-reports; would loop on noisy clients
];

function shouldSpanRequest(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  for (const prefix of OBS_SKIP_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return false;
  }
  return true;
}

/**
 * CSP directives — enforced mode.
 *
 * 'unsafe-eval' has been removed (was never required; poses XSS escalation risk).
 * 'unsafe-inline' in script-src covers Next.js hydration + server-rendered JSON-LD.
 * frame-ancestors 'none' takes precedence over X-Frame-Options; both are set for
 * legacy browser compatibility.
 */
// frame-src: allow Instinct to iframe its own pages (the /sites/[id]/edit
// split-screen editor iframes /sites/[id]/preview) plus Vercel preview
// deployments (the /sites/[id] detail page iframes the live wolfpack-*
// .vercel.app client-site previews). frame-ancestors 'none' is the
// clickjacking defense — it's separate and stays locked down so
// Instinct itself can never be iframed by a third party.
// img-src is per route and never a bare `https:` (any-host images are a
// zero-click exfiltration channel for model output). The host list lives in
// src/lib/csp-image-hosts.ts so the renderers and the CSP share it.
const IMG_SRC_PLACEHOLDER = "img-src";
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
  IMG_SRC_PLACEHOLDER,
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https:",
  "frame-src 'self' https://*.vercel.app",
  // frame-ancestors 'self' (not 'none'): 'none' blocks Instinct from
  // iframing its own pages, which breaks the /sites/[id]/edit split-
  // screen editor (its preview iframe loads /sites/[id]/preview on
  // the SAME origin). 'self' keeps the clickjacking defense — no
  // third-party site can iframe Instinct — while allowing same-
  // origin embedding that the editor needs.
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "report-uri /api/csp-report",
];

/** The enforced CSP for one route. */
export function cspFor(pathname: string): string {
  return CSP_DIRECTIVES.map((d) => (d === IMG_SRC_PLACEHOLDER ? imgSrcDirective(pathname) : d)).join("; ");
}

/* ---------------------------------------------------------------------------
   Forcefield "authenticated" attestation for Instinct's own traffic.

   Most of what Forcefield flagged on Instinct was US: the signed-in app's own
   XHR (/api/analytics, /api/ms/chats/unread-count from the E2E HeadlessChrome),
   the GitHub-Actions crons (curl + CRON_SECRET on
   /api/automations/porsche-classes/poll, /api/admin/connectors/sharepoint/
   discover) and the factory driver. Forcefield suppresses weak tells for a
   request the SITE attests as authenticated, so this VERIFIES the credential -
   never trusts its mere presence (anyone can send an Authorization header):
     - the Instinct access JWT (Authorization Bearer or the instinct_access_token
       cookie): signature checked with WebCrypto HMAC under the algorithm the
       crypto registry names (src/lib/crypto/algorithms.ts), plus exp/nbf;
     - CRON_SECRET / INSTINCT_CRON_SECRET as a Bearer (the crons);
     - FACTORY_SERVICE_TOKEN in x-factory-token (the factory driver);
     - a verified synthetic monitor (x-forcefield-synthetic, the shared helper).
   Edge-safe (WebCrypto + atob, no jsonwebtoken / node:crypto), cheap (one HMAC,
   key cached), and FAIL-CLOSED: any error or unsupported algorithm = not
   authenticated, which only means "no noise suppression", never a block.
   --------------------------------------------------------------------------- */
const MAX_JWT_LENGTH = 8192;
let _hmacKey: { secret: string; key: CryptoKey } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Verify an Instinct-signed JWT at the edge. True only for a valid signature
 *  under the registry's current algorithm, not expired, not before nbf. */
async function verifyInstinctJwt(token: string, nowSec: number): Promise<boolean> {
  if (!token || token.length > MAX_JWT_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  // Crypto agility: the algorithm comes from the registry, and only the HMAC
  // family is implemented on the edge today. A registry move to RS256/ES256/ML-DSA
  // makes this fail closed (no suppression) until an edge verifier is added here.
  const alg = assertCallable(CURRENT_SIGN_ALGORITHM);
  if (alg.jwtAlg !== "HS256") return false;
  const header = b64urlJson(parts[0]);
  if (!header || header.alg !== alg.jwtAlg) return false;
  const secret = process.env.INSTINCT_JWT_SECRET ?? process.env.APEX_JWT_SECRET ?? "";
  if (!secret || (IS_PROD && secret.length < 32)) return false;
  if (!_hmacKey || _hmacKey.secret !== secret) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    _hmacKey = { secret, key };
  }
  const sig = b64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify("HMAC", _hmacKey.key, sig as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return false;
  const payload = b64urlJson(parts[1]);
  if (!payload || typeof payload.exp !== "number" || payload.exp <= nowSec) return false;
  if (typeof payload.nbf === "number" && payload.nbf > nowSec) return false;
  return true;
}

function secretMatches(presented: string, secret: string | undefined, minLength: number): boolean {
  if (!secret || secret.length < minLength || !presented) return false;
  return constantTimeEqual(presented, secret);
}

/** Did this request present a VERIFIED Instinct credential? Never throws. */
export async function forcefieldAuthenticated(req: NextRequest, nowMs: number = Date.now()): Promise<boolean> {
  try {
    if (isSyntheticMonitor(req.headers)) return true;
    const auth = req.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) {
      const bearer = auth.slice(7).trim();
      if (secretMatches(bearer, process.env.CRON_SECRET, 1) || secretMatches(bearer, process.env.INSTINCT_CRON_SECRET, 1)) return true;
      if (await verifyInstinctJwt(bearer, Math.floor(nowMs / 1000))) return true;
    }
    if (secretMatches((req.headers.get("x-factory-token") ?? "").trim(), process.env.FACTORY_SERVICE_TOKEN, 16)) return true;
    const cookie = req.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
    if (cookie && (await verifyInstinctJwt(cookie, Math.floor(nowMs / 1000)))) return true;
    return false;
  } catch {
    return false; // fail closed: an unverifiable credential is just "anonymous".
  }
}

export async function middleware(req: NextRequest, event?: NextFetchEvent) {
  /* Forcefield ENFORCEMENT - opt-in (FORCEFIELD_ENFORCE=on) on top of monitoring,
     FAIL-OPEN. Turns away ONLY proven-hostile requests (decoy trip, named attack
     tool, live injection payload, or an admin-blocked fingerprint) before the
     page is served. The guard returns null unless enforcement is enabled AND the
     request is proven hostile, so a normal visitor is never affected. The block
     is still reported to the board so the dashboard shows it was turned away. */
  // The Forcefield control plane must never be able to block itself: the ruleset
  // endpoint sites fetch, and the ingest they forward to, are infrastructure, not
  // attack surface. Excluding them stops a distributed fingerprint from cutting
  // off the very channel that distributes it.
  const ffPath = req.nextUrl.pathname;
  const ffControlPlane = ffPath.startsWith("/api/forcefield/") || ffPath.startsWith("/api/site-analytics/");
  // Verified only when Forcefield is on at all (both the guard and the monitor
  // are no-ops otherwise), so the dark default costs nothing.
  const ffOn = process.env.FORCEFIELD_WEB === "on";
  const authenticated = ffOn ? await forcefieldAuthenticated(req) : false;
  const ffArgs = { site: "instinct", req, authenticated, skipEnforcement: ffControlPlane, stack: ["nextjs"] };
  const block = ffControlPlane || !ffOn ? null : await forcefieldGuard(ffArgs);
  if (block) {
    if (event) event.waitUntil(forcefieldMonitor(ffArgs));
    return new NextResponse("Forbidden: this request was flagged as a hostile automated action.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "x-forcefield": `blocked:${block.reasonKind ?? "hostile"}` },
    });
  }

  const response = NextResponse.next();

  response.headers.set("Content-Security-Policy", cspFor(req.nextUrl.pathname));
  response.headers.set("X-Content-Type-Options", "nosniff");
  // X-Frame-Options for legacy browsers; CSP frame-ancestors takes precedence in modern browsers
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // HSTS is injected by Vercel edge on production domains — do not duplicate here.
  // See docs/security-posture.md for the full TLS / PQ posture.

  /* Observability: open + close a span for every API request so we
     have baseline latency + status traces without each route having
     to instrument itself. Middleware can't observe the downstream
     response status code (it runs before the handler), so we capture
     the parts we know — method, path, user_id (if a JWT is present
     in cookies/headers) — and rely on per-route spans for status. */
  try {
    const pathname = req.nextUrl.pathname;
    if (shouldSpanRequest(pathname)) {
      const obs = getObsClient();
      const userId =
        req.headers.get("x-instinct-user-id") ??
        req.cookies.get("instinct_user_id")?.value ??
        null;
      const handle = obs.startSpan(`api.${req.method}.${pathname}`, {
        method: req.method,
        path: pathname,
        user_id: userId,
      });
      // Close immediately — we can't await the downstream response
      // here without adopting a different middleware shape, and per
      // the brief we just want a request-arrived breadcrumb. Per-route
      // spans cover handler-level duration + status.
      handle.end("ok");
    }
  } catch {
    /* obs must never crash the host */
  }

  /* Forcefield self-defense - DARK BY DEFAULT, MONITOR-ONLY, FAIL-OPEN. The whole
     behavior lives in the shared shim: it is a no-op unless FORCEFIELD_WEB === "on"
     (an instant kill-switch), it only OBSERVES and forwards (never blocks), and it
     never touches `response`. Handed to waitUntil so the forward survives the
     response; the shim itself never throws. Instinct is just another surface. */
  if (event && ffOn) event.waitUntil(forcefieldMonitor(ffArgs));

  return response;
}

export const config = {
  // Apply to all routes except static files and images
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
