import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { exchangeCode, storeTokens, fetchCompanyInfo, clearCache } from "@/lib/quickbooks";

/**
 * GET /api/quickbooks/callback?code=...&realmId=...&state=...
 *
 * OAuth2 callback from Intuit. Exchanges the authorization code for tokens,
 * stores them in the database, and redirects to the dashboard.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Intuit sends error param if user denies access
  if (error) {
    console.warn("[quickbooks] OAuth denied:", error);
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("qbo", "denied");
    return NextResponse.redirect(redirectUrl);
  }

  if (!code || !realmId) {
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("qbo", "error");
    redirectUrl.searchParams.set("detail", "Missing code or realmId");
    return NextResponse.redirect(redirectUrl);
  }

  // Exchange code for tokens
  const tokens = await exchangeCode(code, realmId);
  if (!tokens) {
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set("qbo", "error");
    redirectUrl.searchParams.set("detail", "Token exchange failed");
    return NextResponse.redirect(redirectUrl);
  }

  // Store tokens — use authenticated user ID if available, fallback to state
  const userId = user?.id || state || "oauth-callback";

  // Fetch company name to store alongside tokens
  // We temporarily need to set process-level token for the fetch
  let companyName: string | undefined;
  try {
    // Store tokens first, then fetch company info
    await storeTokens(tokens, userId);
    clearCache();

    const companyInfo = await fetchCompanyInfo();
    companyName = companyInfo?.companyName;

    if (companyName) {
      await storeTokens(tokens, userId, companyName);
    }
  } catch (err) {
    console.warn("[quickbooks] Failed to fetch company info:", (err as Error).message);
    await storeTokens(tokens, userId);
  }

  trackEvent("quickbooks.connected", userId, user?.role || "system", {
    realm_id: realmId,
    company_name: companyName || "unknown",
    module: "quickbooks",
  });

  // Honor returnTo if it's a safe same-origin path
  const rawReturnTo = url.searchParams.get("returnTo");
  const safePath =
    rawReturnTo &&
    rawReturnTo.startsWith("/") &&
    !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/";

  const redirectUrl = new URL(safePath, req.url);
  redirectUrl.searchParams.set("qbo", "connected");
  if (companyName) {
    redirectUrl.searchParams.set("company", companyName);
  }

  return NextResponse.redirect(redirectUrl);
}
