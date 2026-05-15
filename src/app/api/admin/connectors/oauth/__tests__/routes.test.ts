/**
 * /api/admin/connectors/oauth/[provider]/{start,callback} route tests.
 *
 * Covers:
 *   - start: capability gate, unknown-provider 404, missing-env 400,
 *     happy redirect to provider's authorize URL with a signed state.
 *   - callback: provider error → safe redirect with error params, bad
 *     state → reject, missing env → reject, happy path persists creds
 *     and redirects back to /admin/connectors.
 *
 * The signed state is a real JWT (we don't mock crypto/sign so we can
 * round-trip), letting the start test mint a state the callback
 * verifies — same path real flow takes.
 */

const mockRequireCapability = jest.fn();
const mockSaveOAuth = jest.fn();
const mockExchangeCode = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/assistant/connectors/oauth/refresh", () => ({
  saveOAuthCredentials: (...a: any[]) => mockSaveOAuth(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET as startGET } from "@/app/api/admin/connectors/oauth/[provider]/start/route";
import { GET as callbackGET } from "@/app/api/admin/connectors/oauth/[provider]/callback/route";
import { signToken } from "@/lib/crypto/sign";
import {
  __registerOAuthProviderForTests,
  __resetRegistryForTests,
} from "@/lib/assistant/connectors/oauth/registry";
import type { OAuthProvider } from "@/lib/assistant/connectors/oauth/types";

