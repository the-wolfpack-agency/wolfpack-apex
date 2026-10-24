/** @jest-environment node */
/**
 * Microsoft Graph tokens are sealed at rest (storeTokens) and opened on read
 * (getValidToken), with legacy plaintext rows still readable and re-sealed
 * lazily on their first read. These tests drive the real microsoft-graph.ts
 * with a mocked database so the SQL parameters can be inspected: the property
 * that matters is that no plaintext token is ever handed to the database.
 */
export {};

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/secrets", () => ({
  getSecretOrThrow: async (name: string) =>
    name === "microsoft-client-id" ? "id" : name === "microsoft-client-secret" ? "secret" : "x",
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/notifications/in-app", () => ({ notify: jest.fn().mockResolvedValue({ id: "n1" }) }));
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  pool: { query: jest.fn() },
  activePool: () => ({ query: jest.fn() }),
}));

import { storeTokens, getValidToken } from "@/lib/microsoft-graph";
import { sealGraphToken, isSealedToken, openGraphToken } from "@/lib/crypto/graph-token-storage";
import { __resetSecretKeyCacheForTests } from "@/lib/crypto/secret-storage";

const ACCESS = "eyJhbGciOiJSUzI1NiJ9.live-access-token.sig";
const REFRESH = "0.AXkA-live-refresh-token";
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const PAST = () => new Date(Date.now() - 60_000).toISOString();

function allParams(): unknown[] {
  return mockQuery.mock.calls.flatMap((c) => (c[1] as unknown[]) ?? []);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  process.env.MS_CLIENT_ID = "id";
  process.env.INSTINCT_SECRET_KEY = "c".repeat(64);
  __resetSecretKeyCacheForTests();
});

describe("storeTokens writes sealed tokens only", () => {
  it("never passes a plaintext token to the database", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const ok = await storeTokens(
      { access_token: ACCESS, refresh_token: REFRESH, expires_at: FUTURE(), user_email: "a@example.test" } as never,
      "u1",
      "a@example.test",
    );
    expect(ok).toBe(true);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(ACCESS);
    expect(params).not.toContain(REFRESH);
    expect(JSON.stringify(params)).not.toContain("live-access-token");
    expect(isSealedToken(params[2] as string)).toBe(true);
    expect(isSealedToken(params[3] as string)).toBe(true);
    expect(openGraphToken(params[2] as string)).toMatchObject({ value: ACCESS });
    expect(openGraphToken(params[3] as string)).toMatchObject({ value: REFRESH });
  });

  it("refuses to store (returns false, reports seal_failed) rather than write plaintext", async () => {
    const ok = await storeTokens(
      { access_token: "", refresh_token: REFRESH, expires_at: FUTURE(), user_email: "a@example.test" } as never,
      "u1",
      "a@example.test",
    );
    expect(ok).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "microsoft.token_store_failed",
      "u1",
      "system",
      expect.objectContaining({ code: "seal_failed" }),
    );
  });
});

describe("getValidToken opens both formats", () => {
  it("opens a sealed row without rewriting it", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          access_token: sealGraphToken(ACCESS),
          refresh_token: sealGraphToken(REFRESH),
          user_email: "a@example.test",
          expires_at: FUTURE(),
          connected_by: "u1",
        },
      ],
    });
    await expect(getValidToken("u1")).resolves.toEqual({ accessToken: ACCESS, userEmail: "a@example.test" });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalledWith("security.graph_token_encrypted", expect.anything(), expect.anything(), expect.anything());
  });

  it("reads a legacy plaintext row, then re-seals it in place and records it once", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ access_token: ACCESS, refresh_token: REFRESH, user_email: "a@example.test", expires_at: FUTURE(), connected_by: "u1" }],
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(getValidToken("u1")).resolves.toEqual({ accessToken: ACCESS, userEmail: "a@example.test" });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE instinct_ms_tokens/);
    // Optimistic guard: only rewrite while the row still holds what was read.
    expect(sql).toMatch(/access_token = \$4 AND refresh_token = \$5/);
    expect(isSealedToken(params[0] as string)).toBe(true);
    expect(isSealedToken(params[1] as string)).toBe(true);
    expect(params.slice(3)).toEqual([ACCESS, REFRESH]);
    const encrypted = mockTrack.mock.calls.filter((c) => c[0] === "security.graph_token_encrypted");
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0][3]).toMatchObject({ source: "lazy_read" });
  });

  it("does not record a migration when a concurrent write already replaced the row", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ access_token: ACCESS, refresh_token: REFRESH, user_email: "a@example.test", expires_at: FUTURE(), connected_by: "u1" }],
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getValidToken("u1");
    expect(mockTrack).not.toHaveBeenCalledWith("security.graph_token_encrypted", expect.anything(), expect.anything(), expect.anything());
  });

  it("a failed backfill never fails the read", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ access_token: ACCESS, refresh_token: REFRESH, user_email: "a@example.test", expires_at: FUTURE(), connected_by: "u1" }],
    });
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    await expect(getValidToken("u1")).resolves.toEqual({ accessToken: ACCESS, userEmail: "a@example.test" });
  });

  it("treats a tampered sealed token as unavailable, reports it, and leaves the row alone", async () => {
    const sealed = sealGraphToken(ACCESS);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64");
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          access_token: parts.join("."),
          refresh_token: sealGraphToken(REFRESH),
          user_email: "a@example.test",
          expires_at: FUTURE(),
          connected_by: "u1",
        },
      ],
    });
    await expect(getValidToken("u1")).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "security.graph_token_decrypt_failed",
      "u1",
      "system",
      expect.objectContaining({ field: "access_token" }),
    );
  });

  it("refreshes an expired legacy row with the opened refresh token and stores the result sealed", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ access_token: "old-access", refresh_token: REFRESH, user_email: "a@example.test", expires_at: PAST(), connected_by: "u1" }],
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
      text: async () => "",
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    const res = await getValidToken("u1");
    expect(res?.accessToken).toBe("new-access");
    // The refresh grant was sent the OPENED refresh token.
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(encodeURIComponent(REFRESH).replace(/%20/g, "+"));
    expect(allParams()).not.toContain("new-access");
    expect(allParams()).not.toContain("new-refresh");
    const encrypted = mockTrack.mock.calls.filter((c) => c[0] === "security.graph_token_encrypted");
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0][3]).toMatchObject({ source: "refresh_write" });
  });
});
