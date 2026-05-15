/**
 * OAuth provider unit tests — Salesforce + HubSpot URL builders +
 * token-response parsing + error classification.
 *
 * Pure-function tests: no network, no DB. Each provider exposes
 * buildAuthorizeUrl (pure) and exchangeCode/refresh (network — we
 * stub fetch). Asserting both shape + failure classification because
 * those are the two things that break silently when a provider
 * changes their API.
 */

import { salesforceProvider } from "../providers/salesforce";
import { hubspotProvider } from "../providers/hubspot";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("salesforceProvider.buildAuthorizeUrl", () => {
  test("includes response_type, client_id, redirect_uri, scope, state, prompt", () => {
    const url = salesforceProvider.buildAuthorizeUrl({
      clientId: "CLIENT123",
      redirectUri: "https://app.example/cb",
      state: "STATE_TOKEN",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://login.salesforce.com/services/oauth2/authorize",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("CLIENT123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(parsed.searchParams.get("state")).toBe("STATE_TOKEN");
    expect(parsed.searchParams.get("scope")).toContain("api");
    expect(parsed.searchParams.get("scope")).toContain("refresh_token");
    expect(parsed.searchParams.get("prompt")).toBe("login");
  });

  test("respects SALESFORCE_AUTH_HOST override (sandbox)", () => {
    process.env.SALESFORCE_AUTH_HOST = "https://test.salesforce.com";
    const url = salesforceProvider.buildAuthorizeUrl({
      clientId: "x",
      redirectUri: "https://x/cb",
      state: "s",
    });
    expect(url.startsWith("https://test.salesforce.com/services/oauth2/authorize")).toBe(true);
    delete process.env.SALESFORCE_AUTH_HOST;
  });
});

describe("salesforceProvider.exchangeCode", () => {
  test("happy path returns access + refresh + instance_url metadata", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "ACC_TOKEN",
        refresh_token: "REFRESH_TOKEN",
        instance_url: "https://acme.my.salesforce.com",
        id: "https://login.salesforce.com/id/00Dxxx/005xxx",
        token_type: "Bearer",
        scope: "api refresh_token",
      }),
    );
    const r = await salesforceProvider.exchangeCode({
      clientId: "c",
      clientSecret: "s",
      code: "AUTHCODE",
      redirectUri: "https://cb",
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accessToken).toBe("ACC_TOKEN");
    expect(r.refreshToken).toBe("REFRESH_TOKEN");
    expect(r.tokenType).toBe("Bearer");
    expect(r.metadata?.instance_url).toBe("https://acme.my.salesforce.com");
    /* The form body was sent x-www-form-urlencoded with grant_type=authorization_code. */
    const sentBody = fetchImpl.mock.calls[0][1].body as string;
    expect(sentBody).toContain("grant_type=authorization_code");
    expect(sentBody).toContain("code=AUTHCODE");
    expect(sentBody).toContain("client_id=c");
  });

  test("400 invalid_grant maps to OAuthTokenError.code=invalid_grant", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(400, { error: "invalid_grant", error_description: "expired authorization code" }),
    );
    const r = await salesforceProvider.exchangeCode({
      clientId: "c", clientSecret: "s", code: "x", redirectUri: "x", fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_grant");
    expect(r.status).toBe(400);
  });

  test("400 invalid_client maps to invalid_client", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(400, { error: "invalid_client_id" }),
    );
    const r = await salesforceProvider.exchangeCode({
      clientId: "c", clientSecret: "bad", code: "x", redirectUri: "x", fetchImpl,
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_client");
  });

  test("network failure → code=network, no status", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await salesforceProvider.exchangeCode({
      clientId: "c", clientSecret: "s", code: "x", redirectUri: "x", fetchImpl,
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("network");
    expect(r.status).toBeUndefined();
  });

  test("non-JSON success body → validation error", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response("not json", { status: 200 }),
    );
    const r = await salesforceProvider.exchangeCode({
      clientId: "c", clientSecret: "s", code: "x", redirectUri: "x", fetchImpl,
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("remote_error");
  });
});

describe("salesforceProvider.refresh", () => {
  test("sends grant_type=refresh_token + refresh_token in body", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "FRESH",
        instance_url: "https://acme.my.salesforce.com",
        token_type: "Bearer",
      }),
    );
    await salesforceProvider.refresh({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "RT_VALUE",
      fetchImpl,
    });
    const body = fetchImpl.mock.calls[0][1].body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=RT_VALUE");
  });

  test("refresh response without new refresh_token still ok (SF keeps prior RT)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "FRESH",
        instance_url: "https://acme.my.salesforce.com",
        token_type: "Bearer",
      }),
    );
    const r = await salesforceProvider.refresh({
      clientId: "c", clientSecret: "s", refreshToken: "x", fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refreshToken).toBeUndefined();
  });
});

describe("salesforceProvider.buildBaseUrl", () => {
  test("returns instance_url stripped of trailing slash", () => {
    expect(
      salesforceProvider.buildBaseUrl({ instance_url: "https://acme.my.salesforce.com/" }),
    ).toBe("https://acme.my.salesforce.com");
  });

  test("returns empty string when instance_url missing (caller must catch)", () => {
    expect(salesforceProvider.buildBaseUrl({})).toBe("");
    expect(salesforceProvider.buildBaseUrl(null)).toBe("");
  });
});

describe("hubspotProvider.buildAuthorizeUrl", () => {
  test("includes client_id, redirect_uri, scope, state", () => {
    const url = hubspotProvider.buildAuthorizeUrl({
      clientId: "CLIENT_HS",
      redirectUri: "https://app.example/cb",
      state: "STATE",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("CLIENT_HS");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(parsed.searchParams.get("state")).toBe("STATE");
    expect(parsed.searchParams.get("scope")).toContain("crm.objects.contacts.read");
  });
});

describe("hubspotProvider.exchangeCode", () => {
  test("captures hub_id + user_id in metadata", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "ACC",
        refresh_token: "RT",
        expires_in: 1800,
        token_type: "bearer",
        hub_id: 12345,
        user_id: 999,
      }),
    );
    const r = await hubspotProvider.exchangeCode({
      clientId: "c", clientSecret: "s", code: "X", redirectUri: "x", fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expiresInSec).toBe(1800);
    expect(r.metadata?.hub_id).toBe(12345);
    expect(r.metadata?.user_id).toBe(999);
  });

  test("BAD_REFRESH_TOKEN maps to invalid_grant", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(401, { status: "BAD_REFRESH_TOKEN", message: "expired" }),
    );
    const r = await hubspotProvider.refresh({
      clientId: "c", clientSecret: "s", refreshToken: "rt", fetchImpl,
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_grant");
  });

  test("INVALID_CLIENT maps to invalid_client", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(401, { status: "INVALID_CLIENT", message: "bad client" }),
    );
    const r = await hubspotProvider.exchangeCode({
      clientId: "c", clientSecret: "s", code: "x", redirectUri: "x", fetchImpl,
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_client");
  });
});

describe("hubspotProvider.buildBaseUrl", () => {
  test("always returns api.hubapi.com (no per-tenant instance)", () => {
    expect(hubspotProvider.buildBaseUrl({ hub_id: 123 })).toBe("https://api.hubapi.com");
    expect(hubspotProvider.buildBaseUrl(null)).toBe("https://api.hubapi.com");
  });
});