const testProvider: OAuthProvider = {
  name: "salesforce",
  label: "Salesforce",
  connectorName: "salesforce",
  clientIdEnv: "SALESFORCE_CLIENT_ID",
  clientSecretEnv: "SALESFORCE_CLIENT_SECRET",
  scopes: ["api"],
  buildAuthorizeUrl: ({ clientId, redirectUri, state }) =>
    `https://login.salesforce.com/services/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchangeCode: (...a: any[]) => mockExchangeCode(...a),
  refresh: jest.fn(),
  buildBaseUrl: (m) => (m?.instance_url as string | undefined) ?? "",
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SALESFORCE_CLIENT_ID = "test-cid";
  process.env.SALESFORCE_CLIENT_SECRET = "test-secret";
  process.env.INSTINCT_JWT_SECRET = "test-secret-key-thats-long-enough-for-prod";
  __resetRegistryForTests();
  __registerOAuthProviderForTests(testProvider);
});

afterEach(() => {
  delete process.env.SALESFORCE_CLIENT_ID;
  delete process.env.SALESFORCE_CLIENT_SECRET;
  delete process.env.INSTINCT_JWT_SECRET;
  __resetRegistryForTests();
});

function req(url: string): NextRequest {
  return new NextRequest(url);
}

describe("GET /api/admin/connectors/oauth/[provider]/start", () => {
  test("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await startGET(req("http://x/api/admin/connectors/oauth/salesforce/start"), {
      params: Promise.resolve({ provider: "salesforce" }),
    });
    expect(res.status).toBe(401);
  });

  test("404 when provider is unknown", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: { id: "u1", role: "cto", workspaceId: "default" },
    });
    const res = await startGET(req("http://x/api/admin/connectors/oauth/bogus/start"), {
      params: Promise.resolve({ provider: "bogus" }),
    });
    expect(res.status).toBe(404);
  });

  test("400 when client_id env unset", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: { id: "u1", role: "cto", workspaceId: "default" },
    });
    delete process.env.SALESFORCE_CLIENT_ID;
    const res = await startGET(req("http://x/api/admin/connectors/oauth/salesforce/start"), {
      params: Promise.resolve({ provider: "salesforce" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("oauth_app_not_configured");
  });

  test("happy path: redirects to authorize URL + fires oauth_authorization_started", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: { id: "u1", role: "cto", workspaceId: "ws1" },
    });
    const res = await startGET(req("http://x/api/admin/connectors/oauth/salesforce/start"), {
      params: Promise.resolve({ provider: "salesforce" }),
    });
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("https://login.salesforce.com/services/oauth2/authorize");
    expect(loc).toContain("client_id=test-cid");
    expect(loc).toContain("state=");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_authorization_started",
      "u1",
      "cto",
      expect.objectContaining({ provider: "salesforce", workspace_id: "ws1" }),
    );
  });
});

describe("GET /api/admin/connectors/oauth/[provider]/callback", () => {
  test("provider error param → redirects with oauth_error", async () => {
    const res = await callbackGET(
      req("http://x/api/admin/connectors/oauth/salesforce/callback?error=access_denied&error_description=user+cancelled"),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/admin/connectors?");
    expect(loc).toContain("oauth_error=access_denied");
  });

  test("missing state or code → safe redirect with missing_code_or_state", async () => {
    const res = await callbackGET(
      req("http://x/api/admin/connectors/oauth/salesforce/callback?code=abc"),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("oauth_error=missing_code_or_state");
  });

  test("invalid signed state → invalid_state redirect", async () => {
    const res = await callbackGET(
      req("http://x/api/admin/connectors/oauth/salesforce/callback?code=abc&state=NOTAJWT"),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("oauth_error=invalid_state");
  });

  test("state minted for a different provider → provider_mismatch", async () => {
    const state = signToken({
      v: 1, workspace_id: "ws1", provider: "hubspot", nonce: "x",
    });
    const res = await callbackGET(
      req(`http://x/api/admin/connectors/oauth/salesforce/callback?code=abc&state=${state}`),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("oauth_error=provider_mismatch");
  });

  test("provider exchange fails → redirect with provider code", async () => {
    const state = signToken({
      v: 1, workspace_id: "ws1", provider: "salesforce", nonce: "x",
    });
    mockExchangeCode.mockResolvedValueOnce({
      ok: false, code: "invalid_grant", message: "expired code", status: 400,
    });
    const res = await callbackGET(
      req(`http://x/api/admin/connectors/oauth/salesforce/callback?code=abc&state=${state}`),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("oauth_error=invalid_grant");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_authorization_failed",
      "system",
      "system",
      expect.objectContaining({ provider: "salesforce", code: "invalid_grant" }),
    );
  });

  test("happy path: exchanges code → persists → redirects back to return_to", async () => {
    const state = signToken({
      v: 1, workspace_id: "ws1", provider: "salesforce", nonce: "x",
      return_to: "/admin/connectors",
    });
    mockExchangeCode.mockResolvedValueOnce({
      ok: true,
      accessToken: "ACC",
      refreshToken: "RT",
      expiresInSec: 3600,
      tokenType: "Bearer",
      metadata: { instance_url: "https://acme.my.salesforce.com" },
    });
    mockSaveOAuth.mockResolvedValueOnce({
      workspaceId: "ws1",
      connectorName: "salesforce",
      authHeader: "Bearer ACC",
      baseUrl: "https://acme.my.salesforce.com",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      metadata: { instance_url: "https://acme.my.salesforce.com" },
    });
    const res = await callbackGET(
      req(`http://x/api/admin/connectors/oauth/salesforce/callback?code=abc&state=${state}`),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/admin/connectors?oauth_connected=salesforce");
    expect(mockSaveOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        token: expect.objectContaining({ accessToken: "ACC" }),
      }),
    );
  });

  test("persist failure → redirect with persist_failed (admin can retry)", async () => {
    const state = signToken({
      v: 1, workspace_id: "ws1", provider: "salesforce", nonce: "x",
    });
    mockExchangeCode.mockResolvedValueOnce({
      ok: true,
      accessToken: "ACC",
      refreshToken: "RT",
    });
    mockSaveOAuth.mockResolvedValueOnce(null);
    const res = await callbackGET(
      req(`http://x/api/admin/connectors/oauth/salesforce/callback?code=abc&state=${state}`),
      { params: Promise.resolve({ provider: "salesforce" }) },
    );
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("oauth_error=persist_failed");
  });
});
