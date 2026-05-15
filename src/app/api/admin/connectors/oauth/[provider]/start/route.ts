/**
 * GET /api/admin/connectors/oauth/[provider]/start
 *
 * Generic OAuth authorize kick-off for any provider in the registry
 * (salesforce, hubspot, future: qbo, jira, github, …). Signs a short-
 * lived state token tying the flow to (workspace, provider, nonce) so
 * the /callback route can verify the response wasn't tampered with or
 * replayed.
 *
 * Auth: settings.manage_team capability — same gate as the static
 * credentials route. workspace_id comes from the session, never the
 * request body / query string (mirrors the connectors POST contract).
 *
 * The route never sees the client_secret — only verifies the env var
 * is set so the flow can complete. Missing client_id/secret returns
 * 400 with a concrete fix.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { signToken } from "@/lib/crypto/sign";
import { getOAuthProvider } from "@/lib/assistant/connectors/oauth/registry";

interface OAuthStateClaims {
  v: 1;
  workspace_id: string;
  provider: string;
  /** Random nonce so two parallel authorize flows for the same workspace+provider
   *  don't share state. */
  nonce: string;
  /** Where to send the user after the callback completes. */
  return_to?: string;
}

const STATE_TTL_SECONDS = 10 * 60; // 10 minutes

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { provider: providerName } = await context.params;
  const provider = getOAuthProvider(providerName);
  if (!provider) {
    return NextResponse.json(
      { error: `unknown OAuth provider "${providerName}"` },
      { status: 404 },
    );
  }

  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    /* Don't proceed when the OAuth app isn't configured — the
       provider would 400 us back anyway. Return a clear error the
       admin UI can render. */
    return NextResponse.json(
      {
        error: "oauth_app_not_configured",
        message: `Set ${provider.clientIdEnv} and ${provider.clientSecretEnv} on the server before starting the flow.`,
      },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const returnTo = url.searchParams.get("return_to") || "/admin/connectors";
  const redirectUri = `${url.origin}/api/admin/connectors/oauth/${providerName}/callback`;

  /* Sign the state token. The callback re-verifies; if the signature
     or expiry fails, the OAuth flow is rejected. */
  const stateClaims: OAuthStateClaims = {
    v: 1,
    workspace_id: auth.user.workspaceId,
    provider: providerName,
    nonce: Math.random().toString(36).slice(2),
    return_to: returnTo,
  };
  const state = signToken(stateClaims, { ttlSeconds: STATE_TTL_SECONDS });

  const authorizeUrl = provider.buildAuthorizeUrl({
    clientId,
    redirectUri,
    state,
  });

  trackEvent("assistant.oauth_authorization_started", auth.user.id, auth.user.role, {
    provider: providerName,
    workspace_id: auth.user.workspaceId,
  });

  return NextResponse.redirect(authorizeUrl);
}
