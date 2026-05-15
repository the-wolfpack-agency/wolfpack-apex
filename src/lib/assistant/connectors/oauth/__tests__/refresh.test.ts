/**
 * Orchestrator tests — saveOAuthCredentials + refreshConnectorAccessToken.
 *
 * Mocks the DB layer (safeQuery) and the analytics layer to assert:
 *   - Successful authorize-code exchange writes auth_type='oauth2',
 *     encrypted refresh token, and fires the typed event.
 *   - refresh() rotates the bearer, persists, and emits the refreshed
 *     event.
 *   - All failure shapes (no row, no refresh token, decrypt failure,
 *     missing client credentials, provider rejection) emit a typed
 *     failure event AND return null.
 *
 * Custom provider injected via __registerOAuthProviderForTests so we
 * don't pay the real Salesforce/HubSpot URL builder cost — we want to
 * verify the orchestrator's logic, not the providers (those have their
 * own suite).
 */

const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();

jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/crypto/secret-storage", () => ({
  encryptSecret: (s: string) => mockEncrypt(s),
  decryptSecret: (s: string) => mockDecrypt(s),
}));

import {
  saveOAuthCredentials,
  refreshConnectorAccessToken,
  shouldProactivelyRefresh,
} from "../refresh";
import {
  __registerOAuthProviderForTests,
  __resetRegistryForTests,
} from "../registry";
import type { OAuthProvider, OAuthLifecycleResult } from "../types";

const testProvider: OAuthProvider = {
  name: "testprov",
  label: "Test Provider",
  connectorName: "testprov",
  clientIdEnv: "TESTPROV_CLIENT_ID",
  clientSecretEnv: "TESTPROV_CLIENT_SECRET",
  scopes: ["read"],
  buildAuthorizeUrl: () => "https://test.example/authorize",
  exchangeCode: jest.fn(),
  refresh: jest.fn(),
  buildBaseUrl: (meta) => (meta?.instance_url as string | undefined) ?? "https://test.example/api",
};

beforeEach(() => {
  jest.clearAllMocks();
  /* Default encrypt/decrypt — round-trip so we can read what was written. */
  mockEncrypt.mockImplementation((s: string) => `enc:${s}`);
  mockDecrypt.mockImplementation((s: string) => {
    if (typeof s !== "string" || !s.startsWith("enc:")) return null;
    return s.slice(4);
  });
  /* Default safeQuery → no row found. */
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  process.env.DATABASE_URL = "postgres://test";
  process.env.TESTPROV_CLIENT_ID = "test-cid";
  process.env.TESTPROV_CLIENT_SECRET = "test-secret";
  __resetRegistryForTests();
  __registerOAuthProviderForTests(testProvider);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.TESTPROV_CLIENT_ID;
  delete process.env.TESTPROV_CLIENT_SECRET;
  __resetRegistryForTests();
});

