import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  exchangeCode,
  storeTokens,
  fetchUserProfile,
  clearCache,
  verifyState,
} from "@/lib/microsoft-graph";

/**
 * GET /api/microsoft/callback?code=...&state=...
 *
 * OAuth2 callback from Azure AD. Exchanges the authorization code for tokens,
 * fetches the user profile, stores everything in the database, and redirects
 * to the dashboard.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Azure AD sends error param if user denies access or something goes wrong
  if (error) {
    console.warn("[microsoft-graph] OAuth denied:", error, errorDescription);
    const redirectUrl = new URL("/dashboard", req.url);
    redirectUrl.searchParams.set("ms", "denied");
    return NextResponse.redirect(redirectUrl);
  }

  if (!code) {
    const redirectUrl = new URL("/dashboard", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "Missing authorization code");
    return NextResponse.redirect(redirectUrl);
  }

  // Recover the instinct user from the signed state parameter. We do NOT
  // trust the session cookie alone — cross-site OAuth redirects often
  // drop SameSite cookies. The signed state is the authoritative source.
  // If state is missing, forged, or doesn't match the (optional) session
  // user, refuse to write anything.
  const stateUserId = verifyState(state);
  if (!stateUserId) {
    const redirectUrl = new URL("/dashboard", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "Invalid OAuth state");
    return NextResponse.redirect(redirectUrl);
  }
  if (user && user.id !== stateUserId) {
    // Session user disagrees with state — possible CSRF / link sharing.
    const redirectUrl = new URL("/dashboard", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "OAuth state mismatch");
    return NextResponse.redirect(redirectUrl);
  }
  const userId = stateUserId;

  // Exchange code for tokens
  const tokens = await exchangeCode(code);
  if (!tokens) {
    const redirectUrl = new URL("/dashboard", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "Token exchange failed");
    return NextResponse.redirect(redirectUrl);
  }

  // Fetch user profile to get email and display name
  let userEmail: string | undefined;
  let displayName: string | undefined;
  try {
    // Store tokens first so getValidToken(userId) works for the profile fetch
    tokens.user_email = "pending";
    await storeTokens(tokens, userId, "pending");
    clearCache(userId);

    const profile = await fetchUserProfile(userId);
    userEmail = profile?.email;
    displayName = profile?.displayName;

    // Update tokens with actual user email
    if (userEmail) {
      await storeTokens(tokens, userId, userEmail, displayName);
    }
  } catch (err) {
    console.warn("[microsoft-graph] Failed to fetch user profile:", (err as Error).message);
    await storeTokens(tokens, userId, user?.email || "unknown");
  }

  trackEvent("microsoft.connected", userId, user?.role || "system", {
    user_email: userEmail || "unknown",
    display_name: displayName || "unknown",
    module: "microsoft-graph",
  });

  // Honor returnTo if it's a safe same-origin path
  const rawReturnTo = url.searchParams.get("returnTo");
  const safePath =
    rawReturnTo &&
    rawReturnTo.startsWith("/") &&
    !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/dashboard";

  const redirectUrl = new URL(safePath, req.url);
  redirectUrl.searchParams.set("ms", "connected");
  if (displayName) {
    redirectUrl.searchParams.set("account", displayName);
  }

  return NextResponse.redirect(redirectUrl);
}
