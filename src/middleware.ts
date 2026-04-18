/**
 * Next.js Middleware — Security headers on every response.
 *
 * CSP is enforced (not report-only). All inline scripts in this codebase
 * are server-rendered JSON-LD structured data, which is acceptable under
 * 'unsafe-inline' in script-src until nonce support is standardised in
 * Next.js App Router (tracked: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy).
 *
 * HSTS: enabled in production only. Once the domain has been live for >1 week
 * with HSTS, submit to https://hstspreload.org (follow-up action).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const IS_PROD = process.env.NODE_ENV === "production";

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
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
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
].join("; ");

export function middleware(_req: NextRequest) {
  const response = NextResponse.next();

  response.headers.set("Content-Security-Policy", CSP_DIRECTIVES);
  response.headers.set("X-Content-Type-Options", "nosniff");
  // X-Frame-Options for legacy browsers; CSP frame-ancestors takes precedence in modern browsers
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // HSTS is injected by Vercel edge on production domains — do not duplicate here.
  // See docs/security-posture.md for the full TLS / PQ posture.

  return response;
}

export const config = {
  // Apply to all routes except static files and images
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
