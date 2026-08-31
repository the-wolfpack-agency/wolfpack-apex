/**
 * GET /api/auth/microsoft-start
 *
 * Public — no authentication required. Returns the Microsoft OAuth
 * authorization URL for the SIGN-IN flow (vs the existing
 * `/api/microsoft?action=auth-url` which is the CONNECT flow for
 * already-signed-in users).
 *
 * The callback at /api/microsoft/callback recognizes the `signin:`
 * prefix in the signed state, provisions the Instinct user from the
 * OAuth profile (domain-gated to @thewolfpack.agency), stores the
 * Graph tokens, mints an Instinct JWT, and redirects to /. One click
 * for both auth + Graph access — no separate password step.
 *
 * Returns `{ authUrl }` on success, 503 + `{ error }` when MS env
 * vars aren't configured (so the /login page can fall back to the
 * password form gracefully).
 */

import { NextResponse } from "next/server";
import { getSigninAuthUrl } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";

export async function GET() {
  const authUrl = getSigninAuthUrl();
  if (!authUrl) {
    return NextResponse.json(
      { error: "microsoft_signin_not_configured" },
      { status: 503 },
    );
  }
  trackEvent("system.microsoft_signin_started", "anonymous", "anonymous", {});
  return NextResponse.json({ authUrl });
}
