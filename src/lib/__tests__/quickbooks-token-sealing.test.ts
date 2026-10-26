/** @jest-environment node */
/**
 * QuickBooks tokens are sealed at rest (storeTokens) and opened on read
 * (getValidToken), the same way as the Microsoft Graph tokens: rows not sealed
 * rows still read and are re-sealed lazily on their first read, a tampered or
 * wrong-key value is refused, and a write that cannot be sealed is refused
 * rather than stored readably. Drives the real quickbooks.ts against a
 * mocked database so the SQL parameters can be inspected.
 */
export {};

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  pool: { query: jest.fn() },
  activePool: () => ({ query: jest.fn() }),
}));

import { storeTokens, getValidToken } from "@/lib/quickbooks";
import { sealStoredToken, isSealedToken, openStoredToken } from "@/lib/crypto/graph-token-storage";
import * as secretStorage from "@/lib/crypto/secret-storage";

const ACCESS = "eyJlbmMiOiJBMTI4Q0JDLUhTMjU2In0.qbo-live-access.sig";
const REFRESH = "AB11qbo-live-refresh-token";
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const PAST = () => new Date(Date.now() - 60_000).toISOString();

function tokens(over: Partial<Record<string, string>> = {}) {
  return { access_token: ACCESS, refresh_token: REFRESH, realm_id: "realm-1", expires_at: FUTURE(), ...over };
}

function row(access: string, refresh: string, expires = FUTURE()) {
  return { id: "row-1", access_token: access, refresh_token: refresh, realm_id: "realm-1", expires_at: expires, connected_by: "u1" };
}

function allParams(): unknown[] {
  return mockQuery.mock.calls.flatMap((c) => (c[1] as unknown[]) ?? []);
}

const SAVED = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  process.env.QBO_CLIENT_ID = "id";
  process.env.QBO_CLIENT_SECRET = "secret";
  process.env.INSTINCT_SECRET_KEY = "d".repeat(64);
  secretStorage.__resetSecretKeyCacheForTests();
});

afterAll(() => {
  process.env = SAVED;
  secretStorage.__resetSecretKeyCacheForTests();
});

