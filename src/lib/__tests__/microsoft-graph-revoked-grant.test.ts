/**
 * A revoked Microsoft grant (AADSTS50173, surfaced as invalid_grant) is
 * permanent: the refresh token is dead. The hot path must (1) raise a distinct
 * MsGrantRevokedError so it is not confused with a transient failure, and
 * (2) clear the dead token so getConnectionStatus reads as DISCONNECTED and the
 * UI prompts a reconnect, instead of a stale "connected" banner over empty data.
 */

export {}; // module scope (avoid top-level name clashes with sibling test scripts)

const mockSecretResolver = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/secrets", () => ({
  getSecretOrThrow: (...args: unknown[]) => mockSecretResolver(...args),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
const mockNotify = jest.fn().mockResolvedValue({ id: "n1" });
jest.mock("@/lib/notifications/in-app", () => ({ notify: (...a: unknown[]) => mockNotify(...a) }));
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

const REVOKED_BODY =
  '{"error":"invalid_grant","error_description":"AADSTS50173: The provided grant has expired due to it being revoked, a fresh auth token is needed."}';

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.DATABASE_URL = "postgres://test";
  // isShadowMode() is `!MS_CLIENT_ID`; set it so getValidToken runs the real path
  // (the credentials themselves still resolve through the mocked secrets layer).
  process.env.MS_CLIENT_ID = "id";
  // Permissive: resolve every requested secret so getMsClientCreds succeeds.
  mockSecretResolver.mockImplementation(async (name: string) => {
    if (name === "microsoft-client-id") return "id";
    if (name === "microsoft-client-secret") return "secret";
    return "x";
  });
});

test("refreshAccessToken throws MsGrantRevokedError on invalid_grant", async () => {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 400,
    text: async () => REVOKED_BODY,
  });
  const ms = await import("@/lib/microsoft-graph");
  ms._resetMsCredsCache();
  await expect(ms.refreshAccessToken("dead-refresh")).rejects.toBeInstanceOf(ms.MsGrantRevokedError);
});

test("refreshAccessToken returns null (not revoked) on a transient failure", async () => {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 503,
    text: async () => "service unavailable",
  });
  const ms = await import("@/lib/microsoft-graph");
  ms._resetMsCredsCache();
  await expect(ms.refreshAccessToken("rt")).resolves.toBeNull();
});

test("getValidToken clears the dead token on a revoked grant and returns null", async () => {
  // Stored token is expired so the refresh path runs.
  mockSafeQuery.mockResolvedValue({
    rows: [
      {
        access_token: "old",
        refresh_token: "dead-refresh",
        user_email: "nick@wolfpack.dev",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        connected_by: "user-1",
      },
    ],
  });
  mockQuery.mockResolvedValue({ rows: [] });
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 400,
    text: async () => REVOKED_BODY,
  });

  const ms = await import("@/lib/microsoft-graph");
  ms._resetMsCredsCache();
  const result = await ms.getValidToken("user-1");

  expect(result).toBeNull();
  // The dead grant was cleared (deleteTokens -> DELETE FROM instinct_ms_tokens).
  const deleteCall = mockQuery.mock.calls.find((c) => /DELETE FROM instinct_ms_tokens/.test(String(c[0])));
  expect(deleteCall).toBeDefined();
  expect(deleteCall?.[1]).toEqual(["user-1"]);
  // The user is INFORMED: a deduped high-priority reconnect notification fires.
  expect(mockNotify).toHaveBeenCalledTimes(1);
  const n = mockNotify.mock.calls[0][0];
  expect(n).toEqual(
    expect.objectContaining({
      userId: "user-1",
      source: "microsoft",
      sourceId: "ms_grant_revoked",
      priority: "high",
      dedup: true,
      actionUrl: "/settings",
    }),
  );
});