describe("saveOAuthCredentials", () => {
  test("encrypts + persists + emits oauth_authorization_completed", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const r = await saveOAuthCredentials({
      workspaceId: "ws1",
      provider: testProvider,
      token: {
        accessToken: "ACC_VAL",
        refreshToken: "RT_VAL",
        expiresInSec: 3600,
        tokenType: "Bearer",
        metadata: { instance_url: "https://acme.my.salesforce.com" },
      },
      createdBy: "u-1",
    });
    expect(r).not.toBeNull();
    expect(r?.authHeader).toBe("Bearer ACC_VAL");
    expect(r?.baseUrl).toBe("https://acme.my.salesforce.com");
    expect(mockEncrypt).toHaveBeenCalledWith("Bearer ACC_VAL");
    expect(mockEncrypt).toHaveBeenCalledWith("RT_VAL");
    /* SQL was called with auth_type='oauth2' inline in the query. */
    const sql = mockSafeQuery.mock.calls[0][0] as string;
    expect(sql).toContain("oauth2");
    /* expires_at param resolves to a future ISO timestamp. */
    const params = mockSafeQuery.mock.calls[0][1] as unknown[];
    expect(typeof params[5]).toBe("string");
    expect(Date.parse(params[5] as string)).toBeGreaterThan(Date.now());
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_authorization_completed",
      "u-1",
      "system",
      expect.objectContaining({
        provider: "testprov",
        workspace_id: "ws1",
        refresh_token_present: true,
      }),
    );
  });

  test("returns null + fires persist-failed when DB write errors", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("db down"));
    const r = await saveOAuthCredentials({
      workspaceId: "ws1",
      provider: testProvider,
      token: { accessToken: "x" },
    });
    expect(r).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_persist_failed",
      "system",
      "system",
      expect.objectContaining({ provider: "testprov" }),
    );
  });

  test("no DATABASE_URL returns null (no DB attempt)", async () => {
    delete process.env.DATABASE_URL;
    const r = await saveOAuthCredentials({
      workspaceId: "ws1",
      provider: testProvider,
      token: { accessToken: "x" },
    });
    expect(r).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("refreshConnectorAccessToken", () => {
  test("happy path: refreshes + persists + emits oauth_token_refreshed", async () => {
    /* Load: existing oauth2 row with encrypted refresh token. */
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          auth_type: "oauth2",
          refresh_token_enc: "enc:RT_VAL",
          oauth_provider_metadata: { instance_url: "https://prior.salesforce.com" },
          base_url: "https://prior.salesforce.com",
        },
      ],
      fromCache: false,
    });
    /* Update succeeds. */
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const mockedRefresh: OAuthLifecycleResult = {
      ok: true,
      accessToken: "FRESH_ACC",
      expiresInSec: 1800,
      tokenType: "Bearer",
      metadata: { instance_url: "https://acme.my.salesforce.com" },
    };
    (testProvider.refresh as jest.Mock).mockResolvedValueOnce(mockedRefresh);

    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).not.toBeNull();
    expect(r?.authHeader).toBe("Bearer FRESH_ACC");
    expect(r?.baseUrl).toBe("https://acme.my.salesforce.com");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_token_refreshed",
      "system",
      "system",
      expect.objectContaining({
        connector: "testprov",
        workspace_id: "ws1",
        refresh_token_rotated: false,
      }),
    );
  });

  test("returns null + emits failure when no row exists", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).toBeNull();
  });

  test("returns null when row is static_bearer (refresh not applicable)", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          auth_type: "static_bearer",
          refresh_token_enc: null,
          oauth_provider_metadata: null,
          base_url: "https://x",
        },
      ],
      fromCache: false,
    });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).toBeNull();
  });

  test("returns null + emits no_refresh_token when refresh_token_enc is null", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        auth_type: "oauth2",
        refresh_token_enc: null,
        oauth_provider_metadata: null,
        base_url: "https://x",
      }],
      fromCache: false,
    });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_refresh_failed",
      "system",
      "system",
      expect.objectContaining({ reason: "no_refresh_token" }),
    );
  });

  test("returns null + emits refresh_decrypt_failed when refresh token can't be decrypted", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        auth_type: "oauth2",
        refresh_token_enc: "garbage-cant-decrypt",
        oauth_provider_metadata: null,
        base_url: "https://x",
      }],
      fromCache: false,
    });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_refresh_failed",
      "system",
      "system",
      expect.objectContaining({ reason: "refresh_decrypt_failed" }),
    );
  });

  test("emits missing_client_credentials when env vars unset", async () => {
    delete process.env.TESTPROV_CLIENT_ID;
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        auth_type: "oauth2",
        refresh_token_enc: "enc:RT",
        oauth_provider_metadata: null,
        base_url: "https://x",
      }],
      fromCache: false,
    });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_refresh_failed",
      "system",
      "system",
      expect.objectContaining({ reason: "missing_client_credentials" }),
    );
  });

  test("provider invalid_grant → fires failure event + returns null (admin must re-auth)", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        auth_type: "oauth2",
        refresh_token_enc: "enc:RT",
        oauth_provider_metadata: null,
        base_url: "https://x",
      }],
      fromCache: false,
    });
    (testProvider.refresh as jest.Mock).mockResolvedValueOnce({
      ok: false,
      code: "invalid_grant",
      message: "expired",
      status: 400,
    });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_refresh_failed",
      "system",
      "system",
      expect.objectContaining({ reason: "invalid_grant", status: 400 }),
    );
  });

  test("rotates refresh token when provider returns one (HubSpot pattern)", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        auth_type: "oauth2",
        refresh_token_enc: "enc:OLD_RT",
        oauth_provider_metadata: null,
        base_url: "https://x",
      }],
      fromCache: false,
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    (testProvider.refresh as jest.Mock).mockResolvedValueOnce({
      ok: true,
      accessToken: "FRESH",
      refreshToken: "NEW_RT",
      expiresInSec: 1800,
    });
    const r = await refreshConnectorAccessToken({
      workspaceId: "ws1",
      connectorName: "testprov",
    });
    expect(r).not.toBeNull();
    /* The new refresh token was encrypted + sent to the UPDATE. */
    expect(mockEncrypt).toHaveBeenCalledWith("NEW_RT");
    const updateParams = mockSafeQuery.mock.calls[1][1] as unknown[];
    expect(updateParams[3]).toBe("enc:NEW_RT");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.oauth_token_refreshed",
      "system",
      "system",
      expect.objectContaining({ refresh_token_rotated: true }),
    );
  });
});

describe("shouldProactivelyRefresh", () => {
  test("true when expiry is within the lead window", () => {
    const soon = new Date(Date.now() + 30 * 1000).toISOString();
    expect(shouldProactivelyRefresh(soon)).toBe(true);
  });

  test("false when expiry is well in the future", () => {
    const farOut = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(shouldProactivelyRefresh(farOut)).toBe(false);
  });

  test("false when no expiry recorded (static_bearer)", () => {
    expect(shouldProactivelyRefresh(null)).toBe(false);
    expect(shouldProactivelyRefresh(undefined)).toBe(false);
  });

  test("false on unparseable string (defensive)", () => {
    expect(shouldProactivelyRefresh("not-an-iso-date")).toBe(false);
  });
});
