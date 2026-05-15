/**
 * GET /api/admin/connectors/oauth/[provider]/callback
 *
 * Generic OAuth callback handler. Verifies the signed state from
 * /start, exchanges the authorization code with the provider, and
 * persists the resulting access + refresh tokens via the orchestrator.
 *
 * No capability gate here on purpose: the OAuth state is HMAC-signed
 * and bound to (workspace, provider, nonce, exp). Anyone hitting this
 * URL without a valid state token is rejected. The state implicitly
 * proves the requester previously passed the /start route's
 * settings.manage_team check.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import { verifyToken } from "@/lib/crypto/sign";
import { getOAuthProvider } from "@/lib/assistant/connectors/oauth/registry";
import { saveOAuthCredentials } from "@/lib/assistant/connectors/oauth/refresh";

interface OAuthStateClaims {
  v: 1;
  workspace_id: string;
  provider: string;
  nonce: string;
  return_to?: string;
}

function fail(req: NextRequest, code: string, message: string): NextResponse {
  /* For browser-visible failures, redirect the user back to a sensible
     page with the error in the query string so the UI can render it.
     /admin/connectors is the canonical landing page. */
  const url = new URL(req.url);
  const back = new URL("/admin/connectors", url.origin);
  back.searchParams.set("oauth_error", code);
  back.searchParams.set("oauth_message", message.slice(0, 200));
  return NextResponse.redirect(back);
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider: providerName } = await context.params;
  const url = new URL(req.url);

  /* Provider rejected the user (denied consent, app misconfigured, etc).
     Surface the error to the admin UI; don't even attempt the exchange. */
  const providerError = url.searchParams.get("error");
  if (providerError) {
    trackEvent("assistant.oauth_authorization_denied", "system", "system", {
      provider: providerName,
      reason: providerError,
    });
    return fail(req, providerError, url.searchParams.get("error_description") || providerError);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return fail(req, "missing_code_or_state", "OAuth callback missing code or state");
  }

  const verified = verifyToken<OAuthStateClaims>(state);
  if (!verified.valid) {
    return fail(req, "invalid_state", "OAuth state failed verification (expired or tampered)");
  }
  if (verified.payload.provider !== providerName) {
    return fail(req, "provider_mismatch", "OAuth state was minted for a different provider");
  }

  const provider = getOAuthProvider(providerName);
  if (!provider) {
    return fail(req, "unknown_provider", `OAuth provider "${providerName}" not registered`);
  }

  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    return fail(
      req,
      "oauth_app_not_configured",
      `${provider.clientIdEnv}/${provider.clientSecretEnv} unset on server`,
    );
  }

  const redirectUri = `${url.origin}/api/admin/connectors/oauth/${providerName}/callback`;
  const exchange = await provider.exchangeCode({
    clientId,
    clientSecret,
    code,
    redirectUri,
  });
  if (!exchange.ok) {
    trackEvent("assistant.oauth_authorization_failed", "system", "system", {
      provider: providerName,
      workspace_id: verified.payload.workspace_id,
      code: exchange.code,
      status: exchange.status ?? 0,
    });
    return fail(req, exchange.code, exchange.message);
  }

  const persisted = await saveOAuthCredentials({
    workspaceId: verified.payload.workspace_id,
    provider,
    token: exchange,
  });
  if (!persisted) {
    /* saveOAuthCredentials emits its own oauth_persist_failed event. */
    return fail(req, "persist_failed", "Authorized successfully but failed to store credentials");
  }

  const returnTo = verified.payload.return_to || "/admin/connectors";
  const success = new URL(returnTo, url.origin);
  success.searchParams.set("oauth_connected", providerName);
  return NextResponse.redirect(success);
}
