/**
 * Refresh-token rotation tests.
 *
 * Covers:
 *   - Happy path: old token revoked, new token issued
 *   - Re-use of revoked token revokes entire family + emits reuse_detected
 *   - Invalid/not-found refresh token fails cleanly
 *   - Expired token fails cleanly
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

import {
  issueRefreshToken,
  rotateRefreshToken,
  getRefreshToken,
  revokeFamilyTokens,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/crypto/refresh-tokens";

const origEnv = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...origEnv, NODE_ENV: "test", INSTINCT_JWT_SECRET: "test-secret-32-chars-exactly!!x" };
});
afterAll(() => {
  process.env = origEnv;
});

// Helper: build a mock refresh token row
function makeRow(overrides: Partial<{
  id: string;
  user_id: string;
  family_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  used_at: string | null;
}> = {}) {
  const future = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  return {
    id: "token-id-1",
    user_id: "user-1",
    family_id: "family-1",
    issued_at: new Date().toISOString(),
    expires_at: future,
    revoked_at: null,
    used_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("Refresh token rotation — happy path", () => {
  it("marks old token used and issues a new one in the same family", async () => {
    const row = makeRow();

    // getRefreshToken query
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })  // SELECT for getRefreshToken
      .mockResolvedValueOnce({ rows: [] })      // UPDATE used_at
      .mockResolvedValueOnce({ rows: [] });     // INSERT new token

    const result = await rotateRefreshToken("token-id-1");

    expect(result.userId).toBe("user-1");
    expect(result.familyId).toBe("family-1");
    expect(typeof result.tokenId).toBe("string");
    expect(result.tokenId).not.toBe("token-id-1"); // new token

    // UPDATE used_at was called
    const updateCall = mockQuery.mock.calls.find((c: any) =>
      typeof c[0] === "string" && c[0].includes("SET used_at"),
    );
    expect(updateCall).toBeDefined();
  });

  it("emits system.refresh_token_rotated", async () => {
    const row = makeRow();
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await rotateRefreshToken("token-id-1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.refresh_token_rotated",
      "user-1",
      "system",
      expect.objectContaining({ user_id: "user-1", family_id: "family-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Re-use detection
// ---------------------------------------------------------------------------
describe("Refresh token re-use detection", () => {
  it("throws refresh_token_reused when token was already used", async () => {
    const row = makeRow({ used_at: new Date().toISOString() }); // already used
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })  // getRefreshToken
      .mockResolvedValueOnce({ rows: [] });    // revokeFamilyTokens UPDATE

    await expect(rotateRefreshToken("token-id-1")).rejects.toThrow("refresh_token_reused");
  });

  it("revokes the entire family on re-use", async () => {
    const row = makeRow({ used_at: new Date().toISOString() });
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    try {
      await rotateRefreshToken("token-id-1");
    } catch {
      // expected
    }

    const revokeCall = mockQuery.mock.calls.find((c: any) =>
      typeof c[0] === "string" && c[0].includes("SET revoked_at"),
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall![1]).toContain("family-1");
  });

  it("emits system.refresh_token_reuse_detected", async () => {
    const row = makeRow({ used_at: new Date().toISOString() });
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    try {
      await rotateRefreshToken("token-id-1");
    } catch {
      // expected
    }

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.refresh_token_reuse_detected",
      "user-1",
      "system",
      expect.objectContaining({ user_id: "user-1", family_id: "family-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid / not found
// ---------------------------------------------------------------------------
describe("Invalid refresh token", () => {
  it("throws refresh_token_not_found for unknown token", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(rotateRefreshToken("nonexistent")).rejects.toThrow("refresh_token_not_found");
  });

  it("throws refresh_token_expired for an expired token", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const row = makeRow({ expires_at: past });
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    await expect(rotateRefreshToken("token-id-1")).rejects.toThrow("refresh_token_expired");
  });

  it("throws refresh_token_revoked for an explicitly revoked token", async () => {
    const row = makeRow({ revoked_at: new Date().toISOString() });
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    await expect(rotateRefreshToken("token-id-1")).rejects.toThrow("refresh_token_revoked");
  });
});

// ---------------------------------------------------------------------------
// issueRefreshToken
// ---------------------------------------------------------------------------
describe("issueRefreshToken", () => {
  it("inserts a new token and returns tokenId + familyId", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await issueRefreshToken("user-2");
    expect(typeof result.tokenId).toBe("string");
    expect(typeof result.familyId).toBe("string");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO instinct_refresh_tokens"),
      expect.arrayContaining([result.tokenId, "user-2", result.familyId]),
    );
  });

  it("uses provided familyId when continuing a rotation chain", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await issueRefreshToken("user-3", "existing-family-id");
    expect(result.familyId).toBe("existing-family-id");
  });
});

// ---------------------------------------------------------------------------
// revokeFamilyTokens
// ---------------------------------------------------------------------------
describe("revokeFamilyTokens", () => {
  it("issues UPDATE with the family_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await revokeFamilyTokens("fam-x");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET revoked_at"),
      ["fam-x"],
    );
  });
});
