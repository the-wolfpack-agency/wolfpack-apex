import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, createToken, DEFAULT_WORKSPACE_ID } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { query } from "@/lib/db";
import { issueRefreshToken } from "@/lib/crypto/refresh-tokens";
import { sanitizeForLog } from "@/lib/log-sanitize";
import {
  setAuthCookie,
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/crypto/cookies";
import {
  exchangeCode,
  storeTokens,
  fetchUserProfile,
  clearCache,
  verifyState,
} from "@/lib/microsoft-graph";

const ALLOWED_SIGNIN_DOMAIN = (
  process.env.INSTINCT_SIGNIN_DOMAIN || "thewolfpack.agency"
).toLowerCase();

interface ProvisionedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  workspaceId: string;
}

/**
 * Provision-or-load an Instinct team member by email. Used by the
 * Microsoft sign-in flow — first-time MS sign-in for a member with no
 * existing row creates the row; existing rows are matched by email.
 *
 * Domain-gated: only INSTINCT_SIGNIN_DOMAIN (default thewolfpack.agency)
 * addresses can sign in this way. Anyone else sees a generic "domain
 * not allowed" error.
 *
 * Default role is "ops" — the catch-all for non-leadership team
 * members. Leadership rows seeded via migration 125 with their actual
 * roles ("ceo" for Hoxsie) are preserved by the email-keyed match.
 */