describe("storeTokens writes sealed tokens only", () => {
  it("never passes a bare token to the database, and the sealed values round-trip", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(storeTokens(tokens(), "u1", "Acme")).resolves.toBe(true);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(ACCESS);
    expect(params).not.toContain(REFRESH);
    expect(JSON.stringify(params)).not.toContain("qbo-live");
    expect(isSealedToken(params[1] as string)).toBe(true);
    expect(isSealedToken(params[2] as string)).toBe(true);
    expect(openStoredToken(params[1] as string)).toEqual({ ok: true, value: ACCESS, format: "sealed" });
    expect(openStoredToken(params[2] as string)).toEqual({ ok: true, value: REFRESH, format: "sealed" });
    // Sealed under the primary key: the value carries its key id.
    expect((params[1] as string).startsWith("v1.k")).toBe(true);
  });

  it("refuses to store (false, seal_failed) when the cipher cannot produce a sealed value", async () => {
    /* encryptSecret's degraded fallback is a readable "plain." envelope. For an
       OAuth token that is readable, so the store must be refused instead. */
    jest.spyOn(secretStorage, "encryptSecret").mockImplementation((p: string) => `plain.${Buffer.from(p).toString("base64")}`);
    await expect(storeTokens(tokens(), "u1")).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("quickbooks.token_store_failed", "u1", "system", expect.objectContaining({ code: "seal_failed" }));
  });

  it("refuses to store an empty token", async () => {
    await expect(storeTokens(tokens({ refresh_token: "" }), "u1")).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("with no INSTINCT_SECRET_KEY the keyring's legacy key still seals; nothing is written readably", async () => {
    delete process.env.INSTINCT_SECRET_KEY;
    secretStorage.__resetSecretKeyCacheForTests();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(storeTokens(tokens(), "u1")).resolves.toBe(true);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(ACCESS);
    expect(isSealedToken(params[1] as string)).toBe(true);
    expect(openStoredToken(params[1] as string)).toMatchObject({ value: ACCESS });
  });

  it("reports a database failure as a failed store", async () => {
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    await expect(storeTokens(tokens(), "u1")).resolves.toBe(false);
    expect(mockTrack).toHaveBeenCalledWith("quickbooks.token_store_failed", "u1", "system", expect.objectContaining({ code: "db_error" }));
  });
});

describe("getValidToken opens both formats", () => {
  it("opens a sealed row without rewriting it", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(sealStoredToken(ACCESS), sealStoredToken(REFRESH))] });
    await expect(getValidToken()).resolves.toEqual({ accessToken: ACCESS, realmId: "realm-1" });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalledWith("security.qbo_token_encrypted", expect.anything(), expect.anything(), expect.anything());
  });

  it("still reads a row not sealed yet, then seals it in place and records it once", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(ACCESS, REFRESH)] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(getValidToken()).resolves.toEqual({ accessToken: ACCESS, realmId: "realm-1" });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE instinct_qbo_tokens/);
    expect(sql).toMatch(/access_token = \$4 AND refresh_token = \$5/);
    expect(sql).not.toMatch(/updated_at/);
    expect(isSealedToken(params[0] as string)).toBe(true);
    expect(isSealedToken(params[1] as string)).toBe(true);
    expect(params.slice(2)).toEqual(["row-1", ACCESS, REFRESH]);
    const encrypted = mockTrack.mock.calls.filter((c) => c[0] === "security.qbo_token_encrypted");
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0][3]).toEqual({ realm_id: "realm-1", source: "lazy_read" });
  });

  it("does not record a migration when a concurrent write already replaced the row", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(ACCESS, REFRESH)] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getValidToken();
    expect(mockTrack).not.toHaveBeenCalledWith("security.qbo_token_encrypted", expect.anything(), expect.anything(), expect.anything());
  });

  it("a failed backfill never fails the read", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(ACCESS, REFRESH)] });
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    await expect(getValidToken()).resolves.toEqual({ accessToken: ACCESS, realmId: "realm-1" });
  });

  it("treats a tampered sealed token as unavailable, reports it, and leaves the row alone", async () => {
    const parts = sealStoredToken(REFRESH).split(".");
    const ct = Buffer.from(parts[4], "base64");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64");
    mockSafeQuery.mockResolvedValue({ rows: [row(sealStoredToken(ACCESS), parts.join("."))] });
    await expect(getValidToken()).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("security.qbo_token_decrypt_failed", "u1", "system", { realm_id: "realm-1", field: "refresh_token" });
  });

  it("a value sealed under a key this deployment does not hold is refused, not treated as unsealed", async () => {
    const foreign = sealStoredToken(ACCESS);
    process.env.INSTINCT_SECRET_KEY = "e".repeat(64);
    process.env.INSTINCT_JWT_SECRET = "a-different-jwt-secret-for-this-test-only";
    secretStorage.__resetSecretKeyCacheForTests();
    mockSafeQuery.mockResolvedValue({ rows: [row(foreign, REFRESH)] });
    await expect(getValidToken()).resolves.toBeNull();
    delete process.env.INSTINCT_JWT_SECRET;
  });

  it("refreshes an expired legacy row with the opened refresh token and stores the result sealed", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row("old-access", REFRESH, PAST())] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
      text: async () => "",
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    await expect(getValidToken()).resolves.toEqual({ accessToken: "new-access", realmId: "realm-1" });
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(`refresh_token=${REFRESH}`);
    expect(allParams()).not.toContain("new-access");
    expect(allParams()).not.toContain("new-refresh");
    const encrypted = mockTrack.mock.calls.filter((c) => c[0] === "security.qbo_token_encrypted");
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0][3]).toEqual({ realm_id: "realm-1", source: "refresh_write" });
  });

  it("refreshes a sealed expired row using the opened (not the sealed) refresh token", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(sealStoredToken("old-access"), sealStoredToken(REFRESH), PAST())] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
      text: async () => "",
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    await getValidToken();
    const body = String(fetchMock.mock.calls[0][1]?.body);
    expect(body).toContain(`refresh_token=${REFRESH}`);
    expect(body).not.toContain("v1.");
    expect(mockTrack).not.toHaveBeenCalledWith("security.qbo_token_encrypted", expect.anything(), expect.anything(), expect.anything());
  });
});
