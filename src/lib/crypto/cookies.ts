/**
 * Auth cookie helper for Instinct.
 *
 * All auth/session cookie writes MUST go through setAuthCookie() so security
 * flags can never drift between endpoints. Never call response.cookies.set()
 * directly for auth cookies.
 *
 * Flags enforced:
 *   HttpOnly   — prevents XSS token theft via document.cookie
 *   Secure     — HTTPS only (production); omitted in development
 *   SameSite   — Lax for session cookies, Strict for refresh-token cookies
 *   Path=/     — cookie sent on all routes
 *   Max-Age    — matches the token's TTL so cookie expires with the token
 */

import { type NextResponse } from "next/server";

export type SameSitePolicy = "Lax" | "Strict" | "None";

export interface AuthCookieOptions {
  /** Seconds until the cookie expires. Defaults to 900 (15 min). */
  maxAgeSeconds?: number;
  /**
   * SameSite policy.
   * - "Lax"    — for session / access-token cookies (default)
   * - "Strict" — for refresh-token cookies (never sent on cross-site nav)
   */
  sameSite?: SameSitePolicy;
}

/** Canonical access-token cookie name */
export const ACCESS_TOKEN_COOKIE = "instinct_access_token";
/** Canonical refresh-token cookie name */
export const REFRESH_TOKEN_COOKIE = "instinct_refresh_token";

/** Access-token TTL: 15 minutes */
export const ACCESS_TOKEN_TTL = 15 * 60;
/** Refresh-token TTL: 7 days */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** @deprecated Use REFRESH_TOKEN_TTL_SECONDS */
export const REFRESH_TOKEN_TTL = REFRESH_TOKEN_TTL_SECONDS;

/**
 * Set an auth cookie with hardened flags on a NextResponse.
 *
 * @param res          The NextResponse to attach the cookie to.
 * @param name         Cookie name.
 * @param value        Cookie value (JWT string, opaque token, etc.).
 * @param maxAgeSeconds TTL in seconds. Defaults to ACCESS_TOKEN_TTL (900 s).
 * @param opts         Optional SameSite override and other settings.
 */
export function setAuthCookie(
  res: NextResponse,
  name: string,
  value: string,
  maxAgeSeconds: number = ACCESS_TOKEN_TTL,
  opts: AuthCookieOptions = {},
): void {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite = opts.sameSite ?? "Lax";

  res.cookies.set(name, value, {
    httpOnly: true,
    secure: isProduction,
    sameSite: sameSite.toLowerCase() as "lax" | "strict" | "none",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

/**
 * Clear an auth cookie by setting it to empty with Max-Age=0.
 */
export function clearAuthCookie(res: NextResponse, name: string): void {
  res.cookies.set(name, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