async function provisionOrLoadByEmail(
  email: string,
  displayName: string | null,
): Promise<ProvisionedUser | { denied: "domain_not_allowed" }> {
  const lowered = email.toLowerCase();
  const at = lowered.lastIndexOf("@");
  const domain = at < 0 ? "" : lowered.slice(at + 1);
  if (domain !== ALLOWED_SIGNIN_DOMAIN) {
    return { denied: "domain_not_allowed" };
  }
  /* SELECT-then-update-or-insert. Robust against the UNIQUE index
     shape: migration 128 created the constraint on LOWER(email)
     (expression index), but ON CONFLICT (email) only matches a
     constraint on the bare column. Going through SELECT first
     avoids the mismatch entirely + preserves seeded roles
     (we don't OVERWRITE role on update). */
  const existing = await query<{
    id: string;
    email: string;
    name: string;
    role: string;
    workspace_id: string | null;
  }>(
    `SELECT id, email, name, role, workspace_id
       FROM instinct_team_members
      WHERE LOWER(email) = $1 AND is_active = TRUE
      LIMIT 1`,
    [lowered],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    /* Refresh name if the OAuth profile gives us a non-empty value
       and the stored name is empty. Don't overwrite a curated name
       (e.g. seeded leadership). */
    if (
      displayName &&
      displayName.trim() &&
      (!row.name || row.name.trim() === row.email)
    ) {
      await query(
        `UPDATE instinct_team_members SET name = $2 WHERE id = $1`,
        [row.id, displayName],
      );
      row.name = displayName;
    }
    /* Stamp last_login so /admin/team can show who's actually
       signed in. Fire-and-forget. */
    query(
      `UPDATE instinct_team_members SET last_login = NOW() WHERE id = $1`,
      [row.id],
    ).catch((e) => console.warn("[ms-callback] last_login update failed:", (e as Error).message));
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      workspaceId: row.workspace_id ?? DEFAULT_WORKSPACE_ID,
    };
  }
  const inserted = await query<{
    id: string;
    email: string;
    name: string;
    role: string;
    workspace_id: string | null;
  }>(
    `INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active, created_at, last_login)
     VALUES (gen_random_uuid(), $1, COALESCE(NULLIF($2, ''), $1), 'ops', NULL, TRUE, NOW(), NOW())
     RETURNING id, email, name, role, workspace_id`,
    [lowered, displayName ?? ""],
  );
  const row = inserted.rows[0];
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    workspaceId: row.workspace_id ?? DEFAULT_WORKSPACE_ID,
  };
}

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

  // Azure AD sends error param if user denies access or something goes wrong.
  // Forward the Azure error code + the first line of error_description to the
  // dashboard so the user can see WHY (e.g. AADSTS65001 = admin consent
  // required for .All scopes, AADSTS50011 = redirect_uri mismatch).
  if (error) {
    console.warn(
      "[microsoft-graph] OAuth denied:",
      sanitizeForLog(error),
      sanitizeForLog(errorDescription),
    );
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("ms", "denied");
    redirectUrl.searchParams.set("error_code", error);
    if (errorDescription) {
      // Azure description is multiline + very long — keep the first line
      // for the banner; full text stays in the server log above.
      const firstLine = errorDescription.split(/\r?\n/)[0].slice(0, 240);
      redirectUrl.searchParams.set("detail", firstLine);
    }
    return NextResponse.redirect(redirectUrl);
  }

  if (!code) {
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "Missing authorization code");
    return NextResponse.redirect(redirectUrl);
  }

  // Recover the state. Two flows share this callback:
  //   1) `signin:<nonce>` — public sign-in flow, no existing session.
  //      We will provision/load the user by email AFTER token exchange.
  //   2) `<userId>`        — existing-session connect flow.
  // Both share the same HMAC-signed envelope.
  const verified = verifyState(state);
  if (!verified) {
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "Invalid OAuth state");
    return NextResponse.redirect(redirectUrl);
  }
  const isSigninFlow = verified.startsWith("signin:");
  if (!isSigninFlow && user && user.id !== verified) {
    // Session user disagrees with state — possible CSRF / link sharing.
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("ms", "error");
    redirectUrl.searchParams.set("detail", "OAuth state mismatch");
    return NextResponse.redirect(redirectUrl);
  }
  // For the connect flow this is the Instinct user id directly.
  // For the signin flow we resolve the user AFTER fetching the OAuth
  // profile, using a temporary "pending" id for the initial token store.
  const userId = isSigninFlow ? `pending:${verified}` : verified;

  // Exchange code for tokens
  const tokens = await exchangeCode(code);
  if (!tokens) {
    const redirectUrl = new URL("/", req.url);
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
    console.warn("[microsoft-graph] Failed to fetch user profile:", sanitizeForLog((err as Error).message));
    await storeTokens(tokens, userId, user?.email || "unknown");
  }

  trackEvent("microsoft.connected", userId, user?.role || "system", {
    user_email: userEmail || "unknown",
    display_name: displayName || "unknown",
    module: "microsoft-graph",
    flow: isSigninFlow ? "signin" : "connect",
  });

  // SIGN-IN FLOW: now that we have the verified email, provision/load
  // the team member, RE-STORE the tokens under the real user id, mint
  // an Instinct JWT, set the auth cookies, and redirect to /.
  if (isSigninFlow) {
    if (!userEmail) {
      const redirectUrl = new URL("/login", req.url);
      redirectUrl.searchParams.set("ms_signin", "error");
      redirectUrl.searchParams.set("detail", "no_profile_email");
      return NextResponse.redirect(redirectUrl);
    }
    const provisioned = await provisionOrLoadByEmail(
      userEmail,
      displayName ?? null,
    );
    if ("denied" in provisioned) {
      trackEvent("system.microsoft_signin_denied", "anonymous", "anonymous", {
        reason: provisioned.denied,
        email_domain: userEmail.split("@")[1] ?? "unknown",
      });
      const redirectUrl = new URL("/login", req.url);
      redirectUrl.searchParams.set("ms_signin", "denied");
      redirectUrl.searchParams.set("detail", "domain_not_allowed");
      return NextResponse.redirect(redirectUrl);
    }
    /* Re-store tokens under the resolved user id so getValidToken
       lookups by canonical user id work going forward. */
    await storeTokens(tokens, provisioned.id, userEmail, displayName);
    clearCache(provisioned.id);
    /* Mint Instinct JWT + refresh token, mirroring /api/auth/login. */
    const member = {
      id: provisioned.id,
      email: provisioned.email,
      name: provisioned.name,
      role: provisioned.role as Parameters<typeof createToken>[0]["role"],
      workspaceId: provisioned.workspaceId,
      created_at: "",
    };
    const accessToken = createToken(member);
    /* issueRefreshToken returns { tokenId, familyId }; the cookie value
       is the token id (mirrors /api/auth/login). DB write is skipped
       silently in shadow mode (no DATABASE_URL) so the sign-in still
       completes locally. */
    let refreshTokenId: string | undefined;
    if (process.env.DATABASE_URL) {
      try {
        const rt = await issueRefreshToken(provisioned.id);
        refreshTokenId = rt.tokenId;
      } catch (err) {
        console.warn(
          "[microsoft-signin] could not issue refresh token:",
          sanitizeForLog((err as Error).message),
        );
      }
    }
    trackEvent("system.login", provisioned.id, provisioned.role, {
      method: "microsoft_signin",
    });
    /* Post-sign-in landing is /assistant — the surface users actually
     *  interact with. Connection-status flash params ride along for
     *  any banner handler on that route to consume. */
    const redirectUrl = new URL("/assistant", req.url);
    redirectUrl.searchParams.set("ms", "connected");
    if (displayName) redirectUrl.searchParams.set("account", displayName);
    const res = NextResponse.redirect(redirectUrl);
    setAuthCookie(res, ACCESS_TOKEN_COOKIE, accessToken, ACCESS_TOKEN_TTL, {
      sameSite: "Lax",
    });
    if (refreshTokenId) {
      setAuthCookie(
        res,
        REFRESH_TOKEN_COOKIE,
        refreshTokenId,
        REFRESH_TOKEN_TTL_SECONDS,
        { sameSite: "Strict" },
      );
    }
    return res;
  }

  // CONNECT FLOW (existing behaviour): just redirect back to the page
  // they came from with the ms=connected banner.
  const rawReturnTo = url.searchParams.get("returnTo");
  const safePath =
    rawReturnTo &&
    rawReturnTo.startsWith("/") &&
    !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/";

  const redirectUrl = new URL(safePath, req.url);
  redirectUrl.searchParams.set("ms", "connected");
  if (displayName) {
    redirectUrl.searchParams.set("account", displayName);
  }

  return NextResponse.redirect(redirectUrl);
}
